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
  CROSS_LANGUAGE_FALLBACK,
  relevanceScore,
} from '../../../backend/core/rag/relevance.js';
import type {
  PDFDocument,
  SearchResult,
} from '../../../backend/types/pdf-document.js';
import type {
  PrimarySourceSearchResult,
  PrimarySourceDocument,
} from '../../../backend/core/vector-store/PrimarySourcesVectorStore.js';
import { ObsidianVaultStore } from '../../../backend/integrations/obsidian/ObsidianVaultStore.js';
import { obsidianStorePath } from '../../../backend/integrations/obsidian/ObsidianVaultIndexer.js';
import {
  authorTextInVault,
  isExcludedFromVault,
  makeOrphanAuthorTextTest,
} from '../../../backend/integrations/obsidian/author-text-exclusions.js';
import {
  ManuscriptStore,
  manuscriptStorePath,
} from '../../../backend/core/vector-store/ManuscriptStore.js';
import { manuscriptIndexService } from './manuscript-index-service.js';
import { readingNotesIndexService } from './reading-notes-index-service.js';
import { selectWithOwnTextBands } from './retrieval-quota.js';
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
import { readWorkspaceConfig, WorkspaceConfigError } from '../../../backend/core/workspace/config.js';
import { createRegistryFromClioDeckConfig } from '../../../backend/core/llm/providers/cliodeck-config-adapter.js';
import type { EmbeddingProvider } from '../../../backend/core/llm/providers/base.js';
import { resolveEmbeddingProvider } from '../../../backend/core/llm/providers/fallback.js';
import type { ProviderRegistry } from '../../../backend/core/llm/providers/registry.js';
import { ProjectChangedError } from '../../../backend/types/project-handle.js';

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
 * `clear()` calls. Entries are keyed by provider id, model and dimension
 * (`providerKey`): a model change misses the cache instead of serving
 * the previous model's vectors.
 */
const queryEmbeddingCache = new QueryEmbeddingCache(2000, 10);

/**
 * Ce qu'une fermeture de magasin attend au plus des recherches en vol (`drainSearches`). L'embedding
 * d'une requête prend moins d'une seconde ; un modèle qui se charge peut dépasser ce délai, et la
 * recherche s'arrête alors proprement (`project-changed`), sa requête d'embedding coupée (J9).
 */
export const SEARCH_DRAIN_MS = 5_000;

/**
 * Ce qu'une recherche capture à son entrée (S04-1-14) : le magasin de son projet, et de quoi savoir,
 * après chaque attente, qu'il n'a pas été rendu depuis (fermeture du projet, bascule).
 */
interface SearchCapture {
  readonly store: VectorStore | EnhancedVectorStore;
  /** Le numéro du magasin à l'entrée de la recherche (`storeGeneration`). */
  readonly generation: number;
  /**
   * Ce que reçoit chaque embedding de la recherche (J9) : abandonné quand le magasin est rendu, ou
   * quand l'appelant arrête (« Arrêter » coupe le tour du chat).
   */
  readonly signal: AbortSignal;
  /**
   * Lève `ProjectChangedError` si le magasin a été rendu depuis l'entrée de la recherche, puis la
   * raison du signal de l'appelant s'il a arrêté : une recherche arrêtée n'est pas une panne.
   */
  assertCurrent(): void;
  /**
   * Par texte embarqué, ce qu'a trouvé la première consultation du cache dans cette recherche : `true`
   * si l'embedding y était déjà avant elle (S04-2-5). `fanOutCorpora` interroge les corpus l'un après
   * l'autre : le premier qui embarque la question la range dans le cache, et les suivants du même tour
   * (vault, manuscrit, notes de lecture) l'y trouvent. Seule la première consultation dit donc l'état
   * d'avant le tour ; sans cette règle, une question posée pour la première fois avec plusieurs corpus
   * dans la portée afficherait « (cache) ».
   */
  readonly cacheLookups: Map<string, boolean>;
}

/**
 * 'secondary'  = bibliography (PDFs), 'primary' = Tropy archives,
 * 'both'       = both bibliography + primary corpora,
 * 'vault'      = Obsidian vault only (skip primary and secondary),
 * 'manuscript' = the historian's own text only (item 25 des audits).
 * Note: non-exclusive values compose with the separate `includeVault` and
 * `includeManuscript` opt-ins to mix notes / own text in alongside
 * primary/secondary.
 */
