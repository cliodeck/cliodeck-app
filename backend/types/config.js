export const DEFAULT_CONFIG = {
    llm: {
        backend: 'ollama',
        ollamaURL: 'http://localhost:11434',
        ollamaEmbeddingModel: 'nomic-embed-text',
        ollamaChatModel: 'gemma2:2b',
    },
    rag: {
        topK: 10,
        similarityThreshold: 0.2,
        chunkingConfig: 'cpuOptimized',
    },
    editor: {
        fontSize: 14,
        theme: 'dark',
        wordWrap: true,
        showMinimap: true,
    },
    recentProjects: [],
};
