export interface LLMConfig {
    backend: 'ollama' | 'claude' | 'openai';
    ollamaURL: string;
    ollamaEmbeddingModel: string;
    ollamaChatModel: string;
    claudeAPIKey?: string;
    claudeModel?: string;
    openaiAPIKey?: string;
    openaiModel?: string;
    /** Embedding model strategy: 'nomic-fallback' (nomic with mxbai fallback), 'mxbai-only', 'custom' */
    embeddingStrategy?: 'nomic-fallback' | 'mxbai-only' | 'custom';
    /** Provider for text generation: 'ollama', 'embedded', or 'auto' (try ollama first, then embedded) */
    generationProvider?: 'ollama' | 'embedded' | 'auto';
    /** ID of the embedded model (e.g., 'qwen2.5-0.5b') */
    embeddedModelId?: string;
    /** Path to the downloaded GGUF model file */
    embeddedModelPath?: string;
}
export interface SummarizerConfig {
    enabled: boolean;
    method: 'extractive' | 'abstractive';
    maxLength: number;
    llmModel?: string;
}
export interface RAGConfig {
    topK: number;
    similarityThreshold: number;
    chunkingConfig: 'cpuOptimized' | 'standard' | 'large';
    summarizer?: SummarizerConfig;
    summaryGeneration?: 'extractive' | 'abstractive' | 'disabled';
    summaryMaxLength?: number;
    useGraphContext?: boolean;
    graphSimilarityThreshold?: number;
    additionalGraphDocs?: number;
    explorationSimilarityThreshold?: number;
    includeSummaries?: boolean;
    enableTopicModeling?: boolean;
    useAdaptiveChunking?: boolean;
    useHNSWIndex?: boolean;
    useHybridSearch?: boolean;
    systemPromptLanguage?: 'fr' | 'en';
    customSystemPrompt?: string;
    useCustomSystemPrompt?: boolean;
    numCtx?: number;
    customChunkingEnabled?: boolean;
    customMaxChunkSize?: number;
    customMinChunkSize?: number;
    customOverlapSize?: number;
    enableQualityFiltering?: boolean;
    minChunkEntropy?: number;
    minUniqueWordRatio?: number;
    enablePreprocessing?: boolean;
    enableOCRCleanup?: boolean;
    enableHeaderFooterRemoval?: boolean;
    enableDeduplication?: boolean;
    enableSimilarityDedup?: boolean;
    dedupSimilarityThreshold?: number;
    useSemanticChunking?: boolean;
    semanticSimilarityThreshold?: number;
    semanticWindowSize?: number;
    enableContextCompression?: boolean;
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
    language?: 'fr' | 'en' | 'de';
}
export declare const DEFAULT_CONFIG: AppConfig;
