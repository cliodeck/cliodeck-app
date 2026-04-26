/**
 * SecondaryRetriever (fusion 3.11).
 *
 * Extracted from `RetrievalService.searchSecondary` (192 LOC of inline
 * logic in `src/main/services/retrieval-service.ts`). The retrieval
 * pipeline for the **secondary corpus** (PDFs, BM25-augmented HNSW
 * via `EnhancedVectorStore`) now lives here as a self-contained,
 * testable unit. The wrapping `RetrievalService` keeps its
 * orchestration role (fan-out across primary / secondary / vault,
 * SourceInspector wiring, partial-success envelope) and delegates the
 * secondary branch to this class.
 *
 * Responsibilities, in pipeline order:
 *
 *   1. **Filter resolution** — combine `documentIds` + `collectionKeys`
 *      into a single document-id allowlist via the store's collection
 *      → document-id mapping. Empty intersection short-circuits to [].
 *
 *   2. **Query expansion** — multilingual variants for academic-EN/FR
 *      queries (e.g. "taxonomie de Bloom" → also "Bloom's taxonomy").
 *      Default expander uses the curated FR↔EN map (`expandQueryFrEn`,
 *      same as the legacy `expandQueryMultilingual`); callers can
 *      inject their own (or an identity expander for tests).
 *
 *   3. **Embedding fan-out** — compute embeddings for every variant in
 *      parallel via the injected `getQueryEmbedding(text)` callback.
 *      The callback is responsible for caching / provider selection;
 *      this class is provider-agnostic.
 *
 *   4. **Hybrid search** — strategy depends on the store + variant
 *      count:
 *        - 1 variant + Enhanced: single hybrid HNSW+BM25 search.
 *        - 1 variant + plain VectorStore: HNSW only.
 *        - N variants + Enhanced: pooled-HNSW hit + per-variant
 *          BM25-driven hit, deduped on `chunk.id` keeping the highest
 *          similarity. Cheap because BM25 is a string match, no
 *          extra HNSW probes.
 *        - N variants + plain VectorStore: pooled HNSW only — variants
 *          add no lexical signal here.
 *
 *   5. **Merge + threshold + fallback** — sort by similarity, slice to
 *      `topK`, drop everything below `threshold`. **If the threshold
 *      filter empties the list while there were merged results**,
 *      keep the top `min(3, mergedResults.length)` — historians ask
 *      cross-language questions where the threshold is calibrated for
 *      same-language hits, and an empty result set there is worse
 *      than three borderline ones.
 */

import type { SearchResult } from '../../../types/pdf-document.js';
import type { VectorStore } from '../../vector-store/VectorStore.js';
import { EnhancedVectorStore } from '../../vector-store/EnhancedVectorStore.js';

export type EmbedQuery = (query: string) => Promise<Float32Array>;
export type ExpandQuery = (query: string) => string[];

/**
 * Curated FR↔EN academic-term map. The source-of-truth for both the
 * `expandQueryFrEn` expander below and the embedding-cache warmup in
 * `retrieval-service.ts`. A20 (deferred) will move this to the
 * workspace config so historians can extend it without recompiling.
 */
export const ACADEMIC_TERMS_FR_TO_EN: Record<string, string[]> = {
  'taxonomie de bloom': ["bloom's taxonomy", 'bloom taxonomy', 'blooms taxonomy'],
  'zone proximale développement': ['zone of proximal development', 'zpd', 'vygotsky'],
  'apprentissage significatif': ['meaningful learning', 'significant learning'],
  constructivisme: ['constructivism', 'constructivist'],
  socioconstructivisme: ['social constructivism', 'socioconstructivism'],
  métacognition: ['metacognition', 'metacognitive'],
  'pédagogie active': ['active learning', 'active pedagogy'],
};

/**
 * Default multilingual expander — maps the curated FR academic terms
 * to their EN counterparts and yields one variant per translation.
 * Always includes the original query as variant 0.
 */
export function expandQueryFrEn(query: string): string[] {
  const queries = [query];
  const lower = query.toLowerCase();
  for (const [frTerm, enTranslations] of Object.entries(ACADEMIC_TERMS_FR_TO_EN)) {
    if (lower.includes(frTerm)) {
      for (const enTerm of enTranslations) {
        queries.push(query.replace(new RegExp(frTerm, 'gi'), enTerm));
      }
    }
  }
  return queries;
}

/** Mean-pool a non-empty list of equal-dimension embeddings. */
export function meanPoolEmbeddings(embeddings: Float32Array[]): Float32Array {
  if (embeddings.length === 0) {
    throw new Error('meanPoolEmbeddings: cannot pool an empty list');
  }
  const dim = embeddings[0].length;
  const pooled = new Float32Array(dim);
  for (const e of embeddings) {
    for (let i = 0; i < dim; i++) pooled[i] += e[i];
  }
  for (let i = 0; i < dim; i++) pooled[i] /= embeddings.length;
  return pooled;
}

export interface SecondaryRetrieverDeps {
  vectorStore: VectorStore | EnhancedVectorStore;
  /** Embedding function — usually wraps a provider + cache. */
  getQueryEmbedding: EmbedQuery;
  /** Variant generator. Default: `expandQueryFrEn`. Pass identity for tests. */
  expandQuery?: ExpandQuery;
  /**
   * Override the hybrid-store check. The default `instanceof
   * EnhancedVectorStore` works in production where every caller goes
   * through the same module instance, but tests sometimes hand back
   * a stub that doesn't pass `instanceof`. Pass a predicate to make
   * the branch explicit.
   */
  isHybridStore?: (store: VectorStore | EnhancedVectorStore) => boolean;
}

