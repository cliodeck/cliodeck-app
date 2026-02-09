export const DEFAULT_CONFIG = {
    llm: {
        backend: 'ollama',
        ollamaURL: 'http://127.0.0.1:11434',
        ollamaEmbeddingModel: 'nomic-embed-text',
        ollamaChatModel: 'gemma2:2b',
        embeddingStrategy: 'nomic-fallback', // Default: nomic with fallback to mxbai
        // Embedded LLM: auto mode (try Ollama first, fallback to embedded)
        generationProvider: 'auto',
        embeddedModelId: 'qwen2.5-0.5b',
    },
    rag: {
        topK: 10,
        similarityThreshold: 0.12, // Réduit pour recherche multilingue (FR query → EN docs)
        chunkingConfig: 'cpuOptimized',
        summarizer: {
            enabled: true,
            method: 'extractive',
            maxLength: 750, // ~750 mots = 2-3 paragraphes
            llmModel: 'gemma2:2b', // Pour abstractif si activé
        },
        // Enhanced search features (enabled by default)
        useAdaptiveChunking: true, // Structure-aware chunking
        useHNSWIndex: true, // Fast approximate search
        useHybridSearch: true, // Dense + sparse fusion
        // Exploration graph
        explorationSimilarityThreshold: 0.7, // Seuil de similarité pour le graphe d'exploration
        // System prompt configuration (default: French)
        systemPromptLanguage: 'fr',
        useCustomSystemPrompt: false,
        // Custom chunking (Phase 1) - disabled by default, use preset
        customChunkingEnabled: false,
        customMaxChunkSize: 500,
        customMinChunkSize: 100,
        customOverlapSize: 75,
        // Quality filtering (Phase 1) - enabled by default
        enableQualityFiltering: true,
        minChunkEntropy: 0.3,
        minUniqueWordRatio: 0.4,
        // Preprocessing (Phase 2) - enabled by default
        enablePreprocessing: true,
        enableOCRCleanup: true,
        enableHeaderFooterRemoval: true,
        // Deduplication (Phase 2) - enabled by default
        enableDeduplication: true,
        enableSimilarityDedup: false, // Disabled by default (slower)
        dedupSimilarityThreshold: 0.85,
        // Semantic chunking (Phase 3) - disabled by default (CPU intensive)
        useSemanticChunking: false,
        semanticSimilarityThreshold: 0.7,
        semanticWindowSize: 3,
    },
    editor: {
        fontSize: 14,
        theme: 'dark',
        wordWrap: true,
        showMinimap: true,
    },
    recentProjects: [],
    language: 'fr',
};
