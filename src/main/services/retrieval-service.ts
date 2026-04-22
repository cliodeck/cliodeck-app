/**
 * RetrievalService (fusion B1 — pure extraction).
 *
 * Owns the multi-source RAG retrieval pipeline previously embedded in
 * `pdf-service`: multilingual query expansion, embedding cache, hybrid
 * (HNSW + BM25) search over secondary sources (PDFs), and primary
 * source search via `tropyService`.
 *
 * This is a non-behavioral extraction: the facade in `pdf-service.search`
 * now delegates here, preserving logs, thresholds, fallbacks, and output
 * shape byte-for-byte. A follow-up commit (B2) will wire
 * `fusion-chat-service` to consume this service directly.
 */

import fs from 'fs';
import { VectorStore } from '../../../backend/core/vector-store/VectorStore.js';
import { EnhancedVectorStore } from '../../../backend/core/vector-store/EnhancedVectorStore.js';
import { LLMProviderManager } from '../../../backend/core/llm/LLMProviderManager.js';
import { QueryEmbeddingCache } from '../../../backend/core/rag/QueryEmbeddingCache.js';
import type {
  SearchResult,
} from '../../../backend/types/pdf-document.js';
import type {
  PrimarySourceSearchResult,
  PrimarySourceDocument,
} from '../../../backend/core/vector-store/PrimarySourcesVectorStore.js';
import { ObsidianVaultStore } from '../../../backend/integrations/obsidian/ObsidianVaultStore.js';
import { obsidianStorePath } from '../../../backend/integrations/obsidian/ObsidianVaultIndexer.js';
import { configManager } from './config-manager.js';
import { tropyService } from './tropy-service.js';

/**
 * Hot-path logging gate. The retrieval pipeline emits a high volume of
 * per-query diagnostics; in production we want warnings/errors only. Set
 * `CLIODECK_RAG_DEBUG=1` in the env to restore the verbose trace.
 */
const DEBUG = process.env.CLIODECK_RAG_DEBUG === '1';

/**
 * Module-scope embedding cache. The embedding of a query string is
 * invariant across project changes (same text → same vector for a given
 * provider), so we deliberately keep this cache across `configure()` /
 * `clear()` calls. Provider-scoped invalidation is available via
 * `queryEmbeddingCache.invalidateProvider(providerId)` when a provider's
 * embedding model actually changes.
 */
const queryEmbeddingCache = new QueryEmbeddingCache(2000, 10);

/**
 * 'secondary' = bibliography (PDFs), 'primary' = Tropy archives,
 * 'both'      = both bibliography + primary corpora,
 * 'vault'     = Obsidian vault only (skip primary and secondary).
 * Note: non-vault values compose with the separate `includeVault` opt-in
 * to mix notes in alongside primary/secondary.
 */
export type SourceType = 'secondary' | 'primary' | 'both' | 'vault';

export interface SecondarySearchResult extends SearchResult {
  sourceType: 'secondary';
}

export interface PrimaryMappedSearchResult {
  chunk: {
    id: string;
    content: string;
    documentId: string | undefined;
    chunkIndex: number;
  };
  document: {
    id: string | undefined;
    title: string | undefined;
    author: string | undefined;
    bibtexKey: null;
  };
  source: PrimarySourceDocument | undefined;
  similarity: number;
  sourceType: 'primary';
}

export interface VaultMappedSearchResult {
  chunk: {
    id: string;
    content: string;
    documentId: string | undefined;
    chunkIndex: number;
  };
  document: {
    id: string | undefined;
    title: string | undefined;
    author: null;
    bibtexKey: null;
  };
  source: {
    kind: 'obsidian-note';
    relativePath: string;
    noteId: string;
  };
  similarity: number;
  sourceType: 'vault';
}

export type MultiSourceSearchResult =
  | SecondarySearchResult
  | PrimaryMappedSearchResult
  | VaultMappedSearchResult;

