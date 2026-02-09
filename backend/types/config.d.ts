export interface LLMConfig {
    backend: 'ollama' | 'claude' | 'openai';
    ollamaURL: string;
    ollamaEmbeddingModel: string;
    ollamaChatModel: string;
    claudeAPIKey?: string;
    claudeModel?: string;
    openaiAPIKey?: string;
    openaiModel?: string;
}
export interface RAGConfig {
    topK: number;
    similarityThreshold: number;
    chunkingConfig: 'cpuOptimized' | 'standard' | 'large';
}
export interface ZoteroConfig {
    userId?: string;
    groupId?: string;
    apiKey?: string;
}
export interface EditorConfig {
    fontSize: number;
    theme: 'light' | 'dark';
    wordWrap: boolean;
    showMinimap: boolean;
}
export interface AppConfig {
    llm: LLMConfig;
    rag: RAGConfig;
    zotero?: ZoteroConfig;
    editor: EditorConfig;
    recentProjects: string[];
}
export declare const DEFAULT_CONFIG: AppConfig;
