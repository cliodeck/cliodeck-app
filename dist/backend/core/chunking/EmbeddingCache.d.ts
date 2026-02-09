/**
 * EmbeddingCache - LRU cache for embeddings to avoid redundant API calls
 *
 * Used during semantic chunking to cache sentence embeddings
 */
export declare class EmbeddingCache {
    private cache;
    private accessOrder;
    private maxSize;
    private hits;
    private misses;
    constructor(maxSize?: number);
    /**
     * Get embedding from cache or compute it
     */
    getOrCompute(text: string, computeFn: (text: string) => Promise<Float32Array>): Promise<Float32Array>;
    /**
     * Get cached embedding if available
     */
    get(text: string): Float32Array | undefined;
    /**
     * Store embedding in cache
     */
    set(key: string, embedding: Float32Array): void;
    /**
     * Batch compute embeddings with caching
     */
    batchGetOrCompute(texts: string[], batchComputeFn: (texts: string[]) => Promise<Float32Array[]>): Promise<Float32Array[]>;
    /**
     * Clear the cache
     */
    clear(): void;
    /**
     * Get cache statistics
     */
    getStats(): {
        size: number;
        maxSize: number;
        hits: number;
        misses: number;
        hitRate: number;
    };
    /**
     * Compute cache key from text
     */
    private computeKey;
    /**
     * Update access order for LRU tracking
     */
    private updateAccessOrder;
    /**
     * Evict least recently used entry
     */
    private evictLRU;
}
