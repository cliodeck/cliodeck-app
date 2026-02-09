import type { DocumentPage, DocumentChunk } from '../../types/pdf-document';
export interface ChunkingConfig {
    maxChunkSize: number;
    overlapSize: number;
    minChunkSize: number;
}
export declare const CHUNKING_CONFIGS: {
    cpuOptimized: ChunkingConfig;
    standard: ChunkingConfig;
    large: ChunkingConfig;
};
export interface ChunkingStatistics {
    totalChunks: number;
    averageWordCount: number;
    minWordCount: number;
    maxWordCount: number;
    totalWords: number;
}
export declare class DocumentChunker {
    private config;
    constructor(config?: ChunkingConfig);
    createChunks(pages: DocumentPage[], documentId: string, documentMeta?: {
        title?: string;
        abstract?: string;
    }): DocumentChunk[];
    /**
     * Découpe en respectant les paragraphes quand possible
     */
    createSemanticChunks(pages: DocumentPage[], documentId: string): DocumentChunk[];
    private findPageNumber;
    private cleanChunkText;
    getChunkingStats(chunks: DocumentChunk[]): ChunkingStatistics;
    static compareConfigs(pages: DocumentPage[], documentId: string): void;
}
