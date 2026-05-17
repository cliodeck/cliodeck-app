/**
 * Tests for SecondaryRetriever (fusion 3.11).
 *
 * The retriever orchestrates query expansion → embedding fan-out →
 * hybrid search → merge/threshold/fallback. Each branch matters:
 *
 *   - Single variant vs multi-variant takes different code paths
 *     (mean-pool only fires for N variants).
 *   - Hybrid (Enhanced) vs plain VectorStore takes different paths
 *     (per-variant probes only fire on the hybrid branch).
 *   - Threshold filtering with cross-language fallback is the
 *     subtle behaviour: empty filtered + non-empty merged → keep
 *     top 3.
 *
 * Both stores are stubbed; the retriever is provider-agnostic so the
 * embedding callback is a stub returning canned vectors.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  SecondaryRetriever,
  expandQueryFrEn,
  meanPoolEmbeddings,
} from '../secondary-retriever.js';
import type { SearchResult } from '../../../../types/pdf-document.js';
import type { VectorStore } from '../../../vector-store/VectorStore.js';
import type { EnhancedVectorStore } from '../../../vector-store/EnhancedVectorStore.js';

function fakeResult(id: string, similarity: number): SearchResult {
  return {
    chunk: {
      id,
      content: `chunk ${id}`,
      documentId: 'doc',
      chunkIndex: 0,
      pageNumber: 1,
      embedding: undefined,
    } as unknown as SearchResult['chunk'],
    document: {
      id: 'doc',
      title: 'Doc',
      author: null,
      year: null,
      bibtex_key: null,
      file_path: null,
      indexed_at: null,
      total_chunks: 1,
    } as unknown as SearchResult['document'],
    similarity,
  };
}

function constEmb(value = 0.1): (q: string) => Promise<Float32Array> {
  return async () => Float32Array.from([value, value, value]);
}

describe('expandQueryFrEn', () => {
  it('returns the original query when no academic term matches', () => {
    expect(expandQueryFrEn('what is the capital of France?')).toEqual([
      'what is the capital of France?',
    ]);
  });

  it('expands a known FR term to its EN translations', () => {
    const out = expandQueryFrEn('Histoire de la taxonomie de Bloom');
    expect(out[0]).toBe('Histoire de la taxonomie de Bloom');
    // Three EN translations follow the FR original.
    expect(out).toContain("Histoire de la bloom's taxonomy");
    expect(out).toContain('Histoire de la bloom taxonomy');
    expect(out).toContain('Histoire de la blooms taxonomy');
  });
});

describe('meanPoolEmbeddings', () => {
  it('averages component-wise', () => {
    const a = Float32Array.from([1, 2, 3]);
    const b = Float32Array.from([3, 4, 5]);
    expect(Array.from(meanPoolEmbeddings([a, b]))).toEqual([2, 3, 4]);
  });

  it('throws on an empty list (caller bug)', () => {
    expect(() => meanPoolEmbeddings([])).toThrow(/empty/);
  });
});

describe('SecondaryRetriever — single variant', () => {
  it('runs one HNSW probe on a plain VectorStore', async () => {
    const search = vi.fn().mockReturnValue([fakeResult('a', 0.9)]);
    const store = {
      search,
      getDocumentIdsInCollections: vi.fn(),
    } as unknown as VectorStore;

    const retriever = new SecondaryRetriever({
      vectorStore: store,
      getQueryEmbedding: constEmb(),
      expandQuery: (q) => [q], // identity — no expansion
      isHybridStore: () => false,
    });
    const out = await retriever.search('q', { topK: 5, threshold: 0 });
    expect(out).toHaveLength(1);
    expect(out[0].chunk.id).toBe('a');
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('runs one hybrid probe on EnhancedVectorStore', async () => {
    const search = vi.fn().mockResolvedValue([fakeResult('a', 0.9)]);
    const store = {
      search,
      getDocumentIdsInCollections: vi.fn(),
    } as unknown as EnhancedVectorStore;

    const retriever = new SecondaryRetriever({
      vectorStore: store,
      getQueryEmbedding: constEmb(),
      expandQuery: (q) => [q],
      isHybridStore: () => true,
    });
    const out = await retriever.search('q', { topK: 5, threshold: 0 });
    expect(out).toHaveLength(1);
    // Hybrid store gets called with (queryText, embedding, topK, filter).
    expect(search.mock.calls[0][0]).toBe('q');
    expect(search.mock.calls[0][1]).toBeInstanceOf(Float32Array);
  });
});

describe('SecondaryRetriever — multi-variant', () => {
  it('plain store: a single pooled HNSW probe', async () => {
    const search = vi.fn().mockReturnValue([fakeResult('a', 0.9)]);
    const store = {
      search,
      getDocumentIdsInCollections: vi.fn(),
    } as unknown as VectorStore;

    const retriever = new SecondaryRetriever({
      vectorStore: store,
      getQueryEmbedding: constEmb(),
      expandQuery: () => ['q1', 'q2', 'q3'],
      isHybridStore: () => false,
    });
    const out = await retriever.search('q', { topK: 5, threshold: 0 });
    expect(out).toHaveLength(1);
    // Only one search call — pooled — variants don't add lexical signal here.
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('hybrid store: pooled + per-variant probes, deduped by id keeping highest similarity', async () => {
    const search = vi
      .fn()
      // pooled call — returns an `a` with similarity 0.5
      .mockResolvedValueOnce([fakeResult('a', 0.5)])
      // variant 1 — returns the SAME `a` with higher similarity 0.8 (BM25 lift)
      .mockResolvedValueOnce([fakeResult('a', 0.8), fakeResult('b', 0.4)])
      // variant 2 — returns `c`
      .mockResolvedValueOnce([fakeResult('c', 0.6)]);
    const store = {
      search,
      getDocumentIdsInCollections: vi.fn(),
    } as unknown as EnhancedVectorStore;

    const retriever = new SecondaryRetriever({
      vectorStore: store,
      getQueryEmbedding: constEmb(),
      expandQuery: () => ['q1', 'q2'],
      isHybridStore: () => true,
    });
    const out = await retriever.search('q', { topK: 10, threshold: 0 });
    // 1 pooled + 2 variant probes = 3 calls.
    expect(search).toHaveBeenCalledTimes(3);
    // Dedup: `a` kept at 0.8 (the higher similarity), b and c also pass through.
    const byId = Object.fromEntries(out.map((r) => [r.chunk.id, r.similarity]));
    expect(byId.a).toBe(0.8);
    expect(byId.b).toBe(0.4);
    expect(byId.c).toBe(0.6);
    // Sorted by similarity desc.
    expect(out.map((r) => r.chunk.id)).toEqual(['a', 'c', 'b']);
  });
});

describe('SecondaryRetriever — threshold + fallback', () => {
  it('applies the threshold normally when there are matches above it', async () => {
    const store = {
      search: vi.fn().mockReturnValue([
        fakeResult('a', 0.9),
        fakeResult('b', 0.4),
        fakeResult('c', 0.2),
      ]),
      getDocumentIdsInCollections: vi.fn(),
    } as unknown as VectorStore;
    const retriever = new SecondaryRetriever({
      vectorStore: store,
      getQueryEmbedding: constEmb(),
      expandQuery: (q) => [q],
      isHybridStore: () => false,
    });
    const out = await retriever.search('q', { topK: 5, threshold: 0.5 });
    expect(out.map((r) => r.chunk.id)).toEqual(['a']);
  });

  it('applies the cross-language fallback when threshold filters everything', async () => {
    const store = {
      search: vi.fn().mockReturnValue([
        fakeResult('a', 0.4),
        fakeResult('b', 0.3),
        fakeResult('c', 0.2),
        fakeResult('d', 0.1),
      ]),
      getDocumentIdsInCollections: vi.fn(),
    } as unknown as VectorStore;
    const retriever = new SecondaryRetriever({
      vectorStore: store,
      getQueryEmbedding: constEmb(),
      expandQuery: (q) => [q],
      isHybridStore: () => false,
    });
    const out = await retriever.search('q', { topK: 5, threshold: 0.5 });
    // Threshold would empty the list; fallback keeps top 3 by similarity.
    expect(out.map((r) => r.chunk.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns [] when there are no candidates at all', async () => {
    const store = {
      search: vi.fn().mockReturnValue([]),
      getDocumentIdsInCollections: vi.fn(),
    } as unknown as VectorStore;
    const retriever = new SecondaryRetriever({
      vectorStore: store,
      getQueryEmbedding: constEmb(),
      expandQuery: (q) => [q],
      isHybridStore: () => false,
    });
    const out = await retriever.search('q', { topK: 5, threshold: 0.5 });
    expect(out).toEqual([]);
  });
});

describe('SecondaryRetriever — collection filter', () => {
  it('uses collectionKeys to derive the document allowlist', async () => {
    const search = vi.fn().mockReturnValue([fakeResult('a', 0.9)]);
    const getDocs = vi.fn().mockReturnValue(['doc1', 'doc2']);
    const store = {
      search,
      getDocumentIdsInCollections: getDocs,
    } as unknown as VectorStore;
    const retriever = new SecondaryRetriever({
      vectorStore: store,
      getQueryEmbedding: constEmb(),
      expandQuery: (q) => [q],
      isHybridStore: () => false,
    });
    await retriever.search('q', {
      topK: 5,
      threshold: 0,
      collectionKeys: ['col-A'],
    });
    expect(getDocs).toHaveBeenCalledWith(['col-A'], true);
    // `search` receives the resolved allowlist as its 3rd positional arg.
    expect(search.mock.calls[0][2]).toEqual(['doc1', 'doc2']);
  });

  it('intersects collectionKeys with documentIds when both are present', async () => {
    const search = vi.fn().mockReturnValue([fakeResult('a', 0.9)]);
    const store = {
      search,
      getDocumentIdsInCollections: vi.fn().mockReturnValue(['d1', 'd2', 'd3']),
    } as unknown as VectorStore;
    const retriever = new SecondaryRetriever({
      vectorStore: store,
      getQueryEmbedding: constEmb(),
      expandQuery: (q) => [q],
      isHybridStore: () => false,
    });
    await retriever.search('q', {
      topK: 5,
      threshold: 0,
      documentIds: ['d2', 'd9'],
      collectionKeys: ['col-A'],
    });
    // Intersection: d2 is in both lists; d9 only in caller's list; d1/d3
    // only in collection. → ['d2'].
    expect(search.mock.calls[0][2]).toEqual(['d2']);
  });

  it('short-circuits to [] when the intersection is empty', async () => {
    const search = vi.fn();
    const store = {
      search,
      getDocumentIdsInCollections: vi.fn().mockReturnValue(['d1']),
    } as unknown as VectorStore;
    const retriever = new SecondaryRetriever({
      vectorStore: store,
      getQueryEmbedding: constEmb(),
      expandQuery: (q) => [q],
      isHybridStore: () => false,
    });
    const out = await retriever.search('q', {
      topK: 5,
      threshold: 0,
      documentIds: ['d2'],
      collectionKeys: ['col-A'],
    });
    expect(out).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });
});
