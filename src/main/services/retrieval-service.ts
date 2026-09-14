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
import {
  SecondaryRetriever,
  ACADEMIC_TERMS_FR_TO_EN,
  createExpandQueryFrEn,
} from '../../../backend/core/rag/retrievers/secondary-retriever.js';
import { QueryEmbeddingCache } from '../../../backend/core/rag/QueryEmbeddingCache.js';
import {
  corporaInScope,
  fanOutCorpora,
  type CorpusRetriever,
  type RetrievalSourceOutcome,
} from '../../../backend/core/rag/retrievers/corpus.js';
import {
  applyThreshold,
  relevanceScore,
} from '../../../backend/core/rag/relevance.js';
import type {
  SearchResult,
} from '../../../backend/types/pdf-document.js';
import type {
  PrimarySourceSearchResult,
  PrimarySourceDocument,
} from '../../../backend/core/vector-store/PrimarySourcesVectorStore.js';
import { ObsidianVaultStore } from '../../../backend/integrations/obsidian/ObsidianVaultStore.js';
import { obsidianStorePath } from '../../../backend/integrations/obsidian/ObsidianVaultIndexer.js';
import {
  ManuscriptStore,
  manuscriptStorePath,
} from '../../../backend/core/vector-store/ManuscriptStore.js';
import { manuscriptIndexService } from './manuscript-index-service.js';
import { readingNotesIndexService } from './reading-notes-index-service.js';
import { selectWithManuscriptQuota } from './retrieval-quota.js';
import { configManager } from './config-manager.js';
import { tropyService } from './tropy-service.js';
import {
  SourceInspector,
  DEFAULT_INSPECTOR_MODE,
  appendSecurityEvent,
  type InspectableChunk,
  type InspectorMode,
} from '../../../backend/security/source-inspector.js';
import type { SecurityEvent } from '../../../backend/security/events.js';
import { workspaceFiles } from '../../../backend/core/workspace/layout.js';
import { readWorkspaceConfig } from '../../../backend/core/workspace/config.js';
import { createRegistryFromClioDeckConfig } from '../../../backend/core/llm/providers/cliodeck-config-adapter.js';
import type { EmbeddingProvider } from '../../../backend/core/llm/providers/base.js';
import type { ProviderRegistry } from '../../../backend/core/llm/providers/registry.js';

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
 * 'secondary'  = bibliography (PDFs), 'primary' = Tropy archives,
 * 'both'       = both bibliography + primary corpora,
 * 'vault'      = Obsidian vault only (skip primary and secondary),
 * 'manuscript' = the historian's own text only (item 25 des audits).
 * Note: non-exclusive values compose with the separate `includeVault` and
 * `includeManuscript` opt-ins to mix notes / own text in alongside
 * primary/secondary.
 */
export type SourceType = 'secondary' | 'primary' | 'both' | 'vault' | 'manuscript';

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

/**
 * Un extrait du manuscrit de l'auteur. `sourceType: 'manuscript'` doit
 * rester distinguable jusqu'à l'affichage : un historien a le droit de
 * savoir qu'il se cite lui-même plutôt qu'une source d'archive. C'est une
 * exigence intellectuelle, pas une finition cosmétique.
 */
export interface ManuscriptMappedSearchResult {
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
    kind: 'manuscript-chapter';
    relativePath: string;
    chapterId: string;
    sectionTitle?: string;
    /** Ligne 1-indexée du début de section, pour rouvrir au bon endroit. */
    line: number;
  };
  similarity: number;
  sourceType: 'manuscript';
}

/**
 * Un extrait d'une note de lecture de l'auteur (`reading-notes/<clé>.md`).
 *
 * Ce n'est ni la source (le PDF) ni le texte de l'auteur (le manuscrit) :
 * c'est son commentaire d'une référence. Il sort donc par son propre canal,
 * `RetrievalSearchResult.readingNoteHits`, et reste nommé comme tel jusqu'à
 * l'affichage — une note de lecture n'est pas une citation de l'ouvrage.
 */