/**
 * Partial RAG-explanation payload produced alongside retrieval hits. Only
 * the `search` slice is populated here (plus a `timing.searchMs`); the
 * compression/graph/llm slices are filled by downstream stages. Mirrors
 * the `RAGExplanation` type in `backend/types/chat-source.ts`.
 */
export interface RetrievalSearchStats {
  search: {
    query: string;
    totalResults: number;
    searchDurationMs: number;
    cacheHit: boolean;
    sourceType: 'primary' | 'secondary' | 'both';
    documents: Array<{
      title: string;
      similarity: number;
      sourceType: string;
      chunkCount: number;
    }>;
  };
  timing: {
    searchMs: number;
  };
}

export interface RetrievalSearchWithStatsResult {
  hits: MultiSourceSearchResult[];
  stats: RetrievalSearchStats;
}

export interface RetrievalQuery {
  query: string;
  topK?: number;
  threshold?: number;
  sourceType?: SourceType;
  documentIds?: string[];
  collectionKeys?: string[];
  /**
   * When true, also search the workspace Obsidian vault (if indexed).
   * Legacy callers (chat-service) omit this and keep PDF+Tropy-only
   * behaviour; Brainstorm chat opts in.
   */
  includeVault?: boolean;
}

// Dictionnaire de termes académiques FR→EN pour query expansion.
const ACADEMIC_TERMS_FR_TO_EN: Record<string, string[]> = {
  'taxonomie de bloom': ["bloom's taxonomy", 'bloom taxonomy', 'blooms taxonomy'],
  'zone proximale développement': ['zone of proximal development', 'zpd', 'vygotsky'],
  'apprentissage significatif': ['meaningful learning', 'significant learning'],
  constructivisme: ['constructivism', 'constructivist'],
  socioconstructivisme: ['social constructivism', 'socioconstructivism'],
  métacognition: ['metacognition', 'metacognitive'],
  'pédagogie active': ['active learning', 'active pedagogy'],
};

function expandQueryMultilingual(query: string): string[] {
  const queries = [query];
  const lowerQuery = query.toLowerCase();

  for (const [frTerm, enTranslations] of Object.entries(ACADEMIC_TERMS_FR_TO_EN)) {
    if (lowerQuery.includes(frTerm)) {
      enTranslations.forEach((enTerm) => {
        const translatedQuery = query.replace(new RegExp(frTerm, 'gi'), enTerm);
        queries.push(translatedQuery);
      });
    }
  }

  if (DEBUG) {
    console.log('🌐 [MULTILINGUAL] Query expansion:', {
      original: query,
      expanded: queries,
      count: queries.length,
    });
  }

  return queries;
}

/** Mean-pool a non-empty list of embeddings into a single vector. */
function meanPoolEmbeddings(embeddings: Float32Array[]): Float32Array {
  const dim = embeddings[0].length;
  const pooled = new Float32Array(dim);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) pooled[i] += emb[i];
  }
  const n = embeddings.length;
  for (let i = 0; i < dim; i++) pooled[i] /= n;
  return pooled;
}

class RetrievalService {
  private vectorStore: VectorStore | EnhancedVectorStore | null = null;
  private llmProviderManager: LLMProviderManager | null = null;
  private workspaceRoot: string | null = null;
  private vaultStore: ObsidianVaultStore | null = null;
  private warmupStarted = false;

  /**
   * Wire the service to the project-scoped dependencies. Called by
   * pdf-service.init() so the two services share the same vector store
   * and provider manager instances.
   *
   * Note: the embedding cache is module-scoped and is intentionally NOT
   * reset here — query embeddings don't depend on which project is open.
   */
  configure(deps: {
    vectorStore: VectorStore | EnhancedVectorStore;
    llmProviderManager: LLMProviderManager;
    workspaceRoot?: string;
  }): void {
    this.vectorStore = deps.vectorStore;
    this.llmProviderManager = deps.llmProviderManager;
    this.workspaceRoot = deps.workspaceRoot ?? null;
    // Invalidate any previously opened vault store — the project may have
    // changed underneath us.
    this.vaultStore?.close();
    this.vaultStore = null;

    // Fire-and-forget warmup: pre-embed frequent FR↔EN translations so the
    // first real query hits a warm cache. Only runs once per process.
    if (!this.warmupStarted) {
      this.warmupStarted = true;
      void this.warmupDictionaryEmbeddings();
    }
  }