export type SourceType = 'secondary' | 'primary' | 'both' | 'vault' | 'manuscript' | 'readingNotes';

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
    /**
     * Un compte par corpus, manuscrit et notes de lecture compris : ce que
     * `totalResults` (sources externes seules) ne dit pas. `hitCount` après
     * le seuil du corpus, `selectedCount` après la bande et l'inspecteur.
     */
    corpora: Array<{
      source: RetrievalSourceOutcome['source'];
      attempted: boolean;
      ok: boolean;
      hitCount: number;
      selectedCount: number;
    }>;
    /** Posé par l'appelant qui construit le prompt (`fusion-chat-service`). */
    contextChars?: {
      total: number;
      sources: number;
      manuscript: number;
      readingNotes: number;
    };
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

/** Ce qu'il faut d'un document pour le nommer dans un prompt. */
export interface SelectedDocumentLabel {
  title: string;
  author?: string;
  year?: string;
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
  /**
   * Largeur de la bande du manuscrit (`retrieval-quota.ts`), en places.
   * Omise : la part par défaut de `topK`. L'appelant l'élargit pour une
   * question de rappel ou la portée « manuscrit seul », ou la réduit à zéro
   * pour écarter le manuscrit du tri sans cesser de l'interroger.
   */
  manuscriptSlots?: number;
  /** Même chose pour les notes de lecture, l'autre corpus à la voix de l'auteur. */
  readingNoteSlots?: number;
  /**
   * Celui de l'appelant : le tour du chat (« Arrêter »), une recette. Abandonné, l'embedding de la
   * requête est coupé, et la recherche rejette par sa raison au lieu de rendre des corpus en échec (J9).
   */
  signal?: AbortSignal;
}