export interface ReadingNoteMappedSearchResult {
  chunk: {
    id: string;
    content: string;
    documentId: string | undefined;
    chunkIndex: number;
  };
  document: {
    id: string | undefined;
    /** Titre de la référence commentée, ou chemin de la note à défaut. */
    title: string | undefined;
    author: null;
    /** Clé de citation de la référence commentée. */
    bibtexKey: string;
  };
  source: {
    kind: 'reading-note';
    relativePath: string;
    noteId: string;
    citekey: string;
    zoteroKey?: string;
    tags: string[];
    sectionTitle?: string;
    /** Ligne 1-indexée dans le fichier de la note. */
    line: number;
  };
  similarity: number;
  sourceType: 'readingNotes';
}

/**
 * Union publique historique : les trois corpus externes. Le manuscrit en
 * est délibérément absent — `hitsToSources` (fusion-chat-service) mappe
 * `sourceType` sur un union plus étroit, et l'élargir touche une couche
 * qui n'appartient pas à ce chantier. Les extraits du manuscrit sortent
 * donc par `RetrievalSearchResult.manuscriptHits`, en attendant que
 * `BrainstormSource` gagne son quatrième `kind` (cf. docs/manuscript-corpus.md).
 */
export type MultiSourceSearchResult =
  | SecondarySearchResult
  | PrimaryMappedSearchResult
  | VaultMappedSearchResult;

/** Union interne : ce que le pipeline trie et inspecte réellement. */
type AnySearchResult =
  | MultiSourceSearchResult
  | ManuscriptMappedSearchResult
  | ReadingNoteMappedSearchResult;

/**
 * Per-corpus outcome (fusion 1.7 — partial-success first-class). Défini
 * avec l'interface commune des corpus (Path A′) ; réexporté ici pour les
 * appelants existants.
 */
export type { RetrievalSourceOutcome };

export interface RetrievalSearchResult {
  /** Combined, sort-and-slice'd hit list (the legacy return value). */
  hits: MultiSourceSearchResult[];
  /**
   * Extraits du manuscrit de l'auteur, séparés des trois corpus externes
   * pour que l'appelant ne puisse pas les confondre avec une source
   * d'archive ou de bibliographie (item 25 des audits).
   */
  manuscriptHits: ManuscriptMappedSearchResult[];
  /** Extraits des notes de lecture, séparés pour la même raison. */
  readingNoteHits: ReadingNoteMappedSearchResult[];
  /** Per-corpus outcomes (always 5: secondary, primary, vault, manuscript, readingNotes). */
  outcomes: RetrievalSourceOutcome[];
  /**
   * Événements de l'inspecteur de sécurité pour les chunks retournés (#8),
   * chacun porteur de son `chunkId` — l'appelant les rattache aux sources
   * qu'il affiche. Vide en l'absence de signalement.
   */
  securityEvents: SecurityEvent[];
}

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
  /** Extraits du manuscrit, séparés (cf. `RetrievalSearchResult`). */
  manuscriptHits: ManuscriptMappedSearchResult[];
  /** Extraits des notes de lecture, séparés (cf. `RetrievalSearchResult`). */
  readingNoteHits: ReadingNoteMappedSearchResult[];
  /** Événements de sécurité des chunks retournés (cf. `RetrievalSearchResult`). */
  securityEvents: SecurityEvent[];
  stats: RetrievalSearchStats;
  /** Per-corpus outcomes (fusion 1.7) — surfaced here so callers that
   *  use `searchWithStats` can render error banners alongside
   *  explainable-AI stats without a separate retrieval call. */
  outcomes: RetrievalSourceOutcome[];
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
  /**
   * When true, also search the author's own manuscript (if indexed).
   * Opt-in like `includeVault`: legacy callers keep PDF+Tropy behaviour.
   */
  includeManuscript?: boolean;
  /**
   * When true, also search the author's reading notes (if indexed).
   * Opt-in too — and the chat withholds it from cloud providers unless the
   * author consented (`rag.readingNotesCloudConsent`).
   */
  includeReadingNotes?: boolean;
}

// Dictionnaire de termes académiques FR→EN pour query expansion.
// Query expansion + embedding pooling moved to
// `backend/core/rag/retrievers/secondary-retriever.ts` (fusion 3.11).
// `ACADEMIC_TERMS_FR_TO_EN` is re-exported from there and consumed
// below by `warmupDictionaryEmbeddings`.

/**
 * Map a retrieved chunk onto the SourceInspector input shape. The
 * `source` field is purely informational for the audit log — we encode
 * the kind so post-hoc analysis can spot patterns ("most blocks are on
 * vault notes" → vault is the noisy source).
 */