  clear(): void {
    this.vectorStore = null;
    this.llmProviderManager = null;
    // Embedding cache persists across clear() — see constructor comment.
    this.workspaceRoot = null;
    this.vaultStore?.close();
    this.vaultStore = null;
  }

  private getProviderId(): string | undefined {
    // Best-effort: embeddingProvider > provider. Typed loosely because
    // the concrete shape lives in LLMProviderManager internals.
    const mgr = this.llmProviderManager as unknown as {
      config?: { embeddingProvider?: string; provider?: string };
    } | null;
    return mgr?.config?.embeddingProvider || mgr?.config?.provider;
  }

  private async warmupDictionaryEmbeddings(): Promise<void> {
    try {
      const terms: string[] = [];
      for (const [fr, ens] of Object.entries(ACADEMIC_TERMS_FR_TO_EN)) {
        terms.push(fr, ...ens);
      }
      const providerId = this.getProviderId();
      for (const term of terms) {
        if (queryEmbeddingCache.has(term, providerId)) continue;
        try {
          const emb = await this.llmProviderManager!.generateQueryEmbedding(term);
          queryEmbeddingCache.set(term, emb, providerId);
        } catch {
          // Warmup is best-effort: a provider may be unavailable at boot.
          // Abort silently; real queries will retry on demand.
          return;
        }
      }
      if (DEBUG) {
        console.log(
          `💾 [EMB CACHE] Warmup pre-embedded ${terms.length} dictionary terms`
        );
      }
    } catch (err) {
      console.warn('[retrieval] dictionary warmup failed:', err);
    }
  }

  private getVaultStore(): ObsidianVaultStore | null {
    if (this.vaultStore) return this.vaultStore;
    if (!this.workspaceRoot) return null;
    const dbPath = obsidianStorePath(this.workspaceRoot);
    if (!fs.existsSync(dbPath)) return null;
    try {
      // `dimension` is only enforced on insert; for search a sentinel is fine.
      this.vaultStore = new ObsidianVaultStore({ dbPath, dimension: 1 });
      return this.vaultStore;
    } catch (e) {
      console.warn('[retrieval] failed to open Obsidian vault store:', e);
      return null;
    }
  }

  private ensureReady(): void {
    if (!this.vectorStore || !this.llmProviderManager) {
      throw new Error(
        'RetrievalService not configured. Call configure() after initializing pdf-service.'
      );
    }
  }

  private async getQueryEmbedding(query: string): Promise<Float32Array> {
    const providerId = this.getProviderId();
    const cached = queryEmbeddingCache.get(query, providerId);
    if (cached) return cached;
    const embedding = await this.llmProviderManager!.generateQueryEmbedding(query);
    queryEmbeddingCache.set(query, embedding, providerId);
    return embedding;
  }

