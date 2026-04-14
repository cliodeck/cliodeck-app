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

export type SourceType = 'secondary' | 'primary' | 'both';

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

  console.log('🌐 [MULTILINGUAL] Query expansion:', {
    original: query,
    expanded: queries,
    count: queries.length,
  });

  return queries;
}

class RetrievalService {
  private vectorStore: VectorStore | EnhancedVectorStore | null = null;
  private llmProviderManager: LLMProviderManager | null = null;
  private queryEmbeddingCache = new QueryEmbeddingCache(500, 60);
  private workspaceRoot: string | null = null;
  private vaultStore: ObsidianVaultStore | null = null;

  /**
   * Wire the service to the project-scoped dependencies. Called by
   * pdf-service.init() so the two services share the same vector store
   * and provider manager instances.
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
  }

  clear(): void {
    this.vectorStore = null;
    this.llmProviderManager = null;
    this.queryEmbeddingCache = new QueryEmbeddingCache(500, 60);
    this.workspaceRoot = null;
    this.vaultStore?.close();
    this.vaultStore = null;
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
    const cached = this.queryEmbeddingCache.get(query);
    if (cached) return cached;
    const embedding = await this.llmProviderManager!.generateQueryEmbedding(query);
    this.queryEmbeddingCache.set(query, embedding);
    return embedding;
  }

  async search(q: RetrievalQuery): Promise<MultiSourceSearchResult[]> {
    this.ensureReady();

    const sourceType = q.sourceType || 'both';
    const searchStart = Date.now();
    const ragConfig = configManager.getRAGConfig();
    const topK = q.topK || ragConfig.topK;
    const threshold = q.threshold || ragConfig.similarityThreshold;

    console.log(
      `🔍 [PDF-SERVICE] Multi-source search: sourceType=${sourceType}, topK=${topK}`
    );

    const allSourceResults: MultiSourceSearchResult[] = [];

    if (sourceType === 'secondary' || sourceType === 'both') {
      const secondaryResults = await this.searchSecondary(q.query, {
        topK: sourceType === 'both' ? Math.ceil(topK * 0.6) : topK,
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
      console.log(
        `📚 [PDF-SERVICE] Secondary sources: ${secondaryResults.length} results`
      );
    }

    if (sourceType === 'primary' || sourceType === 'both') {
      try {
        const primaryResults = await tropyService.search(q.query, {
          topK: sourceType === 'both' ? Math.ceil(topK * 0.4) : topK,
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
        console.log(
          `📜 [PDF-SERVICE] Primary sources: ${primaryResults.length} results`
        );
      } catch (error: unknown) {
        console.warn(
          '⚠️ [PDF-SERVICE] Primary source search failed (Tropy not initialized?):',
          error
        );
      }
    }

    if (q.includeVault) {
      try {
        const vaultResults = await this.searchVault(q.query, {
          topK: sourceType === 'both' ? Math.ceil(topK * 0.4) : topK,
        });
        allSourceResults.push(...vaultResults);
        console.log(
          `📓 [PDF-SERVICE] Vault (Obsidian): ${vaultResults.length} results`
        );
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

    console.log(
      `🔍 [PDF-SERVICE] Final combined results: ${sortedResults.length} (from ${allSourceResults.length} total)`
    );
    console.log(
      `🔍 [PDF-SERVICE] Total search duration: ${Date.now() - searchStart}ms`
    );

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

      console.log(
        `🔍 [PDF-SERVICE] Collection filter: ${options.collectionKeys.length} collection(s) -> ${docsInCollections.length} document(s)`
      );

      if (documentIdsFilter && documentIdsFilter.length > 0) {
        documentIdsFilter = documentIdsFilter.filter((id) =>
          docsInCollections.includes(id)
        );
        console.log(
          `🔍 [PDF-SERVICE] After intersection with documentIds: ${documentIdsFilter.length} document(s)`
        );
      } else {
        documentIdsFilter = docsInCollections;
      }

      if (documentIdsFilter.length === 0) {
        console.log(
          '🔍 [PDF-SERVICE] No documents match the collection filter, returning empty results'
        );
        return [];
      }
    }

    const expandedQueries = expandQueryMultilingual(query);
    const allResults = new Map<string, SearchResult>();

    const embeddingStart = Date.now();
    console.log(
      `🔍 [PDF-SERVICE] Generating ${expandedQueries.length} embeddings in parallel...`
    );

    const embeddingPromises = expandedQueries.map((q) => this.getQueryEmbedding(q));
    const embeddings = await Promise.all(embeddingPromises);

    const embeddingDuration = Date.now() - embeddingStart;
    console.log(
      `✅ [PDF-SERVICE] All embeddings generated in ${embeddingDuration}ms`
    );

    const cacheStats = this.queryEmbeddingCache.getStats();
    if ((cacheStats.hits + cacheStats.misses) % 10 === 0) {
      console.log(
        `💾 [EMB CACHE] Stats: ${cacheStats.hits} hits, ${cacheStats.misses} misses (${cacheStats.hitRate})`
      );
    }

    const searchStart2 = Date.now();
    const searchPromises = embeddings.map((queryEmbedding, i) => {
      const expandedQuery = expandedQueries[i];
      if (this.vectorStore instanceof EnhancedVectorStore) {
        return this.vectorStore.search(
          expandedQuery,
          queryEmbedding,
          topK,
          documentIdsFilter
        );
      } else {
        return Promise.resolve(
          this.vectorStore!.search(queryEmbedding, topK, documentIdsFilter)
        );
      }
    });

    const allSearchResults = await Promise.all(searchPromises);
    const searchDuration = Date.now() - searchStart2;
    console.log(
      `✅ [PDF-SERVICE] All searches completed in ${searchDuration}ms`
    );

    for (let i = 0; i < allSearchResults.length; i++) {
      const results = allSearchResults[i];
      for (const result of results) {
        const chunkId = result.chunk.id;
        const existing = allResults.get(chunkId);
        if (!existing || result.similarity > existing.similarity) {
          allResults.set(chunkId, result);
        }
      }
    }

    console.log(
      `🔍 [PDF-SERVICE] Merged ${allResults.size} unique chunks from ${expandedQueries.length} query variants`
    );

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

    return filteredResults;
  }
}

export const retrievalService = new RetrievalService();