function toInspectable(r: AnySearchResult): InspectableChunk {
  let source: string;
  if (r.sourceType === 'primary') {
    source = `tropy:${r.document.id ?? 'unknown'}`;
  } else if (r.sourceType === 'vault') {
    source = `obsidian:${r.source.noteId}`;
  } else if (r.sourceType === 'manuscript') {
    source = `manuscript:${r.source.relativePath}`;
  } else if (r.sourceType === 'readingNotes') {
    source = `reading-note:${r.source.relativePath}`;
  } else {
    source = `pdf:${r.document.id ?? r.document.bibtexKey ?? 'unknown'}`;
  }
  return {
    id: r.chunk.id,
    source,
    content: r.chunk.content,
  };
}

class RetrievalService {
  private vectorStore: VectorStore | EnhancedVectorStore | null = null;
  /**
   * Typed embedding provider (fusion 1.2b). Owned by this service: the
   * registry built in `configure()` is disposed in `clear()`. We keep the
   * registry handle so `dispose()` cascades to the underlying provider's
   * resources (HTTP agents, native handles).
   */
  private embedding: EmbeddingProvider | null = null;
  private registry: ProviderRegistry | null = null;
  private workspaceRoot: string | null = null;
  private vaultStore: ObsidianVaultStore | null = null;
  private manuscriptStore: ManuscriptStore | null = null;
  private warmupStarted = false;
  /**
   * Cached inspector mode for the current workspace. Refreshed on
   * `configure()` and on explicit `setInspectorMode()` calls (the IPC
   * handler for SecurityConfigSection writes through this method *and*
   * to disk so both sides stay in sync without file I/O per query).
   */
  private inspectorMode: InspectorMode = DEFAULT_INSPECTOR_MODE;

  /**
   * Wire the service to the project-scoped dependencies. Called by
   * pdf-service.init() so both services share the same vector store.
   *
   * The embedding provider is built locally from the active workspace
   * config — retrieval-service owns its own ProviderRegistry lifecycle.
   * Calling `configure()` again or `clear()` disposes the previous one.
   *
   * Note: the embedding cache is module-scoped and is intentionally NOT
   * reset here — query embeddings don't depend on which project is open.
   */
  configure(deps: {
    vectorStore: VectorStore | EnhancedVectorStore;
    workspaceRoot?: string;
  }): void {
    this.vectorStore = deps.vectorStore;
    this.workspaceRoot = deps.workspaceRoot ?? null;

    // Build the typed embedding provider from the active config. Dispose
    // any previous registry to release HTTP agents / native handles.
    void this.disposePreviousRegistry();
    try {
      this.registry = createRegistryFromClioDeckConfig(configManager.getLLMConfig());
      this.embedding = this.registry.getEmbedding();
    } catch (e) {
      console.warn('[retrieval] failed to build embedding provider:', e);
      this.registry = null;
      this.embedding = null;
    }

    // Invalidate any previously opened vault store — the project may have
    // changed underneath us.
    this.vaultStore?.close();
    this.vaultStore = null;
    this.manuscriptStore?.close();
    this.manuscriptStore = null;

    // Le corpus manuscrit suit le même projet : rattacher ici évite que
    // l'indexeur garde un handle WAL sur le `brain.db` du projet précédent.
    manuscriptIndexService.configure(this.workspaceRoot);
    readingNotesIndexService.configure(this.workspaceRoot);

    // Fire-and-forget warmup: pre-embed frequent FR↔EN translations so the
    // first real query hits a warm cache. Only runs once per process.
    if (!this.warmupStarted) {
      this.warmupStarted = true;
      void this.warmupDictionaryEmbeddings();
    }

    // Refresh the inspector mode for the new workspace. Best-effort —
    // a missing or unreadable config falls back to `warn`.
    void this.refreshInspectorMode();
  }

  private async disposePreviousRegistry(): Promise<void> {
    const prev = this.registry;
    this.registry = null;
    this.embedding = null;
    if (prev) {
      await prev.dispose().catch(() => undefined);
    }
  }

