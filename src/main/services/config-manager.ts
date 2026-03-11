import type { AppConfig, LLMConfig, RAGConfig, ZoteroConfig } from '../../../backend/types/config.js';
import { DEFAULT_CONFIG } from '../../../backend/types/config.js';
import { secureStorage, SENSITIVE_KEYS } from './secure-storage.js';
import os from 'os';
import path from 'path';

// Minimal interface for electron-store (dynamically imported ES module)
interface ElectronStoreInstance {
  get<K extends keyof AppConfig>(key: K): AppConfig[K];
  set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void;
  set(key: string, value: unknown): void;
  clear(): void;
  readonly path: string;
  readonly store: AppConfig;
}

export class ConfigManager {
  private _store: ElectronStoreInstance | null = null;
  private initialized: boolean = false;

  private getStore(): ElectronStoreInstance {
    if (!this._store) {
      throw new Error('ConfigManager not initialized. Call init() first.');
    }
    return this._store;
  }

  async init() {
    if (this.initialized) return;

    // Dynamic import pour electron-store (ES module)
    const { default: Store } = await import('electron-store');

    this._store = new Store<AppConfig>({
      defaults: DEFAULT_CONFIG,
      name: 'cliodeck-config',
      projectName: 'cliodeck',
    }) as unknown as ElectronStoreInstance;

    // Initialize secure storage for API keys
    await secureStorage.init();

    // Migrate any plaintext API keys from the main config to secure storage
    this.migrateAPIKeysToSecureStorage();

    this.initialized = true;
    console.log('✅ ConfigManager initialized');
    console.log(`   Config path: ${this._store.path}`);
  }

  /**
   * One-time migration: move plaintext API keys from the main config store
   * into the secure (encrypted) store, then clear them from the main config.
   */
  private migrateAPIKeysToSecureStorage(): void {
    const store = this.getStore();
    let migrated = false;

    // Check llm.claudeAPIKey
    const llmConfig = store.get('llm');
    if (llmConfig?.claudeAPIKey) {
      secureStorage.setKey('llm.claudeAPIKey', llmConfig.claudeAPIKey);
      const sanitized = { ...llmConfig };
      delete sanitized.claudeAPIKey;
      store.set('llm', sanitized);
      migrated = true;
      console.log('🔒 [Migration] Migrated llm.claudeAPIKey to secure storage');
    }

    // Check llm.openaiAPIKey
    if (llmConfig?.openaiAPIKey) {
      secureStorage.setKey('llm.openaiAPIKey', llmConfig.openaiAPIKey);
      const current = store.get('llm');
      const sanitized = { ...current };
      delete sanitized.openaiAPIKey;
      store.set('llm', sanitized);
      migrated = true;
      console.log('🔒 [Migration] Migrated llm.openaiAPIKey to secure storage');
    }

    // Check zotero.apiKey
    const zoteroConfig = store.get('zotero');
    if (zoteroConfig?.apiKey) {
      secureStorage.setKey('zotero.apiKey', zoteroConfig.apiKey);
      const sanitized = { ...zoteroConfig };
      delete sanitized.apiKey;
      store.set('zotero', sanitized);
      migrated = true;
      console.log('🔒 [Migration] Migrated zotero.apiKey to secure storage');
    }

    if (migrated) {
      console.log('🔒 [Migration] API key migration complete');
    } else {
      console.log('🔒 [Migration] No plaintext API keys found in main config (already migrated or none set)');
    }
  }

  /**
   * Convertit un chemin absolu en chemin relatif à $HOME (~)
   * Exemple: /home/user/projects/foo → ~/projects/foo
   */
  private toHomeRelativePath(absolutePath: string): string {
    const homeDir = os.homedir();

    if (absolutePath.startsWith(homeDir)) {
      return absolutePath.replace(homeDir, '~');
    }

    // Chemin hors de $HOME, garder absolu
    return absolutePath;
  }

  /**
   * Convertit un chemin relatif (~) en chemin absolu
   * Exemple: ~/projects/foo → /home/user/projects/foo
   * Gère aussi les chemins déjà absolus (rétrocompatibilité)
   */
  private toAbsolutePath(pathString: string): string {
    if (pathString.startsWith('~')) {
      return path.join(os.homedir(), pathString.slice(1));
    }

    // Déjà absolu, retourner tel quel
    return pathString;
  }

