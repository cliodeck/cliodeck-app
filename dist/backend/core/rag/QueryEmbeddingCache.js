/**
 * QueryEmbeddingCache - LRU cache for query embeddings
 *
 * Caches embeddings generated for search queries to avoid
 * redundant Ollama calls for repeated or similar queries.
 */
import { LRUCache } from 'lru-cache';
import { createHash } from 'crypto';
export class QueryEmbeddingCache {
    /**
     * @param maxSize Maximum number of embeddings to cache (default 500)
     * @param ttlMinutes Time-to-live in minutes (default 60)
     */
    constructor(maxSize = 500, ttlMinutes = 60) {
        this.stats = { hits: 0, misses: 0 };
        this.cache = new LRUCache({
            max: maxSize,
            ttl: 1000 * 60 * ttlMinutes,
            updateAgeOnGet: true,
        });
    }
    /**
     * Hash a query string for cache key
     * Normalizes: lowercase, trim, collapse whitespace
     */
    hashQuery(query) {
        const normalized = query.toLowerCase().trim().replace(/\s+/g, ' ');
        return createHash('md5').update(normalized).digest('hex');
    }
    /**
     * Get cached embedding for a query
     */
    get(query) {
        const key = this.hashQuery(query);
        const result = this.cache.get(key);
        if (result) {
            this.stats.hits++;
        }
        else {
            this.stats.misses++;
        }
        return result;
    }
    /**
     * Cache an embedding for a query
     */
    set(query, embedding) {
        const key = this.hashQuery(query);
        this.cache.set(key, embedding);
    }
    /**
     * Check if query is cached (without updating stats)
     */
    has(query) {
        return this.cache.has(this.hashQuery(query));
    }
    /**
     * Get cache statistics
     */
    getStats() {
        const total = this.stats.hits + this.stats.misses;
        return {
            hits: this.stats.hits,
            misses: this.stats.misses,
            size: this.cache.size,
            hitRate: total > 0 ? `${((this.stats.hits / total) * 100).toFixed(1)}%` : '0%',
        };
    }
    /**
     * Clear the cache
     */
    clear() {
        this.cache.clear();
        this.stats = { hits: 0, misses: 0 };
    }
    /**
     * Log cache stats (for debugging)
     */
    logStats() {
        const stats = this.getStats();
        console.log(`💾 [QUERY EMB CACHE] ${stats.hits} hits, ${stats.misses} misses (${stats.hitRate}), ${stats.size} cached`);
    }
}