  private async refreshInspectorMode(): Promise<void> {
    if (!this.workspaceRoot) {
      this.inspectorMode = DEFAULT_INSPECTOR_MODE;
      return;
    }
    try {
      const cfg = await readWorkspaceConfig(this.workspaceRoot);
      const m = cfg.security?.sourceInspectorMode;
      this.inspectorMode = m ?? DEFAULT_INSPECTOR_MODE;
    } catch {
      this.inspectorMode = DEFAULT_INSPECTOR_MODE;
    }
  }

  /**
   * Public getter for the IPC handler `fusion:security:get-mode`.
   */
  getInspectorMode(): InspectorMode {
    return this.inspectorMode;
  }

  /**
   * Public setter — used by the IPC handler `fusion:security:set-mode`
   * after the SecurityConfigSection radio changes. Caller is responsible
   * for persisting to `workspace.config.json`; this method just updates
   * the in-memory cache.
   */
  setInspectorMode(mode: InspectorMode): void {
    this.inspectorMode = mode;
  }

  clear(): void {
    this.vectorStore = null;
    void this.disposePreviousRegistry();
    // Embedding cache persists across clear() — see constructor comment.
    this.workspaceRoot = null;
    this.vaultStore?.close();
    this.vaultStore = null;
    this.manuscriptStore?.close();
    this.manuscriptStore = null;
    // Projet fermé : le handle des notes de lecture ne doit pas garder le
    // `brain.db` de l'ancien projet verrouillé.
    readingNotesIndexService.clear();
  }

  private getProviderId(): string | undefined {
    // Stable provider id from the typed embedding (e.g. `ollama-embed:nomic-embed-text`).
    return this.embedding?.id;
  }

