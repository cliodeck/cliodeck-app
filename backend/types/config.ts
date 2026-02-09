export interface LLMConfig {
  backend: 'ollama' | 'claude' | 'openai';
  ollamaURL: string;
  ollamaEmbeddingModel: string;
  ollamaChatModel: string;
  claudeAPIKey?: string;
  claudeModel?: string;
  openaiAPIKey?: string;
  openaiModel?: string;

  // Embedding strategy
  /** Embedding model strategy: 'nomic-fallback' (nomic with mxbai fallback), 'mxbai-only', 'custom' */
  embeddingStrategy?: 'nomic-fallback' | 'mxbai-only' | 'custom';

  // Embedded LLM configuration (Qwen2.5-0.5B or similar)
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
  maxLength: number; // En nombre de mots
  llmModel?: string; // Pour abstractif uniquement
}

export interface RAGConfig {
  topK: number;
  similarityThreshold: number;
  chunkingConfig: 'cpuOptimized' | 'standard' | 'large';
  summarizer?: SummarizerConfig; // Legacy, kept for backwards compatibility

  // Summary generation
  summaryGeneration?: 'extractive' | 'abstractive' | 'disabled';
  summaryMaxLength?: number;

  // Graph context
  useGraphContext?: boolean;
  graphSimilarityThreshold?: number;
  additionalGraphDocs?: number;

  // Exploration graph
  explorationSimilarityThreshold?: number; // Seuil pour les arêtes de similarité dans le graphe d'exploration

  // RAG enrichment
  includeSummaries?: boolean; // Use summaries in RAG instead of chunks

  // Topic modeling
  enableTopicModeling?: boolean;

  // Enhanced search features (Phase 1 improvements)
  useAdaptiveChunking?: boolean; // Use structure-aware chunking
  useHNSWIndex?: boolean; // Use HNSW for fast search
  useHybridSearch?: boolean; // Combine dense (HNSW) + sparse (BM25)

  // System prompt configuration (Phase 2.3)
  systemPromptLanguage?: 'fr' | 'en'; // Language of the default system prompt
  customSystemPrompt?: string; // Custom system prompt (optional)
  useCustomSystemPrompt?: boolean; // Use custom prompt instead of default

  // Context window size (for LLM generation)
  numCtx?: number; // Context window in tokens for Ollama

  // === Custom Chunking Configuration (Phase 1) ===
  customChunkingEnabled?: boolean; // Use custom parameters instead of preset
  customMaxChunkSize?: number; // 100-1500 words
  customMinChunkSize?: number; // 20-200 words
  customOverlapSize?: number; // 0-200 words

  // === Chunk Quality Filtering (Phase 1) ===
  enableQualityFiltering?: boolean; // Filter low-quality chunks
  minChunkEntropy?: number; // 0.0-1.0, minimum Shannon entropy
  minUniqueWordRatio?: number; // 0.0-1.0, minimum unique words ratio

  // === Text Preprocessing (Phase 2) ===
  enablePreprocessing?: boolean; // Enable text preprocessing pipeline
  enableOCRCleanup?: boolean; // Clean OCR artifacts
  enableHeaderFooterRemoval?: boolean; // Remove repeated headers/footers

  // === Deduplication (Phase 2) ===
  enableDeduplication?: boolean; // Enable chunk deduplication
  enableSimilarityDedup?: boolean; // Use similarity-based dedup (slower)
  dedupSimilarityThreshold?: number; // 0.7-0.95, similarity threshold

  // === Semantic Chunking (Phase 3) ===
  useSemanticChunking?: boolean; // Use embedding-based boundary detection
  semanticSimilarityThreshold?: number; // 0.5-0.9, boundary detection threshold
  semanticWindowSize?: number; // 2-5 sentences per window

  // === Context Compression ===
  enableContextCompression?: boolean; // Enable context compression before sending to LLM (default: true)
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

export const DEFAULT_CONFIG: AppConfig = {
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
