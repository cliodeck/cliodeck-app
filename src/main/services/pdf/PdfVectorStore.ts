/**
 * PdfVectorStore — extracted from pdf-service.ts as part of the fusion
 * split (see CLAUDE.md §2). Thin wrapper around the SQLite-backed
 * `VectorStore` / `EnhancedVectorStore` pair that centralizes creation,
 * HNSW/BM25 configuration, and a few analysis-oriented helpers that used
 * to live inline in `PDFService`. Behaviour is preserved; this module
 * exists so the facade in `pdf-service.ts` stays slim.
 */
import { VectorStore } from '../../../../backend/core/vector-store/VectorStore.js';
import { EnhancedVectorStore } from '../../../../backend/core/vector-store/EnhancedVectorStore.js';
import type { RAGConfig } from '../../../../backend/types/config.js';

export type AnyVectorStore = VectorStore | EnhancedVectorStore;

export interface CreateOptions {
  onRebuildProgress?: (progress: {
    current: number;
    total: number;
    status: string;
    percentage: number;
  }) => void;
}

export class PdfVectorStore {
  /**
   * Create + initialize a vector store based on the RAG config. Returns
   * both the store and the init promise so the caller can parallelize
   * with LLM init.
   */
  static create(
    projectPath: string,
    ragConfig: RAGConfig,
    options: CreateOptions = {}
  ): { store: AnyVectorStore; useEnhanced: boolean; initPromise: Promise<void> | undefined } {
    const useEnhanced =
      ragConfig.useHNSWIndex !== false || ragConfig.useHybridSearch !== false;

    if (useEnhanced) {
      console.log('🚀 [PDF-SERVICE] Using EnhancedVectorStore (HNSW + BM25)');
      const store = new EnhancedVectorStore(projectPath);
      if (options.onRebuildProgress) {
        store.setRebuildProgressCallback(options.onRebuildProgress);
      }
      return { store, useEnhanced: true, initPromise: store.initialize() };
    }

    console.log('📊 [PDF-SERVICE] Using standard VectorStore (linear search)');
    const store = new VectorStore(projectPath);
    return { store, useEnhanced: false, initPromise: undefined };
  }

  /**
   * Post-init configuration of an `EnhancedVectorStore`: wires search
   * modes (HNSW / hybrid BM25) according to user config. Does not
   * trigger a rebuild — see `maybeRebuild` below so the caller can
   * explicitly sequence warmup → rebuild.
   */
  static configureEnhanced(store: AnyVectorStore, ragConfig: RAGConfig): void {
    if (!(store instanceof EnhancedVectorStore)) return;
    if (ragConfig.useHNSWIndex !== undefined) {
      store.setUseHNSW(ragConfig.useHNSWIndex);
    }
    if (ragConfig.useHybridSearch !== undefined) {
      store.setUseHybrid(ragConfig.useHybridSearch);
    }
  }

  /**
   * Kick off an async index rebuild if the store reports stale
   * indexes. Returns the promise so callers can sequence work
   * (e.g. `await warmup; void maybeRebuild(...)`). Failures are logged
   * but do not reject the returned promise.
   */
  static maybeRebuild(store: AnyVectorStore): Promise<void> {
    if (!(store instanceof EnhancedVectorStore)) return Promise.resolve();
    if (!store.needsRebuild()) return Promise.resolve();

    console.log('🔨 [PDF-SERVICE] Indexes need rebuild, starting rebuild...');
    return store
      .rebuildIndexes()
      .then(() => {
        console.log('✅ [PDF-SERVICE] Indexes rebuilt successfully');
      })
      .catch((error: unknown) => {
        console.error('❌ [PDF-SERVICE] Rebuild failed:', error);
      });
  }

  /**
   * Indexed lookup by id. Prefer this over `getAllDocuments().find()`
   * which hydrates every row (including per-doc chunk-count queries).
   */
  static getDocumentById(store: AnyVectorStore, id: string): unknown {
    // Both VectorStore and EnhancedVectorStore now expose getDocumentById.
    return (store as { getDocumentById: (id: string) => unknown }).getDocumentById(id);
  }
}
