import type { DocumentChunk } from '../../types/pdf-document';
/**
 * BM25 Index for keyword-based search
 *
 * BM25 is a probabilistic ranking function that scores documents based on
 * term frequency (TF) and inverse document frequency (IDF).
 *
 * Memory footprint: ~50-100 MB for 50k chunks
 * Search time: O(k) where k = number of query terms (very fast)
 *
 * Best for:
 * - Exact keyword matching
 * - Technical terms, proper nouns
 * - Multi-word phrases
 * - Queries with rare/specific words
 */
export declare class BM25Index {
    private tfidf;
    private chunkMap;
    private k1;
    private b;
    private idfCache;
    private avgDocLength;
    private isDirty;
    constructor();
    /**
     * Add a chunk to the index
     */
    addChunk(chunk: DocumentChunk): void;
    /**
     * Batch add chunks (more efficient)
     */
    addChunks(chunks: DocumentChunk[]): void;
    /**
     * Search for chunks matching query
     */
    search(query: string, k?: number, documentIds?: string[]): BM25Result[];
    /**
     * Update IDF cache and average doc length (called once when cache is dirty)
     */
    private updateCache;
    /**
     * Get average document length (from cache)
     */
    private getAverageDocLength;
    /**
     * Preprocess text for indexing/search
     */
    private preprocessText;
    /**
     * Clear the index
     */
    clear(): void;
    /**
     * Get index size
     */
    getSize(): number;
    /**
     * Get statistics
     */
    getStats(): {
        totalChunks: number;
        vocabularySize: number;
        averageDocLength: number;
    };
}
export interface BM25Result {
    chunk: DocumentChunk;
    score: number;
}
