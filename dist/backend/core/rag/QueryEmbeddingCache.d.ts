/**
 * QueryEmbeddingCache - LRU cache for query embeddings
 *
 * Caches embeddings generated for search queries to avoid
 * redundant Ollama calls for repeated or similar queries.
 */
export interface QueryEmbeddingCacheStats {
    hits: number;
    misses: number;
    size: number;
    hitRate: string;
}
export declare class QueryEmbeddingCache {
    private cache;
    private stats;
    /**
     * @param maxSize Maximum number of embeddings to cache (default 500)
     * @param ttlMinutes Time-to-live in minutes (default 60)
     */
    constructor(maxSize?: number, ttlMinutes?: number);
    /**
     * Hash a query string for cache key
     * Normalizes: lowercase, trim, collapse whitespace
     */
    private hashQuery;
    /**
     * Get cached embedding for a query
     */
    get(query: string): Float32Array | undefined;
    /**
     * Cache an embedding for a query
     */
    set(query: string, embedding: Float32Array): void;
    /**
     * Check if query is cached (without updating stats)
     */
    has(query: string): boolean;
    /**
     * Get cache statistics
     */
    getStats(): QueryEmbeddingCacheStats;
    /**
     * Clear the cache
     */
    clear(): void;
    /**
     * Log cache stats (for debugging)
     */
    logStats(): void;
}