  /**
   * Embed a single query through the typed provider. Returns a Float32Array
   * (the rest of the pipeline — HNSW, BM25 — expects this shape).
   */
  private async embedQuery(text: string): Promise<Float32Array> {
    if (!this.embedding) {
      throw new Error(
        'retrieval-service: embedding provider not configured (call configure() first)'
      );
    }
    const [vec] = await this.embedding.embed([text]);
    return Float32Array.from(vec);
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
          const emb = await this.embedQuery(term);
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

  private getManuscriptStore(): ManuscriptStore | null {
    if (this.manuscriptStore) return this.manuscriptStore;
    if (!this.workspaceRoot) return null;
    const dbPath = manuscriptStorePath(this.workspaceRoot);
    if (!fs.existsSync(dbPath)) return null;
    try {
      // Dimension omise : elle n'est vérifiée qu'à l'insertion, et la
      // recherche n'en a pas besoin.
      this.manuscriptStore = new ManuscriptStore({ dbPath });
      return this.manuscriptStore;
    } catch (e) {
      console.warn('[retrieval] failed to open manuscript store:', e);
      return null;
    }
  }

  /**
   * Fournisseur d'embeddings actif, ou `null` s'il n'a pas pu être
   * construit (Ollama éteint, configuration incomplète). Exposé pour
   * l'indexation du manuscrit, qui doit embarquer avec le MÊME modèle que
   * celui qui embarquera les requêtes — sinon les cosinus comparent des
   * espaces différents.
   */
  getEmbeddingProvider(): EmbeddingProvider | null {
    return this.embedding;
  }

  /**
   * Reconstruit le fournisseur d'embeddings depuis la configuration.
   *
   * Changer de fournisseur écrivait la config sans toucher au registre :
   * le service continuait d'embarquer avec l'ancien modèle jusqu'au
   * redémarrage, sans que rien ne le dise. Les requêtes et l'index se
   * retrouvaient alors dans deux espaces vectoriels différents — et
   * `cosine()` compare sur la longueur minimale, donc sans erreur.
   */
  rebuildEmbeddingProvider(): void {
    void this.disposePreviousRegistry();
    try {
      this.registry = createRegistryFromClioDeckConfig(configManager.getLLMConfig());
      this.embedding = this.registry.getEmbedding();
      console.log('🔄 [retrieval] fournisseur d’embeddings reconstruit');
    } catch (e) {
      console.warn('[retrieval] failed to rebuild embedding provider:', e);
      this.registry = null;
      this.embedding = null;
    }
  }

  private ensureReady(): void {
    if (!this.vectorStore || !this.embedding) {
      throw new Error(
        'RetrievalService not configured. Call configure() after initializing pdf-service.'
      );
    }
  }

  private async getQueryEmbedding(query: string): Promise<Float32Array> {
    const providerId = this.getProviderId();
    const cached = queryEmbeddingCache.get(query, providerId);
    if (cached) return cached;
    const embedding = await this.embedQuery(query);
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
    const { hits, manuscriptHits, readingNoteHits, outcomes, securityEvents } = await this.search(q);
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
      manuscriptHits,
      readingNoteHits,
      securityEvents,
      outcomes,
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

  async search(q: RetrievalQuery): Promise<RetrievalSearchResult> {
    this.ensureReady();

    const searchStart = Date.now();
    const ragConfig = configManager.getRAGConfig();
    const topK = q.topK || ragConfig.topK;
    const threshold = q.threshold || ragConfig.similarityThreshold;
    const scope = corporaInScope(q);

    if (DEBUG) {
      console.log(
        `🔍 [PDF-SERVICE] Multi-source search: corpora=${[...scope].join(',')}, topK=${topK}`
      );
    }

    // Partial-success first-class (claw-code lesson 6.3): an error in one
    // corpus must not silently lose the others — `fanOutCorpora` records
    // one outcome per corpus and keeps going.
    const { hits: allSourceResults, outcomes } = await fanOutCorpora(
      this.corpusRetrievers(),
      scope,
      q.query,
      {
        topK,
        threshold,
        documentIds: q.documentIds,
        collectionKeys: q.collectionKeys,
      },
      (corpus, error) => {
        console.warn(`⚠️ [PDF-SERVICE] ${corpus} corpus search failed:`, error);
      }
    );

    if (DEBUG) {
      for (const o of outcomes.filter((x) => x.attempted)) {
        console.log(`🔍 [PDF-SERVICE] ${o.source}: ${o.hitCount} results`);
      }
    }

    // Places réservées au manuscrit : sans elles, la bibliographie prend
    // tout le `topK` et le corpus manuscrit — indexé à chaque sauvegarde —
    // n'atteint jamais l'assistant.
    const sortedResults = selectWithManuscriptQuota(allSourceResults, topK);

    // Run the inspector before returning chunks to the caller. In `warn`
    // mode this is a logging side-effect; in `audit`/`block` it filters
    // chunks the inspector deems unsafe.
    const { results: inspectedResults, securityEvents } =
      this.inspectAndFilter(sortedResults);

    if (DEBUG) {
      console.log(
        `🔍 [PDF-SERVICE] Final combined results: ${inspectedResults.length} (from ${allSourceResults.length} total, ${sortedResults.length - inspectedResults.length} blocked by inspector)`
      );
      console.log(
        `🔍 [PDF-SERVICE] Total search duration: ${Date.now() - searchStart}ms`
      );
    }

    // Séparation au retour : les appelants historiques reçoivent les trois
    // corpus externes ; le manuscrit et les notes de lecture sortent à part.
    const externalHits = inspectedResults.filter(
      (r): r is MultiSourceSearchResult =>
        r.sourceType !== 'manuscript' && r.sourceType !== 'readingNotes'
    );
    const manuscriptHits = inspectedResults.filter(
      (r): r is ManuscriptMappedSearchResult => r.sourceType === 'manuscript'
    );
    const readingNoteHits = inspectedResults.filter(
      (r): r is ReadingNoteMappedSearchResult => r.sourceType === 'readingNotes'
    );

    return {
      hits: externalHits,
      manuscriptHits,
      readingNoteHits,
      securityEvents,
      outcomes,
    };
  }

  /**
   * Pass each retrieved chunk through the SourceInspector. Events are
   * appended to `.cliodeck/security-events.jsonl` (best-effort —
   * persistence failures must not break retrieval). In `warn` mode the
   * input list is returned unchanged; in `audit`/`block` mode chunks
   * flagged as injection attempts are filtered out.
   */
  private inspectAndFilter(results: AnySearchResult[]): {
    results: AnySearchResult[];
    /**
     * Événements émis pour les chunks RETOURNÉS (#8) : le badge de la
     * surface de chat doit pouvoir pointer la source affichée. Les
     * événements des chunks bloqués sont journalisés mais pas remontés —
     * un chunk absent n'a pas de badge à porter.
     */
    securityEvents: SecurityEvent[];
  } {
    if (results.length === 0) return { results, securityEvents: [] };
    const logPath = this.workspaceRoot
      ? workspaceFiles(this.workspaceRoot).securityEventsLog
      : null;
    const collected: SecurityEvent[] = [];
    const inspector = new SourceInspector({
      mode: this.inspectorMode,
      onEvent: (e) => {
        collected.push(e);
        if (logPath) {
          void appendSecurityEvent(logPath, e).catch((err) => {
            console.warn('[retrieval] security event log failed:', err);
          });
        }
      },
    });
    const inspectables: InspectableChunk[] = results.map((r) =>
      toInspectable(r)
    );
    const outcome = inspector.inspect(inspectables);
    const blockedIds = new Set(outcome.blocked.map((c) => c.id));
    const kept =
      blockedIds.size === 0
        ? results
        : results.filter((r) => !blockedIds.has(r.chunk.id));
    const keptIds = new Set(kept.map((r) => r.chunk.id));
    return {
      results: kept,
      securityEvents: collected.filter((e) => keptIds.has(e.chunkId)),
    };
  }

  /**
   * Les cinq corpus, sous la forme commune (Path A′). Chaque adaptateur
   * appelle la méthode du corpus AU MOMENT de la recherche — pas une
   * référence capturée — pour que les tests puissent la remplacer.
   *
   * Ajouter un corpus : un adaptateur ici, une valeur dans `CorpusId`.
   */
  private corpusRetrievers(): CorpusRetriever<AnySearchResult>[] {
    return [
      {
        corpus: 'secondary',
        search: async (query, o) => {
          const results = await this.searchSecondary(query, o);
          return results.map(
            (r: SearchResult): SecondarySearchResult => ({
              ...r,
              sourceType: 'secondary' as const,
            })
          );
        },
      },
      { corpus: 'primary', search: (query, o) => this.searchPrimary(query, o) },
      { corpus: 'vault', search: (query, o) => this.searchVault(query, o) },
      { corpus: 'manuscript', search: (query, o) => this.searchManuscript(query, o) },
      { corpus: 'readingNotes', search: (query, o) => this.searchReadingNotes(query, o) },
    ];
  }

  private async searchReadingNotes(
    query: string,
    options: { topK: number; threshold: number }
  ): Promise<ReadingNoteMappedSearchResult[]> {
    const store = readingNotesIndexService.getSearchStore();
    if (!store) return [];
    const embedding = await this.getQueryEmbedding(query);
    const hits = store.search(embedding, query, options.topK);
    const mapped = hits.map(
      (h): ReadingNoteMappedSearchResult => ({
        chunk: {
          id: h.chunk.id,
          content: h.chunk.content,
          documentId: h.note.id,
          chunkIndex: h.chunk.chunkIndex,
        },
        document: {
          id: h.note.id,
          title: h.note.title || h.note.relativePath,
          author: null,
          bibtexKey: h.note.citekey,
        },
        source: {
          kind: 'reading-note',
          relativePath: h.note.relativePath,
          noteId: h.note.id,
          citekey: h.note.citekey,
          zoteroKey: h.note.zoteroKey,
          tags: h.note.tags,
          sectionTitle: h.chunk.sectionTitle,
          line: h.chunk.line,
        },
        // Contrat Path A′ : jamais le RRF, qui plafonne à 1/61.
        similarity: relevanceScore({
          dense: h.signals.dense,
          sparseRank: h.signals.lexicalRank,
        }),
        sourceType: 'readingNotes',
      })
    );
    // Pas de repli sous le seuil, comme le vault et le manuscrit : écrites
    // par l'auteur dans sa langue, les notes n'ont pas l'excuse de l'écart
    // de langue ; et pas de quota (choix de l'auteur) — elles concourent
    // à armes égales avec les sources.
    return applyThreshold(mapped, options.threshold, 0);
  }

  private async searchPrimary(
    query: string,
    options: { topK: number; threshold: number }
  ): Promise<PrimaryMappedSearchResult[]> {
    const primaryResults = await tropyService.search(query, options);
    return primaryResults.map(
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
  }

  private async searchVault(
    query: string,
    options: { topK: number; threshold: number }
  ): Promise<VaultMappedSearchResult[]> {
    const store = this.getVaultStore();
    if (!store) return [];
    const embedding = await this.getQueryEmbedding(query);
    const hits = store.search(embedding, query, options.topK);
    const mapped = hits.map(
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
        // `h.score` est un RRF (maximum 1/61 ≈ 0,016) : publié tel quel, il
        // classait toute note derrière tout extrait de bibliographie ou
        // d'archive, et le vault n'obtenait une place que s'il en restait.
        // C'est le défaut corrigé pour le manuscrit en rc.4, resté ici.
        similarity: relevanceScore({
          dense: h.signals.dense,
          sparseRank: h.signals.lexicalRank,
        }),
        sourceType: 'vault',
      })
    );
    // Pas de repli sous le seuil : les notes sont écrites par l'historien,
    // dans sa langue — une note qui ne franchit pas le seuil n'a rien à dire,
    // et la montrer quand même prendrait la place d'une source pertinente.
    return applyThreshold(mapped, options.threshold, 0);
  }

  private async searchManuscript(
    query: string,
    options: { topK: number; threshold: number }
  ): Promise<ManuscriptMappedSearchResult[]> {
    const store = this.getManuscriptStore();
    if (!store) return [];
    const embedding = await this.getQueryEmbedding(query);
    const hits = store.search(embedding, query, options.topK);
    const mapped = hits.map(
      (h): ManuscriptMappedSearchResult => ({
        chunk: {
          id: h.chunk.id,
          content: h.chunk.content,
          documentId: h.chunk.chapterId,
          chunkIndex: h.chunk.chunkIndex,
        },
        document: {
          id: h.chapter.id,
          title: h.chapter.title || h.chapter.relativePath,
          author: null,
          bibtexKey: null,
        },
        source: {
          kind: 'manuscript-chapter',
          relativePath: h.chapter.relativePath,
          chapterId: h.chapter.id,
          sectionTitle: h.chunk.sectionTitle,
          line: h.chunk.line,
        },
        // `h.score` est un score RRF (fusion dense+BM25, K=60) : son
        // maximum arithmétique vaut 1/61 ≈ 0,016, très en dessous du seuil
        // cosinus des autres corpus (0,12 par défaut). Publié tel quel, il
        // classait TOUT extrait du manuscrit sous TOUT extrait externe, et
        // le `slice(0, topK)` l'éliminait systématiquement.
        //
        // On publie donc la pertinence du contrat commun (`relevance.ts`) :
        // le cosinus réel, relevé par le rang lexical quand le mot-clé est
        // une meilleure preuve. Le RRF garde son rôle, meilleur : il a déjà
        // décidé QUELS extraits le store renvoie.
        similarity: relevanceScore({
          dense: h.signals.dense,
          sparseRank: h.signals.lexicalRank,
        }),
        sourceType: 'manuscript',
      })
    );
    // Pas de repli sous le seuil : le quota de `selectWithManuscriptQuota`
    // réserve des places au manuscrit « quand il a quelque chose à dire ».
    // Sans seuil, il en avait toujours — et prenait ses places même hors
    // sujet.
    return applyThreshold(mapped, options.threshold, 0);
  }

  /**
   * Thin delegate over `SecondaryRetriever` (fusion 3.11). The retrieval
   * pipeline for the secondary corpus — query expansion, embedding
   * fan-out, hybrid HNSW+BM25 search, threshold + cross-language
   * fallback — was extracted into `backend/core/rag/retrievers/
   * secondary-retriever.ts` to make each step testable in isolation.
   * This method now resolves the RAG config, builds the retriever, and
   * forwards.
   */
  private async searchSecondary(
    query: string,
    options?: {
      topK?: number;
      threshold?: number;
      documentIds?: string[];
      collectionKeys?: string[];
    }
  ): Promise<SearchResult[]> {
    const ragConfig = configManager.getRAGConfig();
    const topK = options?.topK || ragConfig.topK;
    const threshold = options?.threshold || ragConfig.similarityThreshold;

    // A20: inject user dictionary for query expansion if configured
    const userDict = ragConfig.queryExpansionDictionary;
    const expandQuery = userDict
      ? createExpandQueryFrEn(userDict)
      : undefined; // uses default expandQueryFrEn

    const retriever = new SecondaryRetriever({
      vectorStore: this.vectorStore!,
      getQueryEmbedding: (q) => this.getQueryEmbedding(q),
      expandQuery,
    });
    return retriever.search(query, {
      topK,
      threshold,
      documentIds: options?.documentIds,
      collectionKeys: options?.collectionKeys,
    });
  }
}

export const retrievalService = new RetrievalService();
