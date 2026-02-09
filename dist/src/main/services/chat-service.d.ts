import { BrowserWindow } from 'electron';
interface EnrichedRAGOptions {
    context?: boolean;
    useGraphContext?: boolean;
    includeSummaries?: boolean;
    topK?: number;
    additionalGraphDocs?: number;
    window?: BrowserWindow;
    sourceType?: 'secondary' | 'primary' | 'both';
    documentIds?: string[];
    collectionKeys?: string[];
    provider?: 'ollama' | 'embedded' | 'auto';
    model?: string;
    timeout?: number;
    numCtx?: number;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    repeat_penalty?: number;
    systemPromptLanguage?: 'fr' | 'en';
    useCustomSystemPrompt?: boolean;
    customSystemPrompt?: string;
    enableContextCompression?: boolean;
    modeId?: string;
    noSystemPrompt?: boolean;
}
export interface RAGExplanationContext {
    search: {
        query: string;
        totalResults: number;
        searchDurationMs: number;
        cacheHit: boolean;
        sourceType: 'primary' | 'secondary' | 'both';
        documents: Array<{
            title: string;
            similarity: number;
            sourceType: 'primary' | 'secondary';
            chunkCount: number;
        }>;
        boosting?: {
            exactMatchCount: number;
            keywords: string[];
        };
    };
    compression?: {
        enabled: boolean;
        originalChunks: number;
        finalChunks: number;
        originalSize: number;
        finalSize: number;
        reductionPercent: number;
        strategy?: string;
    };
    graph?: {
        enabled: boolean;
        relatedDocsFound: number;
        documentTitles: string[];
    };
    llm: {
        provider: string;
        model: string;
        contextWindow: number;
        temperature: number;
        promptSize: number;
    };
    timing: {
        searchMs: number;
        compressionMs?: number;
        generationMs: number;
        totalMs: number;
    };
}
declare class ChatService {
    private currentStream;
    private compressor;
    private ragCache;
    /**
     * Convertit les résultats de recherche en utilisant les résumés au lieu des chunks
     * Si les résumés ne sont pas disponibles, retourne les chunks originaux
     */
    private convertChunksToSummaries;
    /**
     * Récupère les documents liés via le graphe de connaissances
     */
    private getRelatedDocumentsFromGraph;
    sendMessage(message: string, options?: EnrichedRAGOptions): Promise<{
        response: string;
        ragUsed: boolean;
        sourcesCount: number;
        explanation?: RAGExplanationContext;
    }>;
    cancelCurrentStream(): void;
}
export declare const chatService: ChatService;
export {};
