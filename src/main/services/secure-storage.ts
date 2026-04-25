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

// Minimal interface for the electron-store instance used for secrets
interface SecretStoreInstance {
  get(key: string): string | undefined;
  set(key: string, value: string | undefined): void;
  delete(key: string): void;
  has(key: string): boolean;
  readonly store: Record<string, string | undefined>;
}

export class SecureStorage {
  private _store: SecretStoreInstance | null = null;
  private initialized = false;
  private encryptionAvailable = false;

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
        // If decryption fails, the value might have been stored in plain text
        // before encryption became available (e.g., after a system upgrade).
        console.warn(
          `⚠️  [SecureStorage] Failed to decrypt key "${name}", returning raw value. ` +
            'This can happen if the key was stored before encryption was available.',
          error,
        );
        return raw;
      }
    }

    // No encryption - return raw value
    return raw;
  }

  /**
   * Remove a sensitive value from the store.
   */
  deleteKey(name: string): void {
    const store = this.getStore();
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
}

// Singleton instance (requires init() before use)
export const secureStorage = new SecureStorage();
