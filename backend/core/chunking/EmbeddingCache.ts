/**
 * EmbeddingCache - LRU cache for embeddings to avoid redundant API calls
 *
 * Used during semantic chunking to cache sentence embeddings
 */

export class EmbeddingCache {
  private cache: Map<string, Float32Array>;
  private accessOrder: string[]; // Track access order for LRU
  private maxSize: number;
  private hits = 0;
  private misses = 0;

  constructor(maxSize = 1000) {
    this.cache = new Map();
    this.accessOrder = [];
    this.maxSize = maxSize;
  }

  /**
   * Get embedding from cache or compute it
   */
  async getOrCompute(
    text: string,
    computeFn: (text: string) => Promise<Float32Array>
  ): Promise<Float32Array> {
    const key = this.computeKey(text);

    if (this.cache.has(key)) {
      this.hits++;
      this.updateAccessOrder(key);
      return this.cache.get(key)!;
    }

    this.misses++;
    const embedding = await computeFn(text);
    this.set(key, embedding);
    return embedding;
  }

  /**
   * Get cached embedding if available
   */
  get(text: string): Float32Array | undefined {
    const key = this.computeKey(text);
    if (this.cache.has(key)) {
      this.hits++;
      this.updateAccessOrder(key);
      return this.cache.get(key);
    }
    this.misses++;
    return undefined;
  }

  /**
   * Store embedding in cache
   */
  set(key: string, embedding: Float32Array): void {
    // Evict if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }

    this.cache.set(key, embedding);
    this.updateAccessOrder(key);
  }

  /**
   * Batch compute embeddings with caching
   */
  async batchGetOrCompute(
    texts: string[],
    batchComputeFn: (texts: string[]) => Promise<Float32Array[]>
  ): Promise<Float32Array[]> {
    const results: (Float32Array | null)[] = new Array(texts.length).fill(null);
    const missingIndices: number[] = [];
    const missingTexts: string[] = [];

    // Check cache for each text
    for (let i = 0; i < texts.length; i++) {
      const key = this.computeKey(texts[i]);
      if (this.cache.has(key)) {
        this.hits++;
        this.updateAccessOrder(key);
        results[i] = this.cache.get(key)!;
      } else {
        this.misses++;
        missingIndices.push(i);
        missingTexts.push(texts[i]);
      }
    }

    // Compute missing embeddings in batch
    if (missingTexts.length > 0) {
      const computed = await batchComputeFn(missingTexts);

      for (let j = 0; j < missingIndices.length; j++) {
        const index = missingIndices[j];
        const embedding = computed[j];
        const key = this.computeKey(texts[index]);

        results[index] = embedding;
        this.set(key, embedding);
      }
    }

    return results as Float32Array[];
  }

  /**
   * Clear the cache
   */
  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
  }

  /**
   * Get cache statistics
   */
  getStats(): { size: number; maxSize: number; hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  // MARK: - Private Methods

  /**
   * Compute cache key from text
   */
  private computeKey(text: string): string {
    // Use a simple hash for the key
    // For short texts, use the text itself
    if (text.length <= 100) {
      return text.toLowerCase().trim();
    }

    // For longer texts, use a hash
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return `hash_${hash}_${text.length}`;
  }

  /**
   * Update access order for LRU tracking
   */
  private updateAccessOrder(key: string): void {
    // Remove from current position
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
    // Add to end (most recently used)
    this.accessOrder.push(key);
  }

  /**
   * Evict least recently used entry
   */
  private evictLRU(): void {
    if (this.accessOrder.length === 0) return;

    const lruKey = this.accessOrder.shift()!;
    this.cache.delete(lruKey);
  }
}
