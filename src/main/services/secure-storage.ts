import { safeStorage } from 'electron';

/**
 * SecureStorage - Encrypts and stores sensitive data (API keys) using Electron's safeStorage API.
 *
 * Uses a separate electron-store instance ('cliodeck-secrets') to keep encrypted data
 * isolated from the main configuration store.
 *
 * When safeStorage encryption is not available (e.g., on some Linux environments without
 * a keyring), falls back to plain text storage with a warning.
 */

// Known API key names that should be routed through secure storage.
// The dot-path format matches how they appear in AppConfig (e.g., 'llm.claudeAPIKey').
export const SENSITIVE_KEYS = [
  'llm.claudeAPIKey',
  'llm.openaiAPIKey',
  'llm.mistralAPIKey',
  'llm.geminiAPIKey',
  'zotero.apiKey',
  'mcp.europeana.apiKey',
] as const;

export type SensitiveKeyName = (typeof SENSITIVE_KEYS)[number];

/**
 * Check whether a given config key path corresponds to a sensitive API key.
 */
export function isSensitiveKey(keyPath: string): keyPath is SensitiveKeyName {
  return (SENSITIVE_KEYS as readonly string[]).includes(keyPath);
}

/**
 * Mask an API key for display in the renderer (show first 4 and last 4 chars).
 * The renderer only ever receives masked values; a value equal to the mask of
 * the stored key means "unchanged" on save.
 */
