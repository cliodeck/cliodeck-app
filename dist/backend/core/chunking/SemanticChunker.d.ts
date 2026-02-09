/**
 * SemanticChunker - Creates chunks based on semantic boundaries
 *
 * Algorithm:
 * 1. Split document into sentences
 * 2. Create sliding windows of N sentences
 * 3. Generate embeddings for each window
 * 4. Calculate similarity between consecutive windows
 * 5. Detect boundaries where similarity drops significantly
 * 6. Group sentences between boundaries into chunks
 */
import type { DocumentPage, DocumentChunk } from '../../types/pdf-document.js';
import { EmbeddingCache } from './EmbeddingCache.js';
export interface SemanticBoundary {
    position: number;
    similarityDrop: number;
    confidence: number;
}
export interface SemanticChunkingConfig {
    similarityThreshold: number;
    windowSize: number;
    minChunkSize: number;
    maxChunkSize: number;
    overlapSentences: number;
}
type EmbeddingFunction = (text: string) => Promise<Float32Array>;
export declare class SemanticChunker {
    private config;
    private cache;
    private generateEmbedding;
    constructor(generateEmbedding: EmbeddingFunction, config?: Partial<SemanticChunkingConfig>, cache?: EmbeddingCache);
    /**
     * Create chunks based on semantic boundaries
     */
    createChunks(pages: DocumentPage[], documentId: string, documentMeta?: {
        title?: string;
    }): Promise<DocumentChunk[]>;
    /**
     * Detect semantic boundaries between sentences
     */
    detectBoundaries(sentences: string[]): Promise<SemanticBoundary[]>;
    /**
     * Create chunks from detected boundaries
     */
    private createChunksFromBoundaries;
    /**
     * Split text into sentences
     */
    private splitIntoSentences;
    /**
     * Generate embeddings for windows with caching
     */
    private generateWindowEmbeddings;
    /**
     * Calculate cosine similarity between two embeddings
     */
    private cosineSimilarity;
    /**
     * Filter boundaries that are too close together
     */
    private filterCloseBoundaries;
    /**
     * Split a chunk that's too large
     */
    private splitLargeChunk;
    /**
     * Build page mapping for position tracking
     */
    private buildPageMapping;
    /**
     * Find position of content in original document
     */
    private findPosition;
    /**
     * Clean text for storage
     */
    private cleanText;
    /**
     * Get cache for external use
     */
    getCache(): EmbeddingCache;
}
export {};