  /**
   * Opt-in variant of `search` that also returns explainable-AI stats
   * (per-document aggregate, timing, cache hit, source type). Existing
   * callers of `search` are untouched; Brainstorm chat uses this to feed
   * the Explainable-AI panel.
   */
  async searchWithStats(q: RetrievalQuery): Promise<RetrievalSearchWithStatsResult> {
    const t0 = Date.now();
    const hits = await this.search(q);
    const searchMs = Date.now() - t0;

    const documentMap = new Map<
      string,
      { title: string; similarity: number; sourceType: string; chunkCount: number }
    >();
    for (const r of hits) {
      const docId = r.document?.id || 'unknown';
      const existing = documentMap.get(docId);
      if (existing) {
        existing.chunkCount++;
        if (r.similarity > existing.similarity) existing.similarity = r.similarity;
      } else {
        documentMap.set(docId, {
          title: r.document?.title || 'Sans titre',
          similarity: r.similarity,
          sourceType: r.sourceType,
          chunkCount: 1,
        });
      }
    }

    // Collapse 'vault' into 'both' for the stats envelope (vault shows as a
    // separate corpus in the hit list itself). The stats type stays on the
    // narrower PDF+Tropy triad to avoid breaking downstream consumers.
    const sourceType: 'primary' | 'secondary' | 'both' =
      q.sourceType === 'primary' || q.sourceType === 'secondary' ? q.sourceType : 'both';

    return {
      hits,
      stats: {
        search: {
          query: q.query,
          totalResults: hits.length,
          searchDurationMs: searchMs,
          cacheHit: false,
          sourceType,
          documents: Array.from(documentMap.values()).slice(0, 10),
        },
        timing: { searchMs },
      },
    };
  }

  async search(q: RetrievalQuery): Promise<MultiSourceSearchResult[]> {
    this.ensureReady();

    const sourceType = q.sourceType || 'both';
    const searchStart = Date.now();
    const ragConfig = configManager.getRAGConfig();
    const topK = q.topK || ragConfig.topK;
    const threshold = q.threshold || ragConfig.similarityThreshold;

    if (DEBUG) {
      console.log(
        `🔍 [PDF-SERVICE] Multi-source search: sourceType=${sourceType}, topK=${topK}`
      );
    }

    const allSourceResults: MultiSourceSearchResult[] = [];

    if (sourceType === 'secondary' || sourceType === 'both') {
      const secondaryResults = await this.searchSecondary(q.query, {
        topK,
        threshold,
        documentIds: q.documentIds,
        collectionKeys: q.collectionKeys,
      });
      allSourceResults.push(
        ...secondaryResults.map(
          (r: SearchResult): SecondarySearchResult => ({
            ...r,
            sourceType: 'secondary' as const,
          })
        )
      );
      if (DEBUG) {
        console.log(
          `📚 [PDF-SERVICE] Secondary sources: ${secondaryResults.length} results`
        );
      }
    }

    if (sourceType === 'primary' || sourceType === 'both') {
      try {
        const primaryResults = await tropyService.search(q.query, {
          topK,
          threshold,
        });
        const mappedPrimaryResults: PrimaryMappedSearchResult[] = primaryResults.map(
          (
            r: PrimarySourceSearchResult & { source?: PrimarySourceDocument }
          ): PrimaryMappedSearchResult => ({
            chunk: {
              id: r.chunk.id,
              content: r.chunk.content,
              documentId: r.chunk.sourceId,
              chunkIndex: r.chunk.chunkIndex,
            },
            document: {
              id: r.source?.id,
              title: r.source?.title,
              author: r.source?.creator,
              bibtexKey: null,
            },
            source: r.source,
            similarity: r.similarity,
            sourceType: 'primary' as const,
          })
        );
        allSourceResults.push(...mappedPrimaryResults);
        if (DEBUG) {
          console.log(
            `📜 [PDF-SERVICE] Primary sources: ${primaryResults.length} results`
          );
        }
      } catch (error: unknown) {
        console.warn(
          '⚠️ [PDF-SERVICE] Primary source search failed (Tropy not initialized?):',
          error
        );
      }
    }

    // Vault-only mode implies vault inclusion regardless of the flag.
    if (q.includeVault || sourceType === 'vault') {
      try {
        const vaultResults = await this.searchVault(q.query, {
          topK,
        });
        allSourceResults.push(...vaultResults);
        if (DEBUG) {
          console.log(
            `📓 [PDF-SERVICE] Vault (Obsidian): ${vaultResults.length} results`
          );
        }
      } catch (error: unknown) {
        console.warn(
          '⚠️ [PDF-SERVICE] Vault search failed (not indexed?):',
          error
        );
      }
    }

    const sortedResults = allSourceResults
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);