export function maskAPIKey(key: string | undefined): string {
  if (!key) return '';
  if (key.length <= 12) return '****';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

// Minimal interface for the electron-store instance used for secrets
interface SecretStoreInstance {
  get(key: string): string | undefined;
  set(key: string, value: string | undefined): void;
  delete(key: string): void;
  has(key: string): boolean;
  readonly store: Record<string, string | undefined>;
}

/**
 * Une valeur stockée ressemble-t-elle à un chiffré de `safeStorage` ?
 * Chromium préfixe ses chiffrés par `v10`/`v11` (macOS, Linux) ; DPAPI
 * (Windows) par un en-tête `01 00 00 00 D0 8C 9D DF`. Un tel blob que l'on
 * n'arrive pas à déchiffrer ne doit JAMAIS être renvoyé comme s'il était la
 * clé : il partirait en en-tête d'autorisation vers un fournisseur.
 */
function looksLikeCiphertext(raw: string): boolean {
  if (!/^[A-Za-z0-9+/]+=*$/.test(raw)) return false;
  const buf = Buffer.from(raw, 'base64');
  if (buf.length < 4) return false;
  const head = buf.subarray(0, 3).toString('latin1');
  if (head === 'v10' || head === 'v11') return true;
  return buf.readUInt32LE(0) === 1 && buf[4] === 0xd0 && buf[5] === 0x8c;
}

export class SecureStorage {
  private _store: SecretStoreInstance | null = null;
  private initialized = false;
  private encryptionAvailable = false;
  /**
   * Clés dont le chiffré ne se déchiffre pas ici — autre identité de
   * l'application (build empaqueté vs `npx electron .`, chacun sa propre
   * entrée « Safe Storage » dans le trousseau), ou entrée recréée. Traitées
   * comme absentes, listées pour que Réglages → Sécurité puisse le dire.
   */
  private readonly unreadable = new Set<string>();
  /** Un avertissement par clé et par lancement : `getLLMConfig` relit toutes les clés à chaque lecture de la configuration. */
  private readonly warned = new Set<string>();

  async init(): Promise<void> {
    if (this.initialized) return;

    // Check encryption availability
    this.encryptionAvailable = safeStorage.isEncryptionAvailable();

    if (!this.encryptionAvailable) {
      console.warn(
        '⚠️  [SecureStorage] OS-level encryption is NOT available. ' +
          'API keys will be stored in plain text. ' +
          'Consider installing a system keyring (e.g., gnome-keyring on Linux).',
      );
    } else {
      console.log('🔒 [SecureStorage] OS-level encryption is available');
    }

    // Dynamic import for electron-store (ES module)
    const { default: Store } = await import('electron-store');

    this._store = new Store({
      name: 'cliodeck-secrets',
      projectName: 'cliodeck',
      // No defaults - secrets start empty
    }) as unknown as SecretStoreInstance;

    this.initialized = true;
    console.log('🔒 [SecureStorage] Initialized');
  }

  private getStore(): SecretStoreInstance {
    if (!this._store) {
      throw new Error('SecureStorage not initialized. Call init() first.');
    }
    return this._store;
  }

  /**
   * Store a sensitive value. If encryption is available, the value is encrypted
   * before being persisted. Otherwise, it is stored as plain text.
   */
  setKey(name: string, value: string): void {
    const store = this.getStore();
    this.unreadable.delete(name);
    this.warned.delete(name);

    if (!value) {
      // Treat empty/null/undefined as deletion
      store.delete(name);
      console.log(`🔒 [SecureStorage] Deleted key: ${name}`);
      return;
    }

    if (this.encryptionAvailable) {
      // Encrypt the value and store as base64-encoded string
      const encrypted = safeStorage.encryptString(value);
      store.set(name, encrypted.toString('base64'));
    } else {
      // Fallback: store in plain text
      store.set(name, value);
    }

    console.log(
      `🔒 [SecureStorage] Stored key: ${name} (encrypted: ${this.encryptionAvailable})`,
    );
  }

  /**
   * Retrieve a sensitive value. Automatically decrypts if encryption was used.
   * Returns an empty string if the key does not exist.
   */
  getKey(name: string): string {
    const store = this.getStore();
    const raw = store.get(name);

    if (raw === undefined || raw === null) {
      return '';
    }

    if (this.encryptionAvailable) {
      try {
        const buffer = Buffer.from(raw, 'base64');
        return safeStorage.decryptString(buffer);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (looksLikeCiphertext(raw)) {
          // Chiffré par une autre clé de trousseau : illisible ici, et
          // surtout pas une clé d'API. Constaté le 2026-09-08 : une valeur
          // de 21 octets renvoyée telle quelle, avec une trace de pile à
          // chaque lecture de la configuration.
          if (!this.warned.has(name)) {
            this.warned.add(name);
            console.warn(
              `⚠️  [SecureStorage] La clé "${name}" est chiffrée avec une autre clé de trousseau ` +
                '(autre identité de l’application, ou entrée « Safe Storage » recréée) : ' +
                'illisible ici, traitée comme absente. Ressaisissez-la, ou supprimez-la dans ' +
                `Réglages → Sécurité. (${detail})`,
            );
          }
          this.unreadable.add(name);
          return '';
        }
        // Valeur en clair, stockée avant que le chiffrement soit disponible :
        // utilisée telle quelle, et rechiffrée maintenant pour ne plus y revenir.
        if (!this.warned.has(name)) {
          this.warned.add(name);
          console.warn(
            `⚠️  [SecureStorage] La clé "${name}" était stockée en clair : rechiffrée avec le trousseau.`,
          );
        }
        try {
          store.set(name, safeStorage.encryptString(raw).toString('base64'));
        } catch {
          // Le rechiffrement est un bonus ; la lecture reste valide.
        }
        return raw;
      }
    }

    // No encryption - return raw value
    return raw;
  }

  /** Clés présentes mais indéchiffrables ici (voir `unreadable`). */
  unreadableKeys(): string[] {
    return [...this.unreadable];
  }

  /**
   * Remove a sensitive value from the store.
   */
  deleteKey(name: string): void {
    const store = this.getStore();
    this.unreadable.delete(name);
    this.warned.delete(name);
    store.delete(name);
    console.log(`🔒 [SecureStorage] Deleted key: ${name}`);
  }

  /**
   * Check whether a key exists in the secure store (regardless of its value).
   */
  hasKey(name: string): boolean {
    const store = this.getStore();
    return store.has(name);
  }

  /**
   * Returns whether OS-level encryption is being used.
   */
  isEncrypted(): boolean {
    return this.encryptionAvailable;
  }

  /**
   * Revoke all stored keys — wipes every entry from the secrets store.
   * Returns the number of keys deleted.
   */
  revokeAll(): number {
    const store = this.getStore();
    const keys = Object.keys(store.store);
    for (const key of keys) {
      store.delete(key);
    }
    console.log(`🔒 [SecureStorage] Revoked ${keys.length} key(s)`);
    return keys.length;
  }
}

// Singleton instance (requires init() before use)
export const secureStorage = new SecureStorage();
