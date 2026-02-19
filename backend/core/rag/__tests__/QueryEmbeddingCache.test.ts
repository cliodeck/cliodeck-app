import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryEmbeddingCache } from '../QueryEmbeddingCache';

// Suppress console.log during tests
vi.spyOn(console, 'log').mockImplementation(() => {});

describe('QueryEmbeddingCache', () => {
  let cache: QueryEmbeddingCache;

  beforeEach(() => {
    cache = new QueryEmbeddingCache();
  });

  describe('set() and get()', () => {
    it('stores and retrieves an embedding', () => {
      const embedding = new Float32Array([0.1, 0.2, 0.3]);
      cache.set('test query', embedding);

      const result = cache.get('test query');
      expect(result).toEqual(embedding);
    });

    it('returns undefined for uncached query', () => {
      const result = cache.get('uncached query');
      expect(result).toBeUndefined();
    });

    it('normalizes queries (case-insensitive)', () => {
      const embedding = new Float32Array([0.1, 0.2, 0.3]);
      cache.set('Test Query', embedding);

      const result = cache.get('test query');
      expect(result).toEqual(embedding);
    });

    it('normalizes queries (whitespace collapsing)', () => {
      const embedding = new Float32Array([0.4, 0.5, 0.6]);
      cache.set('hello   world', embedding);

      const result = cache.get('hello world');
      expect(result).toEqual(embedding);
    });

    it('normalizes queries (trimming)', () => {
      const embedding = new Float32Array([0.7, 0.8, 0.9]);
      cache.set('  trimmed query  ', embedding);

      const result = cache.get('trimmed query');
      expect(result).toEqual(embedding);
    });
  });

  describe('has()', () => {
    it('returns true for cached query', () => {
      cache.set('existing query', new Float32Array([1.0]));
      expect(cache.has('existing query')).toBe(true);
    });

    it('returns false for uncached query', () => {
      expect(cache.has('nonexistent query')).toBe(false);
    });

    it('normalizes the query for lookup', () => {
      cache.set('Normalized Query', new Float32Array([1.0]));
      expect(cache.has('normalized query')).toBe(true);
    });
  });

  describe('getStats()', () => {
    it('starts with zero hits and misses', () => {
      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.size).toBe(0);
      expect(stats.hitRate).toBe('0%');
    });

    it('tracks hits correctly', () => {
      cache.set('query', new Float32Array([1.0]));
      cache.get('query'); // hit
      cache.get('query'); // hit

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(0);
      expect(stats.hitRate).toBe('100.0%');
    });

    it('tracks misses correctly', () => {
      cache.get('missing1'); // miss
      cache.get('missing2'); // miss

      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(2);
      expect(stats.hitRate).toBe('0.0%');
    });

    it('computes hit rate correctly', () => {
      cache.set('query', new Float32Array([1.0]));
      cache.get('query');     // hit
      cache.get('missing');   // miss

      const stats = cache.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBe('50.0%');
    });

    it('reports correct cache size', () => {
      cache.set('q1', new Float32Array([1.0]));
      cache.set('q2', new Float32Array([2.0]));
      cache.set('q3', new Float32Array([3.0]));

      const stats = cache.getStats();
      expect(stats.size).toBe(3);
    });
  });

  describe('clear()', () => {
    it('removes all cached entries', () => {
      cache.set('q1', new Float32Array([1.0]));
      cache.set('q2', new Float32Array([2.0]));

      cache.clear();

      expect(cache.has('q1')).toBe(false);
      expect(cache.has('q2')).toBe(false);
      expect(cache.getStats().size).toBe(0);
    });

    it('resets stats', () => {
      cache.set('q', new Float32Array([1.0]));
      cache.get('q'); // hit
      cache.get('missing'); // miss

      cache.clear();

      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });
  });

  describe('LRU eviction', () => {
    it('respects maxSize parameter', () => {
      const smallCache = new QueryEmbeddingCache(3);

      smallCache.set('q1', new Float32Array([1.0]));
      smallCache.set('q2', new Float32Array([2.0]));
      smallCache.set('q3', new Float32Array([3.0]));
      smallCache.set('q4', new Float32Array([4.0])); // should evict q1

      expect(smallCache.has('q1')).toBe(false); // evicted
      expect(smallCache.has('q4')).toBe(true);
      expect(smallCache.getStats().size).toBe(3);
    });
  });

  describe('logStats()', () => {
    it('does not throw', () => {
      cache.set('q', new Float32Array([1.0]));
      cache.get('q');
      expect(() => cache.logStats()).not.toThrow();
    });
  });
});