    if (DEBUG) {
      console.log(
        `🔍 [PDF-SERVICE] Final combined results: ${sortedResults.length} (from ${allSourceResults.length} total)`
      );
      console.log(
        `🔍 [PDF-SERVICE] Total search duration: ${Date.now() - searchStart}ms`
      );
    }

    return sortedResults;
  }

  private async searchVault(
    query: string,
    options: { topK: number }
  ): Promise<VaultMappedSearchResult[]> {
    const store = this.getVaultStore();
    if (!store) return [];
    const embedding = await this.getQueryEmbedding(query);
    const hits = store.search(embedding, query, options.topK);
    return hits.map(
      (h): VaultMappedSearchResult => ({
        chunk: {
          id: h.chunk.id,
          content: h.chunk.content,
          documentId: h.chunk.noteId,
          chunkIndex: h.chunk.chunkIndex,
        },
        document: {
          id: h.note.id,
          title: h.note.title || h.note.relativePath,
          author: null,
          bibtexKey: null,
        },
        source: {
          kind: 'obsidian-note',
          relativePath: h.note.relativePath,
          noteId: h.note.id,
        },
        similarity: h.score,
        sourceType: 'vault',
      })
    );
  }

  private async searchSecondary(
    query: string,
    options?: {
      topK?: number;
      threshold?: number;
      documentIds?: string[];
      collectionKeys?: string[];
    }
  ): Promise<SearchResult[]> {
    const searchStart = Date.now();
    const ragConfig = configManager.getRAGConfig();
    const topK = options?.topK || ragConfig.topK;
    const threshold = options?.threshold || ragConfig.similarityThreshold;

    let documentIdsFilter = options?.documentIds;

    if (options?.collectionKeys && options.collectionKeys.length > 0) {
      const docsInCollections = this.vectorStore!.getDocumentIdsInCollections(
        options.collectionKeys,
        true
      );

      if (DEBUG) {
        console.log(
          `🔍 [PDF-SERVICE] Collection filter: ${options.collectionKeys.length} collection(s) -> ${docsInCollections.length} document(s)`
        );
      }

      if (documentIdsFilter && documentIdsFilter.length > 0) {
        documentIdsFilter = documentIdsFilter.filter((id) =>
          docsInCollections.includes(id)
        );
        if (DEBUG) {
          console.log(
            `🔍 [PDF-SERVICE] After intersection with documentIds: ${documentIdsFilter.length} document(s)`
          );
        }
      } else {
        documentIdsFilter = docsInCollections;
      }

      if (documentIdsFilter.length === 0) {
        if (DEBUG) {
          console.log(
            '🔍 [PDF-SERVICE] No documents match the collection filter, returning empty results'
          );
        }
        return [];
      }
    }

    const expandedQueries = expandQueryMultilingual(query);
    const allResults = new Map<string, SearchResult>();

    const embeddingStart = Date.now();
    if (DEBUG) {
      console.log(
        `🔍 [PDF-SERVICE] Generating ${expandedQueries.length} embeddings in parallel...`
      );
    }

    const embeddings = await Promise.all(
      expandedQueries.map((q) => this.getQueryEmbedding(q))
    );

    if (DEBUG) {
      console.log(
        `✅ [PDF-SERVICE] All embeddings generated in ${Date.now() - embeddingStart}ms`
      );
    }

    const cacheStats = queryEmbeddingCache.getStats();
    if (DEBUG && (cacheStats.hits + cacheStats.misses) % 10 === 0) {
      console.log(
        `💾 [EMB CACHE] Stats: ${cacheStats.hits} hits, ${cacheStats.misses} misses (${cacheStats.hitRate})`
      );
    }

    const searchStart2 = Date.now();

    // Strategy:
    //   - 1 variant: run a single HNSW+BM25 search (no pooling overhead).
    //   - N variants: run ONE HNSW search on the mean-pooled embedding
    //     (semantic center of the variants), and — for EnhancedVectorStore
    //     — fire a cheap BM25-driven search per variant to preserve lexical
    //     recall of translated terms. Dedup keeps the best similarity.
    if (expandedQueries.length === 1) {
      const queryEmbedding = embeddings[0];
      const results =
        this.vectorStore instanceof EnhancedVectorStore
          ? await this.vectorStore.search(
              expandedQueries[0],
              queryEmbedding,
              topK,
              documentIdsFilter
            )
          : this.vectorStore!.search(queryEmbedding, topK, documentIdsFilter);
      for (const result of results) {
        allResults.set(result.chunk.id, result);
      }
    } else {
      const pooledEmbedding = meanPoolEmbeddings(embeddings);

      if (this.vectorStore instanceof EnhancedVectorStore) {
        // Pooled HNSW (semantic) + per-variant BM25-capable search (lexical).
        // The hybrid store internally blends HNSW+BM25; passing the variant
        // text preserves BM25 recall for translated terms without N HNSW hits.
        const store = this.vectorStore;
        const pooledPromise = store.search(
          expandedQueries[0],
          pooledEmbedding,
          topK,
          documentIdsFilter
        );
        const variantPromises = expandedQueries.map((eq) =>
          store.search(eq, pooledEmbedding, topK, documentIdsFilter)
        );
        const [pooledResults, ...variantResults] = await Promise.all([
          pooledPromise,
          ...variantPromises,
        ]);
        const buckets = [pooledResults, ...variantResults];
        for (const results of buckets) {
          for (const result of results) {
            const existing = allResults.get(result.chunk.id);
            if (!existing || result.similarity > existing.similarity) {
              allResults.set(result.chunk.id, result);
            }
          }
        }
      } else {
        // Plain VectorStore is HNSW-only: a single pooled search is strictly
        // cheaper than N, and the variants add no lexical signal here.
        const results = this.vectorStore!.search(
          pooledEmbedding,
          topK,
          documentIdsFilter
        );
        for (const result of results) {
          allResults.set(result.chunk.id, result);
        }
      }
    }

    if (DEBUG) {
      console.log(
        `✅ [PDF-SERVICE] All searches completed in ${Date.now() - searchStart2}ms`
      );
      console.log(
        `🔍 [PDF-SERVICE] Merged ${allResults.size} unique chunks from ${expandedQueries.length} query variants`
      );
    }

    const mergedResults = Array.from(allResults.values())
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);

    let filteredResults = mergedResults.filter((r) => r.similarity >= threshold);

    if (filteredResults.length === 0 && mergedResults.length > 0) {
      const minFallbackResults = Math.min(3, mergedResults.length);
      console.warn('⚠️  [PDF-SERVICE DEBUG] All results filtered out by threshold!');
      console.warn(
        '⚠️  [PDF-SERVICE DEBUG] Applying fallback: keeping top',
        minFallbackResults,
        'results'
      );
      console.warn(
        '⚠️  [PDF-SERVICE DEBUG] Best similarity:',
        mergedResults[0]?.similarity.toFixed(4)
      );
      console.warn(
        '⚠️  [PDF-SERVICE DEBUG] This may indicate cross-language search (e.g., FR query → EN docs)'
      );

      filteredResults = mergedResults.slice(0, minFallbackResults);
    }

    if (DEBUG) {
      console.log('🔍 [PDF-SERVICE DEBUG] Secondary search results:', {
        totalUniqueChunks: mergedResults.length,
        filteredResults: filteredResults.length,
        threshold: threshold,
        fallbackApplied:
          filteredResults.length > 0 &&
          filteredResults.length <
            mergedResults.filter((r) => r.similarity >= threshold).length,
        totalDuration: `${Date.now() - searchStart}ms`,
      });
    }

    return filteredResults;
  }
}

export const retrievalService = new RetrievalService();
