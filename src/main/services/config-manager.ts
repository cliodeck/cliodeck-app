// @ts-nocheck
import type { AppConfig, LLMConfig, RAGConfig } from '../../../backend/types/config.js';
import { DEFAULT_CONFIG } from '../../../backend/types/config.js';
import os from 'os';
import path from 'path';

export class ConfigManager {
  private store: any;
  private initialized: boolean = false;

  async init() {
    if (this.initialized) return;

    // Dynamic import pour electron-store (ES module)
    const { default: Store } = await import('electron-store');

    this.store = new Store<AppConfig>({
      defaults: DEFAULT_CONFIG,
      name: 'cliodeck-config',
      projectName: 'cliodeck',
    });

    this.initialized = true;
    console.log('✅ ConfigManager initialized');
    console.log(`   Config path: ${this.store.path}`);
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
    return this.store.get(key);
  }

  // Setter générique
  set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    this.store.set(key, value);
    console.log(`✅ Config updated: ${key}`);
  }

  // Méthodes spécifiques LLM
  getLLMConfig(): LLMConfig {
    return this.store.get('llm');
  }

  setLLMConfig(config: Partial<LLMConfig>): void {
    const current = this.getLLMConfig();
    this.store.set('llm', { ...current, ...config });
    console.log('✅ LLM config updated');
  }

  // Méthodes spécifiques RAG
  getRAGConfig(): RAGConfig {
    return this.store.get('rag');
  }

  setRAGConfig(config: Partial<RAGConfig>): void {
    const current = this.getRAGConfig();
    this.store.set('rag', { ...current, ...config });
    console.log('✅ RAG config updated');
  }

  // Gestion des projets récents
  getRecentProjects(): string[] {
    const recentPaths = this.store.get('recentProjects');

    // Convertir tous les chemins en absolu (gère ~ et absolus)
    return recentPaths.map((p) => this.toAbsolutePath(p));
  }

  addRecentProject(projectPath: string): void {
    const recent = this.getRecentProjects();

    // Convertir en chemin relatif à $HOME
    const homeRelativePath = this.toHomeRelativePath(projectPath);

    // Supprimer les doublons (comparer les chemins absolus)
    const filtered = recent.filter((p) => {
      const absP = this.toAbsolutePath(p);
      return absP !== projectPath;
    });

    const updated = [homeRelativePath, ...filtered].slice(0, 10);
    this.store.set('recentProjects', updated);
    console.log(`✅ Added recent project: ${homeRelativePath} (from ${projectPath})`);
  }

  removeRecentProject(projectPath: string): void {
    // Récupérer les valeurs brutes (non converties)
    const recentPaths = this.store.get('recentProjects');

    // Filtrer en comparant les chemins absolus
    const filtered = recentPaths.filter((p) => {
      const absP = this.toAbsolutePath(p);
      return absP !== projectPath;
    });

    this.store.set('recentProjects', filtered);
    console.log(`✅ Removed recent project: ${projectPath}`);
  }

  // Reset à la config par défaut
  reset(): void {
    this.store.clear();
    console.log('✅ Config reset to defaults');
  }

  // Obtenir toute la config
  getAll(): AppConfig {
    return this.store.store;
  }
}

// Instance singleton (nécessite init() avant utilisation)
export const configManager = new ConfigManager();
