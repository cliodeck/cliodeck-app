import type { SearchResult } from '../../types/pdf-document';
export interface LLMModel {
    id: string;
    name: string;
    size: string;
    description: string;
    recommendedFor: string[];
}
/**
 * Known context window sizes for popular Ollama models.
 * Values are in tokens. Default Ollama is usually 2048 or 4096.
 * These are the maximum supported contexts - actual usage depends on available RAM.
 */
export declare const MODEL_CONTEXT_SIZES: Record<string, {
    maxContext: number;
    recommended: number;
    description: string;
}>;
/**
 * Get context size info for a model. Returns default values if model is unknown.
 */
export declare function getModelContextInfo(modelName: string): {
    maxContext: number;
    recommended: number;
    description: string;
};
/**
 * Classifies Ollama errors and provides user-friendly messages
 */
export interface ClassifiedError {
    type: 'context_overflow' | 'timeout' | 'connection' | 'model_not_found' | 'out_of_memory' | 'unknown';
    userMessage: string;
    technicalDetails: string;
    suggestion: string;
}
export interface ErrorContext {
    model?: string;
    promptLength?: number;
    sourceCount?: number;
    numCtx?: number;
}
export declare function classifyOllamaError(error: any, context?: ErrorContext): ClassifiedError;
export declare const GENERATION_PRESETS: {
    academic: {
        temperature: number;
        top_p: number;
        top_k: number;
        repeat_penalty: number;
        seed: number;
    };
    creative: {
        temperature: number;
        top_p: number;
        top_k: number;
        repeat_penalty: number;
    };
    deterministic: {
        temperature: number;
        seed: number;
    };
};
export declare class OllamaClient {
    private baseURL;
    embeddingModel: string;
    chatModel: string;
    embeddingStrategy: 'nomic-fallback' | 'mxbai-only' | 'custom';
    private readonly NOMIC_MAX_LENGTH;
    constructor(baseURL?: string, chatModel?: string, embeddingModel?: string, embeddingStrategy?: 'nomic-fallback' | 'mxbai-only' | 'custom');
    /**
     * Helper method to make HTTP GET requests using Node.js http module
     * More reliable than fetch in Electron main process
     */
    private httpGet;
    isAvailable(): Promise<boolean>;
    listAvailableModels(): Promise<LLMModel[]>;
    /**
     * Découpe un texte en chunks de taille maximale (sentence-aware)
     */
    private chunkText;
    /**
     * Moyenne plusieurs embeddings en un seul
     */
    private averageEmbeddings;
    /**
     * Génère un embedding pour un chunk de texte avec un modèle spécifique
     */
    private generateEmbeddingWithModel;
    /**
     * Génère un embedding pour un chunk de texte (avec fallback automatique)
     */
    private generateEmbeddingForChunk;
    /**
     * Génère un embedding pour un texte (avec chunking automatique si nécessaire)
     */
    generateEmbedding(text: string): Promise<Float32Array>;
    generateResponse(prompt: string, context: string[]): Promise<string>;
    generateResponseStream(prompt: string, context: string[], modelOverride?: string, timeoutOverride?: number, generationOptions?: Partial<typeof GENERATION_PRESETS.academic> & {
        num_ctx?: number;
    }, systemPrompt?: string): AsyncGenerator<string>;
    generateResponseStreamWithSources(prompt: string, sources: SearchResult[], projectContext?: string, modelOverride?: string, timeoutOverride?: number, generationOptions?: Partial<typeof GENERATION_PRESETS.academic> & {
        num_ctx?: number;
    }, systemPrompt?: string): AsyncGenerator<string>;
    private buildPrompt;
    private buildPromptWithSources;
    private formatSize;
    private inferRecommendations;
}
export declare const RECOMMENDED_EMBEDDING_MODELS: LLMModel[];
export declare const RECOMMENDED_CHAT_MODELS: LLMModel[];