  // Getter générique
  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.getStore().get(key);
  }

  // Setter générique
  set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    this.getStore().set(key, value);
    console.log(`✅ Config updated: ${key}`);
  }

  // ─── Secure API Key Access ────────────────────────────────────────────

  /**
   * Read an API key from secure storage.
   * @param keyName - dot-path such as 'llm.claudeAPIKey', 'llm.openaiAPIKey', 'zotero.apiKey'
   */
  getAPIKey(keyName: string): string {
    return secureStorage.getKey(keyName);
  }

  /**
   * Write an API key to secure storage.
   * @param keyName - dot-path such as 'llm.claudeAPIKey', 'llm.openaiAPIKey', 'zotero.apiKey'
   * @param value   - the plaintext key value (will be encrypted at rest)
   */
  setAPIKey(keyName: string, value: string): void {
    secureStorage.setKey(keyName, value);
    console.log(`🔒 API key updated via secure storage: ${keyName}`);
  }

  // ─── LLM Config ──────────────────────────────────────────────────────

  /**
   * Get the full LLM config, enriched with API keys from secure storage.
   * This ensures that callers (e.g., pdf-service, chat-handlers) receive
   * a complete LLMConfig object including the API keys.
   */
  getLLMConfig(): LLMConfig {
    const config = this.getStore().get('llm');
    // Inject API keys from secure storage so downstream consumers see them
    const claudeAPIKey = secureStorage.getKey('llm.claudeAPIKey');
    const openaiAPIKey = secureStorage.getKey('llm.openaiAPIKey');
    return {
      ...config,
      ...(claudeAPIKey ? { claudeAPIKey } : {}),
      ...(openaiAPIKey ? { openaiAPIKey } : {}),
    };
  }

  setLLMConfig(config: Partial<LLMConfig>): void {
    // Extract API keys and route them to secure storage
    const { claudeAPIKey, openaiAPIKey, ...rest } = config;

    if (claudeAPIKey !== undefined) {
      secureStorage.setKey('llm.claudeAPIKey', claudeAPIKey);
    }
    if (openaiAPIKey !== undefined) {
      secureStorage.setKey('llm.openaiAPIKey', openaiAPIKey);
    }

    // Only write non-sensitive fields to the main config store
    const current = this.getStore().get('llm');
    // Also strip any API keys that might already be in the current config
    const { claudeAPIKey: _c, openaiAPIKey: _o, ...currentClean } = current;
    this.getStore().set('llm', { ...currentClean, ...rest });
    console.log('✅ LLM config updated');
  }

  // ─── RAG Config ──────────────────────────────────────────────────────

  getRAGConfig(): RAGConfig {
    return this.getStore().get('rag');
  }

  setRAGConfig(config: Partial<RAGConfig>): void {
    const current = this.getRAGConfig();
    this.getStore().set('rag', { ...current, ...config });
    console.log('✅ RAG config updated');
  }

  // ─── Zotero Config ───────────────────────────────────────────────────

  /**
   * Get the full Zotero config, enriched with the API key from secure storage.
   */
  getZoteroConfig(): ZoteroConfig | undefined {
    const config = this.getStore().get('zotero');
    if (!config) return config;
    const apiKey = secureStorage.getKey('zotero.apiKey');
    return {
      ...config,
      ...(apiKey ? { apiKey } : {}),
    };
  }

  /**
   * Set the Zotero config, routing the apiKey to secure storage.
   */
  setZoteroConfig(config: ZoteroConfig): void {
    const { apiKey, ...rest } = config;
    if (apiKey !== undefined) {
      secureStorage.setKey('zotero.apiKey', apiKey);
    }
    // Store the non-sensitive portion
    this.getStore().set('zotero', rest as AppConfig['zotero']);
    console.log('✅ Zotero config updated');
  }

  // ─── Recent Projects ─────────────────────────────────────────────────

  getRecentProjects(): string[] {
    const recentPaths = this.getStore().get('recentProjects');

    // Convertir tous les chemins en absolu (gère ~ et absolus)
    return recentPaths.map((p: string) => this.toAbsolutePath(p));
  }

  addRecentProject(projectPath: string): void {
    const recent = this.getRecentProjects();

    // Convertir en chemin relatif à $HOME
    const homeRelativePath = this.toHomeRelativePath(projectPath);

    // Supprimer les doublons (comparer les chemins absolus)
    const filtered = recent.filter((p: string) => {
      const absP = this.toAbsolutePath(p);
      return absP !== projectPath;
    });

    const updated = [homeRelativePath, ...filtered].slice(0, 10);
    this.getStore().set('recentProjects', updated);
    console.log(`✅ Added recent project: ${homeRelativePath} (from ${projectPath})`);
  }

  removeRecentProject(projectPath: string): void {
    // Récupérer les valeurs brutes (non converties)
    const recentPaths = this.getStore().get('recentProjects');

    // Filtrer en comparant les chemins absolus
    const filtered = recentPaths.filter((p: string) => {
      const absP = this.toAbsolutePath(p);
      return absP !== projectPath;
    });

    this.getStore().set('recentProjects', filtered);
    console.log(`✅ Removed recent project: ${projectPath}`);
  }

  // Reset à la config par défaut
  reset(): void {
    this.getStore().clear();
    // Also clear all sensitive keys from secure storage
    for (const key of SENSITIVE_KEYS) {
      secureStorage.deleteKey(key);
    }
    console.log('✅ Config reset to defaults (including secure storage)');
  }

  // Obtenir toute la config
  getAll(): AppConfig {
    return this.getStore().store;
  }

  /**
   * Get all config with API keys included (for internal main-process use only).
   * This should NOT be sent directly to the renderer without redaction.
   */
  getAllWithSecrets(): AppConfig {
    const config = { ...this.getStore().store };

    // Inject LLM API keys
    const claudeAPIKey = secureStorage.getKey('llm.claudeAPIKey');
    const openaiAPIKey = secureStorage.getKey('llm.openaiAPIKey');
    if (config.llm) {
      config.llm = {
        ...config.llm,
        ...(claudeAPIKey ? { claudeAPIKey } : {}),
        ...(openaiAPIKey ? { openaiAPIKey } : {}),
      };
    }

    // Inject Zotero API key
    const zoteroApiKey = secureStorage.getKey('zotero.apiKey');
    if (config.zotero && zoteroApiKey) {
      config.zotero = {
        ...config.zotero,
        apiKey: zoteroApiKey,
      };
    }

    return config;
  }
}

// Instance singleton (nécessite init() avant utilisation)
export const configManager = new ConfigManager();