export interface SecondarySearchOptions {
  topK: number;
  threshold: number;
  /** Restrict the search to these document ids. */
  documentIds?: string[];
  /** Restrict via collection membership; intersected with `documentIds`. */
  collectionKeys?: string[];
}

/**
 * Pure logic over a vector store + an embedding callback. The class is
 * stateless apart from the dependencies stored at construction; one
 * instance per `RetrievalService` is fine.
 */
export class SecondaryRetriever {
  private readonly vectorStore: VectorStore | EnhancedVectorStore;
  private readonly getQueryEmbedding: EmbedQuery;
  private readonly expandQuery: ExpandQuery;
  private readonly isHybridStore: (
    store: VectorStore | EnhancedVectorStore
  ) => boolean;

  constructor(deps: SecondaryRetrieverDeps) {
    this.vectorStore = deps.vectorStore;
    this.getQueryEmbedding = deps.getQueryEmbedding;
    this.expandQuery = deps.expandQuery ?? expandQueryFrEn;
    this.isHybridStore =
      deps.isHybridStore ?? ((s) => s instanceof EnhancedVectorStore);
  }

  async search(
    query: string,
    options: SecondarySearchOptions
  ): Promise<SearchResult[]> {
    const { topK, threshold } = options;

    const documentIdsFilter = this.resolveDocumentFilter(
      options.documentIds,
      options.collectionKeys
    );
    if (documentIdsFilter !== undefined && documentIdsFilter.length === 0) {
      // Either the caller passed an empty whitelist or the intersection
      // of documentIds + collectionKeys was empty. Nothing can match.
      return [];
    }

    const expandedQueries = this.expandQuery(query);
    const embeddings = await Promise.all(
      expandedQueries.map((q) => this.getQueryEmbedding(q))
    );

    const merged = await this.runHybridSearch(
      expandedQueries,
      embeddings,
      topK,
      documentIdsFilter
    );

    const sorted = Array.from(merged.values())
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);

    let filtered = sorted.filter((r) => r.similarity >= threshold);
    if (filtered.length === 0 && sorted.length > 0) {
      // Cross-language fallback — keep the top 3 regardless of the
      // threshold (or fewer if there aren't 3). Better to surface
      // borderline hits than to return empty when we *did* find
      // candidates above the floor.
      filtered = sorted.slice(0, Math.min(3, sorted.length));
    }
    return filtered;
  }

  private resolveDocumentFilter(
    documentIds: string[] | undefined,
    collectionKeys: string[] | undefined
  ): string[] | undefined {
    if (!collectionKeys || collectionKeys.length === 0) {
      return documentIds;
    }
    const docsInCollections = this.vectorStore.getDocumentIdsInCollections(
      collectionKeys,
      true
    );
    if (documentIds && documentIds.length > 0) {
      // Intersection: only ids in BOTH lists survive.
      const intersection = documentIds.filter((id) =>
        docsInCollections.includes(id)
      );
      return intersection;
    }
    return docsInCollections;
  }

  private async runHybridSearch(
    expandedQueries: string[],
    embeddings: Float32Array[],
    topK: number,
    documentIdsFilter: string[] | undefined
  ): Promise<Map<string, SearchResult>> {
    const merged = new Map<string, SearchResult>();
    const isHybrid = this.isHybridStore(this.vectorStore);

    if (expandedQueries.length === 1) {
      const queryEmbedding = embeddings[0];
      const results = isHybrid
        ? await (this.vectorStore as EnhancedVectorStore).search(
            expandedQueries[0],
            queryEmbedding,
            topK,
            documentIdsFilter
          )
        : (this.vectorStore as VectorStore).search(
            queryEmbedding,
            topK,
            documentIdsFilter
          );
      for (const r of results) merged.set(r.chunk.id, r);
      return merged;
    }

    const pooled = meanPoolEmbeddings(embeddings);

    if (!isHybrid) {
      // Plain VectorStore is HNSW-only — variants add no lexical
      // signal. A single pooled probe is strictly cheaper than N.
      const results = (this.vectorStore as VectorStore).search(
        pooled,
        topK,
        documentIdsFilter
      );
      for (const r of results) merged.set(r.chunk.id, r);
      return merged;
    }

    // Enhanced: pooled HNSW + per-variant BM25-driven search. The
    // variant probes preserve lexical recall of translated terms
    // without N HNSW probes (they ride on the same pooled embedding).
    const store = this.vectorStore as EnhancedVectorStore;
    const pooledPromise = store.search(
      expandedQueries[0],
      pooled,
      topK,
      documentIdsFilter
    );
    const variantPromises = expandedQueries.map((eq) =>
      store.search(eq, pooled, topK, documentIdsFilter)
    );
    const buckets = await Promise.all([pooledPromise, ...variantPromises]);
    for (const results of buckets) {
      for (const r of results) {
        const existing = merged.get(r.chunk.id);
        if (!existing || r.similarity > existing.similarity) {
          merged.set(r.chunk.id, r);
        }
      }
    }
    return merged;
  }
}