// Dictionnaire de termes académiques FR→EN pour query expansion.
// Query expansion + embedding pooling moved to
// `backend/core/rag/retrievers/secondary-retriever.ts` (fusion 3.11).
// Ses termes ne sont plus embarqués à l'ouverture (J11) : l'expansion embarque la question
// entière, réécrite, et un terme seul en cache ne servait qu'à une question réduite à ce terme.
// Ils chargeaient aussi le modèle embarqué de la recherche : `preloadEmbeddedEngine` le fait.

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
  /**
   * Cached inspector mode for the current workspace. Refreshed on
   * `configure()` and on explicit `setInspectorMode()` calls (the IPC
   * handler for SecurityConfigSection writes through this method *and*
   * to disk so both sides stay in sync without file I/O per query).
   */
  private inspectorMode: InspectorMode = DEFAULT_INSPECTOR_MODE;

  /**
   * Recherches en vol (S04-1-14). Une recherche prend le magasin, puis attend l'embedding de sa
   * requête : la fermeture du projet passait pendant ce temps, et la recherche lisait ensuite un
   * magasin fermé (« The database connection is not open »). Une fermeture les attend donc
   * (`drainSearches`), comme `pdfService` attend ses indexations. Chacune avec le numéro du magasin
   * qu'elle a pris : une fermeture n'attend que celles du magasin qu'elle rend.
   */
  private inFlightSearches = new Map<Promise<unknown>, number>();
  /**
   * Change chaque fois que le magasin est rendu (`drainSearches`, `clear`, `configure`) : une
   * recherche restée au-delà du délai s'arrête à sa prochaine attente, sans lire un magasin fermé ni
   * répondre avec celui du projet suivant.
   */
  private storeGeneration = 0;
  /**
   * Abandonné quand le magasin de `storeGeneration` est rendu (`releaseStore`) : la requête
   * d'embedding d'une recherche restée en vol au-delà du délai d'une fermeture est coupée avec lui.
   * Elle restait ouverte jusqu'au redémarrage : la connexion à Ollama n'a pas de délai (J9).
   */
  private storeRelease = new AbortController();

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
    this.releaseStore();
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
    void this.preloadEmbeddedEngine();

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

    // Refresh the inspector mode for the new workspace. Best-effort —
    // a missing config falls back to `warn`, an unreadable one to `block`.
    void this.refreshInspectorMode();
  }

  /**
   * Charge le modèle d'embeddings embarqué de la recherche, sans rien calculer ni envoyer : la
   * première question n'attend pas son chargement. Ce registre a son propre client llama.cpp (le
   * partage d'un GGUF entre clients est à venir, L08-16) : `warmup query`, chez `pdfService`, charge
   * celui de l'indexeur. Les 23 termes du dictionnaire d'expansion, embarqués à la première ouverture,
   * le chargeaient en passant ; ils ne partent plus (J11).
   *
   * Le moteur embarqué seul : Ollama tient son modèle dans son démon, que `warmup query` a chargé, et
   * le `healthCheck` d'un fournisseur distant peut envoyer un texte (celui de Gemini embarque
   * « ping »). En réglage « auto », le repli sonde Ollama (la liste de ses modèles, aucun texte).
   * Rien ne s'inscrit au journal d'usage : aucun embedding n'est calculé.
   */
  private async preloadEmbeddedEngine(): Promise<void> {
    const embedding = this.embedding;
    if (!embedding) return;
    try {
      const chosen = await resolveEmbeddingProvider(embedding);
      // Registre libéré pendant le sondage (projet fermé, réglages changés) : le modèle chargé ici
      // resterait à un client que plus rien ne libère avant la sortie de l'app.
      if (this.embedding !== embedding || chosen.id !== 'embedded-embedding') return;
      await chosen.healthCheck();
    } catch (e) {
      // Best-effort : la première question chargera le modèle, et dira l'échec s'il y en a un.
      console.warn('[retrieval] préchargement du modèle d’embeddings embarqué impossible :', e);
    }
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
    } catch (e) {
      // Absent, il n'y a pas de choix à respecter. Illisible, le choix de l'auteur est inconnu : le plus
      // strict s'applique tant que le fichier ne se lit pas (D15), et la notification de `configIssue`
      // le dit à l'ouverture. Avertir trahissait un auteur qui avait choisi Bloquer.
      const absent = e instanceof WorkspaceConfigError && e.kind === 'absent';
      console.warn(
        `[retrieval] mode de sécurité ${absent ? 'par défaut' : 'le plus strict'} :`,
        e instanceof Error ? e.message : String(e)
      );
      this.inspectorMode = absent ? DEFAULT_INSPECTOR_MODE : 'block';
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

  /**
   * Le magasin va se fermer (fermeture du projet, ou reprise de `pdfService.init`) : plus aucune
   * recherche n'y entre, et celles en vol finissent, au plus `timeoutMs`. Au-delà, la fermeture a lieu
   * quand même (pas d'attente sans sortie) : celles qui restent s'arrêtent à leur prochaine attente sur
   * `project-changed`, sans lire le magasin fermé. Ne lève pas.
   *
   * Seules celles du magasin courant sont attendues. Une recherche d'un magasin déjà rendu ne lit
   * plus aucun magasin : l'attendre retardait chaque bascule de 5 s. Et le magasin rendu, la requête
   * d'embedding qu'elle attendait encore est coupée (`releaseStore`) : sans délai côté Ollama, elle
   * restait ouverte jusqu'au redémarrage (J9).
   */
  async drainSearches(timeoutMs = SEARCH_DRAIN_MS): Promise<void> {
    this.vectorStore = null;
    const generation = this.storeGeneration;
    const pending = [...this.inFlightSearches]
      .filter(([, searchGeneration]) => searchGeneration === generation)
      .map(([run]) => run);
    if (pending.length > 0) {
      console.log(
        `⏳ ${pending.length} recherche(s) en vol — attente avant fermeture du vector store`
      );
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const drained = Promise.allSettled(pending).then(() => 'drained' as const);
      const outcome = await Promise.race([drained, timeout]);
      if (timer) clearTimeout(timer);
      if (outcome === 'timeout') {
        console.warn(
          `⚠️ Recherche(s) toujours en vol après ${timeoutMs}ms — fermeture du store malgré tout`
        );
      }
    }
    this.releaseStore();
  }

  /**
   * Le magasin est rendu : les recherches qui l'avaient pris s'arrêtent à leur prochaine attente
   * (`project-changed`), et leur requête d'embedding est coupée tout de suite (J9). Le numéro change
   * avant la coupure : une recherche que la coupure réveille se voit déjà hors de son magasin.
   */
  private releaseStore(): void {
    this.storeGeneration++;
    this.storeRelease.abort();
    this.storeRelease = new AbortController();
  }

  clear(): void {
    this.releaseStore();
    this.vectorStore = null;
    void this.disposePreviousRegistry();
    // Embedding cache persists across clear() — see constructor comment.
    this.workspaceRoot = null;
    this.vaultStore?.close();
    this.vaultStore = null;
    this.manuscriptStore?.close();
    this.manuscriptStore = null;
    // Projet fermé : le handle des notes de lecture ne doit pas garder le
    // `brain.db` de l'ancien projet verrouillé. Celui du corpus manuscrit non
    // plus : `configure` le détache, `clear` l'oubliait (S02-1-17).
    readingNotesIndexService.clear();
    manuscriptIndexService.clear();
  }

  /**
   * Le fournisseur qui fera l'embedding. En mode « auto », le repli choisit au moment de l'appel :
   * on le fait choisir d'abord, pour que la clé du cache et le vecteur viennent du même modèle.
   * `signal` : abandonné pendant le sondage d'Ollama, le choix rejette sans attendre sa réponse (J9).
   */
  private async resolveEmbedding(signal?: AbortSignal): Promise<EmbeddingProvider> {
    if (!this.embedding) {
      throw new Error(
        'retrieval-service: embedding provider not configured (call configure() first)'
      );
    }
    // Le repli arrive enveloppé par le décorateur du journal : `resolveEmbeddingProvider` le traverse.
    return resolveEmbeddingProvider(this.embedding, signal);
  }

  private static providerKey(provider: EmbeddingProvider): string {
    // `id` est une constante par famille (`'ollama-embedding'`, quel que soit le modèle) : seul, il
    // resservait après un changement de modèle les vecteurs de l'ancien. Le modèle et la dimension
    // complètent la clé.
    return `${provider.id}:${provider.model}:${provider.dimension}`;
  }

  /**
   * Embed a single query through the typed provider. Returns a Float32Array
   * (the rest of the pipeline — HNSW, BM25 — expects this shape).
   */
  private static async embedQuery(
    provider: EmbeddingProvider,
    text: string,
    signal: AbortSignal
  ): Promise<Float32Array> {
    const [vec] = await provider.embed([text], { signal });
    return Float32Array.from(vec);
  }

  /**
   * Le magasin du coffre, `null` sans brain.db (rien d'indexé). Un fichier qui existe mais ne
   * s'ouvre pas (base abîmée, verrou) lève : `fanOutCorpora` dit alors le coffre en échec. Rendre
   * `null` le faisait passer pour vide, « Vault 0 » (S04-1-3, comme E2 pour les archives). Rien
   * n'est gardé de l'échec : la recherche suivante réessaie, un verrou passager ne dure pas.
   */
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
      throw e;
    }
  }

  /** Le magasin du manuscrit : comme `getVaultStore`, un fichier qui ne s'ouvre pas lève (S04-1-3). */
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
      throw e;
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

  /** Le magasin de la recherche, ou une erreur si le service n'est pas configuré. */
  private ensureReady(): VectorStore | EnhancedVectorStore {
    if (!this.vectorStore || !this.embedding) {
      throw new Error(
        'RetrievalService not configured. Call configure() after initializing pdf-service.'
      );
    }
    return this.vectorStore;
  }

  /**
   * Le magasin pris à l'entrée d'une recherche, le numéro qu'il avait alors, et le signal de ses
   * embeddings : celui du magasin, joint à celui de l'appelant (J9).
   */
  private captureStore(store: VectorStore | EnhancedVectorStore, callerSignal?: AbortSignal): SearchCapture {
    const generation = this.storeGeneration;
    const released = this.storeRelease.signal;
    return {
      store,
      generation,
      signal: callerSignal ? AbortSignal.any([released, callerSignal]) : released,
      assertCurrent: () => {
        if (this.storeGeneration !== generation) throw new ProjectChangedError();
        callerSignal?.throwIfAborted();
      },
      cacheLookups: new Map(),
    };
  }

  /**
   * Après l'attente de l'embedding, le magasin que le corpus va lire a pu être rendu : `captured` le
   * vérifie avant (S04-1-14).
   */
  private async getQueryEmbedding(query: string, captured: SearchCapture): Promise<Float32Array> {
    const provider = await this.resolveEmbedding(captured.signal);
    const providerId = RetrievalService.providerKey(provider);
    let embedding = queryEmbeddingCache.get(query, providerId);
    if (!captured.cacheLookups.has(query)) captured.cacheLookups.set(query, embedding !== undefined);
    if (!embedding) {
      embedding = await RetrievalService.embedQuery(provider, query, captured.signal);
      queryEmbeddingCache.set(query, embedding, providerId);
    }
    captured.assertCurrent();
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
    const captured = this.captureStore(this.ensureReady(), q.signal);
    const { hits, manuscriptHits, readingNoteHits, outcomes, securityEvents } =
      await this.trackSearch(q, captured);
    const searchMs = Date.now() - t0;
    // « (cache) » au panneau d'explication : l'embedding de la question elle-même était déjà là. Sans
    // consultation (sources primaires seules : Tropy embarque de son côté), rien ne vient du cache.
    const cacheHit = captured.cacheLookups.get(q.query) === true;

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

    // Ce qui a vraiment atteint le prompt, par corpus. `outcomes` dit ce que
    // chaque corpus a rendu ; la bande du manuscrit et l'inspecteur passent
    // ensuite, et l'écart entre les deux est précisément la part invisible
    // que l'utilisateur ne pouvait pas voir (docs/poids-du-manuscrit.md).
    const selectedBySource = new Map<string, number>();
    for (const r of [...hits, ...manuscriptHits, ...readingNoteHits]) {
      selectedBySource.set(r.sourceType, (selectedBySource.get(r.sourceType) ?? 0) + 1);
    }
    const corpora = outcomes.map((o) => ({
      source: o.source,
      attempted: o.attempted,
      ok: o.ok,
      hitCount: o.hitCount,
      selectedCount: selectedBySource.get(o.source) ?? 0,
    }));

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
          cacheHit,
          sourceType,
          documents: Array.from(documentMap.values()).slice(0, 10),
          corpora,
        },
        timing: { searchMs },
      },
    };
  }

  /**
   * Titre, auteur et année des documents de bibliographie désignés. Sert à
   * nommer à l'assistant la sélection de l'utilisateur ; un identifiant
   * inconnu est passé sous silence, et rien ne lève — c'est du confort de
   * prompt, pas de la recherche.
   */
  describeDocuments(documentIds: string[]): SelectedDocumentLabel[] {
    const store = this.vectorStore;
    if (!store) return [];
    const labels: SelectedDocumentLabel[] = [];
    for (const id of documentIds) {
      try {
        const doc = store.getDocument(id) as PDFDocument | null;
        if (doc) labels.push({ title: doc.title, author: doc.author, year: doc.year });
      } catch (e) {
        console.warn('[retrieval] failed to describe document', id, e);
      }
    }
    return labels;
  }

  async search(q: RetrievalQuery): Promise<RetrievalSearchResult> {
    return this.trackSearch(q, this.captureStore(this.ensureReady(), q.signal));
  }

  private trackSearch(q: RetrievalQuery, captured: SearchCapture): Promise<RetrievalSearchResult> {
    // Suivie jusqu'à sa fin : une fermeture du magasin l'attend (`drainSearches`).
    const run = this.runSearch(q, captured);
    this.inFlightSearches.set(run, captured.generation);
    void run
      .catch(() => undefined)
      .finally(() => {
        this.inFlightSearches.delete(run);
      });
    return run;
  }

  private async runSearch(q: RetrievalQuery, captured: SearchCapture): Promise<RetrievalSearchResult> {
    const searchStart = Date.now();
    const ragConfig = configManager.getRAGConfig();
    const topK = q.topK || ragConfig.topK;
    const threshold = q.threshold || ragConfig.similarityThreshold;
    const scope = corporaInScope(q);
    const ownTextOnly =
      scope.size > 0 && [...scope].every((c) => c === 'manuscript' || c === 'readingNotes');

    if (DEBUG) {
      console.log(
        `🔍 [PDF-SERVICE] Multi-source search: corpora=${[...scope].join(',')}, topK=${topK}`
      );
    }

    // Partial-success first-class (claw-code lesson 6.3): an error in one
    // corpus must not silently lose the others — `fanOutCorpora` records
    // one outcome per corpus and keeps going.
    const { hits: allSourceResults, outcomes } = await fanOutCorpora(
      this.corpusRetrievers(captured),
      scope,
      q.query,
      {
        topK,
        threshold,
        documentIds: q.documentIds,
        collectionKeys: q.collectionKeys,
        // Sans aucune source dans la portée — le texte de l'auteur seul,
        // manuscrit, notes de lecture ou les deux —, un corpus garde un
        // repli : personne d'autre ne répondra.
        sole: ownTextOnly,
        // Une sélection de documents ou de collection cadre les notes de
        // lecture sur ces références au lieu de les écarter — quand des
        // sources sont interrogées : sans source, la sélection ne vaut pas
        // (le renderer la garde même bibliographie décochée).
        readingNoteCitekeys:
          scope.has('readingNotes') && !ownTextOnly
            ? this.citekeysForSelection(captured.store, q.documentIds, q.collectionKeys)
            : undefined,
      },
      (corpus, error) => {
        // Coupé par l'arrêt ou la fermeture, un corpus n'est pas en panne (J9).
        if (captured.signal.aborted) return;
        console.warn(`⚠️ [PDF-SERVICE] ${corpus} corpus search failed:`, error);
      }
    );
    // Le magasin a été rendu pendant la recherche (fermeture, bascule) : rien de ce qu'elle a trouvé
    // ne sert, et un corpus interrogé après coup a pu répondre avec le projet suivant. Arrêtée par
    // son appelant, elle rejette par la raison de l'arrêt : ses corpus coupés ne sont pas en panne.
    captured.assertCurrent();

    if (DEBUG) {
      for (const o of outcomes.filter((x) => x.attempted)) {
        console.log(`🔍 [PDF-SERVICE] ${o.source}: ${o.hitCount} results`);
      }
    }

    // Bandes des corpus à la voix de l'auteur (`retrieval-quota.ts`) : sans
    // réserve, la bibliographie prenait tout le `topK` (rc.4) ; sans plafond,
    // le manuscrit prenait tout le reste au mérite, et les notes de lecture,
    // « à armes égales », pouvaient en faire autant (2026-10). L'appelant peut
    // fixer chaque largeur ; omise, elle découle de `topK`.
    const sortedResults = selectWithOwnTextBands(allSourceResults, topK, {
      manuscript: q.manuscriptSlots,
      readingNotes: q.readingNoteSlots,
    });

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
  private corpusRetrievers(captured: SearchCapture): CorpusRetriever<AnySearchResult>[] {
    const retrievers: CorpusRetriever<AnySearchResult>[] = [
      {
        corpus: 'secondary',
        search: async (query, o) => {
          const results = await this.searchSecondary(query, o, captured);
          return results.map(
            (r: SearchResult): SecondarySearchResult => ({
              ...r,
              sourceType: 'secondary' as const,
            })
          );
        },
      },
      { corpus: 'primary', search: (query, o) => this.searchPrimary(query, o, captured) },
      { corpus: 'vault', search: (query, o) => this.searchVault(query, o, captured) },
      { corpus: 'manuscript', search: (query, o) => this.searchManuscript(query, o, captured) },
      { corpus: 'readingNotes', search: (query, o) => this.searchReadingNotes(query, o, captured) },
    ];
    // Un corpus ne part pas une fois le magasin rendu : il interrogerait le projet suivant.
    return retrievers.map(({ corpus, search }) => ({
      corpus,
      search: async (query, o) => {
        captured.assertCurrent();
        return search(query, o);
      },
    }));
  }

  /**
   * Clés de citation des références que l'utilisateur a sélectionnées ;
   * `undefined` sans sélection. Sert à cadrer les notes de lecture : ses
   * notes sur Braudel restent pertinentes quand Braudel est sélectionné, les
   * autres non. Une référence sans clé ne retient aucune note.
   *
   * Même arithmétique que la bibliographie (`SecondaryRetriever.
   * resolveDocumentFilter`) : documents choisis ET collection → l'intersection
   * — sinon les notes parleraient de références que la même sélection vient
   * d'exclure des sources.
   */
  private citekeysForSelection(
    store: VectorStore | EnhancedVectorStore,
    documentIds?: string[],
    collectionKeys?: string[]
  ): readonly string[] | undefined {
    const selected = documentIds?.length ?? 0;
    const inCollections = collectionKeys?.length ?? 0;
    if (selected === 0 && inCollections === 0) return undefined;
    let ids: string[] = documentIds ?? [];
    if (inCollections > 0) {
      let docsInCollections: string[] = [];
      try {
        docsInCollections = store.getDocumentIdsInCollections(collectionKeys ?? [], true);
      } catch (e) {
        console.warn('[retrieval] collections → documents lookup failed', e);
      }
      ids =
        selected > 0 ? ids.filter((id) => docsInCollections.includes(id)) : docsInCollections;
    }
    const citekeys = new Set<string>();
    for (const id of new Set(ids)) {
      try {
        const doc = store.getDocument(id) as { bibtexKey?: string | null } | null;
        if (doc?.bibtexKey) citekeys.add(doc.bibtexKey);
      } catch (e) {
        console.warn('[retrieval] failed to read document for citekey', id, e);
      }
    }
    return [...citekeys];
  }

  private async searchReadingNotes(
    query: string,
    options: {
      topK: number;
      threshold: number;
      sole?: boolean;
      readingNoteCitekeys?: readonly string[];
    },
    captured: SearchCapture
  ): Promise<ReadingNoteMappedSearchResult[]> {
    const store = readingNotesIndexService.getSearchStore();
    if (!store) return [];
    // Cadrage sur une sélection : aucune clé, aucune note — inutile d'embarquer.
    const scoped = options.readingNoteCitekeys ? new Set(options.readingNoteCitekeys) : null;
    if (scoped && scoped.size === 0) return [];
    const embedding = await this.getQueryEmbedding(query, captured);
    // Le store rend `topK` extraits avant cadrage : on en demande davantage
    // quand un filtre suit, pour ne pas rendre deux notes là où dix passent.
    const hits = store.search(embedding, query, scoped ? options.topK * 4 : options.topK);
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
    // Écrites par l'auteur dans sa langue, les notes n'ont pas l'excuse de
    // l'écart de langue : pas de repli sous le seuil aux côtés des sources.
    // Interrogées seules, elles gardent leurs trois passages les plus
    // proches, comme le manuscrit. « À armes égales » a cessé : elles ont
    // leur bande dans `selectWithOwnTextBands` (docs/poids-du-manuscrit.md).
    const kept = scoped ? mapped.filter((h) => scoped.has(h.source.citekey)) : mapped;
    const sorted = [...kept].sort((a, b) => b.similarity - a.similarity).slice(0, options.topK);
    return applyThreshold(sorted, options.threshold, options.sole ? CROSS_LANGUAGE_FALLBACK : 0);
  }

  private async searchPrimary(
    query: string,
    options: { topK: number; threshold: number },
    captured: SearchCapture
  ): Promise<PrimaryMappedSearchResult[]> {
    const primaryResults = await tropyService.search(query, { ...options, signal: captured.signal });
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
    options: { topK: number; threshold: number },
    captured: SearchCapture
  ): Promise<VaultMappedSearchResult[]> {
    const store = this.getVaultStore();
    if (!store) return [];
    const embedding = await this.getQueryEmbedding(query, captured);
    const hits = this.withoutAuthorText(
      store.search(embedding, query, options.topK),
      await this.configuredVaultPath()
    );
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

  /**
   * Un coffre qui contient le projet a pu indexer notes de lecture et manuscrit avant que le
   * lecteur ne les écarte (S09-1-13) : ces extraits ne passent pas par le canal « vault », qui
   * n'applique ni leur consentement ni leur politique. Une note est écartée si le coffre de la
   * configuration l'exclut, ou celui qu'elle porte en base. Le premier couvre un coffre renommé ou
   * déplacé puis relié : son ancien chemin n'existe plus, et la réindexation ne réécrit pas les
   * extraits que le lecteur écarte. Le second tient quand la configuration ne se lit pas.
   * Quand aucun des deux n'existe plus (coffre renommé sans être relié, projet copié sur une autre
   * machine : config.json voyage avec brain.db), le repli `makeOrphanAuthorTextTest` cherche le
   * chemin de la note sous les ancêtres du projet.
   */
  private withoutAuthorText<T extends { note: { relativePath: string; vaultPath?: string } }>(
    hits: T[],
    configuredVault: string | null
  ): T[] {
    const root = this.workspaceRoot;
    if (!root) return hits;
    const byVault = new Map<string, string[]>();
    const vaultExists = new Map<string, boolean>();
    const exists = (vaultPath: string): boolean => {
      let known = vaultExists.get(vaultPath);
      if (known === undefined) {
        known = fs.existsSync(vaultPath);
        vaultExists.set(vaultPath, known);
      }
      return known;
    };
    let orphanTest: ((relativePath: string) => boolean) | null = null;
    const exclusionsOf = (vaultPath: string): string[] => {
      let exclusions = byVault.get(vaultPath);
      if (!exclusions) {
        exclusions = authorTextInVault(vaultPath, root);
        byVault.set(vaultPath, exclusions);
      }
      return exclusions;
    };
    return hits.filter((h) => {
      const vaults = [configuredVault, h.note.vaultPath].filter((v): v is string => !!v);
      if (!vaults.some(exists)) {
        orphanTest ??= makeOrphanAuthorTextTest(root);
        return !orphanTest(h.note.relativePath);
      }
      return !vaults.some((v) => isExcludedFromVault(h.note.relativePath, exclusionsOf(v)));
    });
  }

  /** Le coffre que la configuration du projet relie, ou `null` si elle n'en relie aucun ou ne se lit pas. */
  private async configuredVaultPath(): Promise<string | null> {
    if (!this.workspaceRoot) return null;
    try {
      const cfg = await readWorkspaceConfig(this.workspaceRoot);
      const vault = cfg.vault as { path?: unknown } | undefined;
      return typeof vault?.path === 'string' && vault.path ? vault.path : null;
    } catch {
      return null;
    }
  }

  private async searchManuscript(
    query: string,
    options: { topK: number; threshold: number; sole?: boolean },
    captured: SearchCapture
  ): Promise<ManuscriptMappedSearchResult[]> {
    const store = this.getManuscriptStore();
    if (!store) return [];
    const embedding = await this.getQueryEmbedding(query, captured);
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
    // Pas de repli sous le seuil quand le manuscrit accompagne les sources :
    // la bande de `selectWithManuscriptQuota` lui réserve des places « quand
    // il a quelque chose à dire », et sans seuil il en avait toujours, même
    // hors sujet. Interrogé seul (« qu'ai-je déjà écrit sur X ? »), il garde
    // les trois passages les plus proches : mieux vaut trois passages limites
    // qu'une réponse de culture générale sous un prompt qui dit « aucune
    // source ».
    // `applyThreshold` attend une liste triée : le store rend l'ordre RRF, qui
    // n'est pas celui de la pertinence publiée — le repli garderait sinon
    // trois extraits d'après leur rang RRF, pas les trois plus proches.
    const sorted = [...mapped].sort((a, b) => b.similarity - a.similarity);
    return applyThreshold(sorted, options.threshold, options.sole ? CROSS_LANGUAGE_FALLBACK : 0);
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
    options: {
      topK?: number;
      threshold?: number;
      documentIds?: string[];
      collectionKeys?: string[];
    },
    captured: SearchCapture
  ): Promise<SearchResult[]> {
    const ragConfig = configManager.getRAGConfig();
    const topK = options?.topK || ragConfig.topK;
    const threshold = options?.threshold || ragConfig.similarityThreshold;

    // A20: inject user dictionary for query expansion if configured
    const userDict = ragConfig.queryExpansionDictionary;
    const expandQuery = userDict
      ? createExpandQueryFrEn(userDict)
      : undefined; // uses default expandQueryFrEn

    // Le magasin pris à l'entrée : celui du service est retiré dès qu'une fermeture commence.
    const retriever = new SecondaryRetriever({
      vectorStore: captured.store,
      getQueryEmbedding: (q) => this.getQueryEmbedding(q, captured),
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
