import type { AppConfig, LLMConfig, RAGConfig } from '../../../backend/types/config.js';
export declare class ConfigManager {
    private store;
    private initialized;
    init(): Promise<void>;
    /**
     * Convertit un chemin absolu en chemin relatif à $HOME (~)
     * Exemple: /home/user/projects/foo → ~/projects/foo
     */
    private toHomeRelativePath;
    /**
     * Convertit un chemin relatif (~) en chemin absolu
     * Exemple: ~/projects/foo → /home/user/projects/foo
     * Gère aussi les chemins déjà absolus (rétrocompatibilité)
     */
    private toAbsolutePath;
    get<K extends keyof AppConfig>(key: K): AppConfig[K];
    set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void;
    getLLMConfig(): LLMConfig;
    setLLMConfig(config: Partial<LLMConfig>): void;
    getRAGConfig(): RAGConfig;
    setRAGConfig(config: Partial<RAGConfig>): void;
    getRecentProjects(): string[];
    addRecentProject(projectPath: string): void;
    removeRecentProject(projectPath: string): void;
    reset(): void;
    getAll(): AppConfig;
}
export declare const configManager: ConfigManager;
