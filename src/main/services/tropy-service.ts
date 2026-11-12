import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { TropyReader, TropyItem, PrimarySourceItem } from '../../../backend/integrations/tropy/TropyReader.js';
import { TropySync, TropySyncOptions, TropySyncResult, TropySyncProgress, TropySyncIssue } from '../../../backend/integrations/tropy/TropySync.js';
import { assessTropyBinding, readTropyProjectIdentity } from '../../../backend/integrations/tropy/tropy-project-identity.js';
import { TropyWatcher } from '../../../backend/integrations/tropy/TropyWatcher.js';
import { TropyOCRPipeline, OCRResult, TranscriptionFormat, SUPPORTED_OCR_LANGUAGES } from '../../../backend/integrations/tropy/TropyOCRPipeline.js';
import { PopplerNotFoundError } from '../../../backend/integrations/tropy/PDFConverter.js';
import { PrimarySourcesVectorStore, PrimarySourceChunk, PrimarySourceDocument, PrimarySourceSearchResult, PrimarySourcesStatistics, TROPY_CHUNKS_VERSION } from '../../../backend/core/vector-store/PrimarySourcesVectorStore.js';
import type { NERService } from '../../../backend/core/ner/NERService.js';
import type { EntityStatistics, ExtractedEntity } from '../../../backend/types/entity.js';
import type { TropyReembedProposal, TropyReindexStatus } from '../../../backend/types/tropy-reindex.js';
import { EmbeddingSpaceMismatchError } from '../../../backend/core/vector-store/embedding-space.js';
import { ProjectChangedError, type ProjectHandle } from '../../../backend/types/project-handle.js';

// Chunking optimization modules
import { DocumentChunker, CHUNKING_CONFIGS } from '../../../backend/core/chunking/DocumentChunker.js';
import { ChunkQualityScorer } from '../../../backend/core/chunking/ChunkQualityScorer.js';
import { ChunkDeduplicator } from '../../../backend/core/chunking/ChunkDeduplicator.js';

// Typed provider registry (fusion 1.2c) — replaces the dual
// `pdfService.getOllamaClient() / getLLMProviderManager()` pattern.
import { configManager } from './config-manager.js';
import { expandQueryToText } from '../../../backend/core/rag/retrievers/secondary-retriever.js';
import { applyThreshold, CROSS_LANGUAGE_FALLBACK } from '../../../backend/core/rag/relevance.js';
import { createRegistryFromClioDeckConfig } from '../../../backend/core/llm/providers/cliodeck-config-adapter.js';
import { runBatch, runWithJournalContext } from '../../../backend/core/usage-journal/context.js';
import type {
  EmbeddingProvider,
  LLMProvider,
} from '../../../backend/core/llm/providers/base.js';
import type { ProviderRegistry } from '../../../backend/core/llm/providers/registry.js';

// MARK: - Types

export interface TropyProjectInfo {
  name: string;
  itemCount: number;
  lastModified: string;
  isWatching: boolean;
  tpyPath: string | null;
}

export interface TropyOpenResult {
  success: boolean;
  projectName?: string;
  itemCount?: number;
  lastModified?: string;
  error?: string;
  /** Pourquoi l'ouverture est refusée, à traduire côté renderer (`describeSyncIssue`). */
  issue?: TropySyncIssue;
}

export interface TropySearchResult {
  success: boolean;
  results?: PrimarySourceSearchResult[];
  error?: string;
}

/**
 * Pourquoi une source n'a pas été réindexée, à dire par le renderer.
 * `embedding-space-changed` : le modèle d'embeddings a changé depuis
 * l'indexation des archives, et rien n'a été écrit (L06-9).
 */
export type ReindexFailure = 'source-not-found' | 'no-embedding-provider' | 'embedding-failed' | 'embedding-space-changed';

/** Ce que fait le geste « Réindexer » de la proposition (Q29). */
export interface ReembedRequest {
  started: boolean;
  /** Sans fournisseur d'embeddings, pas de dimension à viser ; ou plus rien à refaire. */
  reason?: 'no-embedding-provider' | 'nothing-to-reembed';
}

/** Ce que le découpage d'une source lit : son en-tête, son texte, ses notes. */
type IndexableSource = Pick<
  PrimarySourceDocument,
  'id' | 'title' | 'creator' | 'date' | 'archive' | 'collection' | 'transcription' | 'transcriptionSource' | 'notesText'
>;

/**
 * Ce qu'a fait `indexSourceChunks` : écrit `chunks` extraits, ou rien parce que
 * la source a changé pendant son embarquement.
 */
type IndexOutcome = { status: 'written'; chunks: number } | { status: 'superseded' };

/** Pause avant le second essai d'une source de la réindexation complète (H7). */
const FULL_REINDEX_RETRY_DELAY_MS = 2_000;

/**
 * Pourquoi une passe sur les extraits est lancée hors de l'ouverture du projet (H7) :
 * `model-change`, la réindexation que l'historien a confirmée après un changement de modèle
 * d'embeddings (Q29) ; `provider-change`, le seul contrôle de l'index, à la dimension du fournisseur
 * que les Paramètres viennent de changer, sans rien réembarquer.
 */
type FullReindexCause = 'model-change' | 'provider-change';

/**
 * Les modèles de langue de Tesseract, téléchargés une fois par langue. Sous
 * userData : le dossier courant, où tesseract.js les rangeait sans consigne,
 * est `/` pour l'app lancée du Finder, non inscriptible (S08-1-29).
 */
function ocrOptions(): { cachePath: string } {
  return { cachePath: path.join(app.getPath('userData'), 'tesseract-cache') };
}

/**
 * Les extraits, sans ceux dont le texte est tout entier dans l'extrait gardé
 * juste avant (positions dans le texte de la source). `DocumentChunker` avance
 * de 250 mots et finit une source par un extrait de moins de 50 mots, contenu
 * dans le précédent : l'indexer une seconde fois ne fait que prendre une place
 * des résultats. La règle compare des positions, jamais des nombres de mots :
 * le découpage compte un tiret pour un mot, pas le filtre de qualité, et une
 * fin qui dépasse l'extrait précédent en comptait moins de 50 pour lui (L06-8).
 * Appliquée aux extraits que le filtre garde, elle n'écarte une fin que si
 * l'extrait qui la contient est gardé.
 */
function withoutContainedChunks<T extends { startPosition: number; endPosition: number }>(chunks: readonly T[]): T[] {
  const kept: T[] = [];
  for (const chunk of chunks) {
    const previous = kept[kept.length - 1];
    if (previous && chunk.startPosition >= previous.startPosition && chunk.endPosition <= previous.endPosition) {
      continue;
    }
    kept.push(chunk);
  }
  return kept;
}

// MARK: - TropyService

class TropyService {
  private vectorStore: PrimarySourcesVectorStore | null = null;
  private tropySync: TropySync | null = null;
  private watcher: TropyWatcher | null = null;
  private ocrPipeline: TropyOCRPipeline | null = null;
  private nerService: NERService | null = null;
  private currentTPYPath: string | null = null;
  private projectPath: string | null = null;

  // Chunking optimization modules
  private chunker: DocumentChunker | null = null;
  private qualityScorer: ChunkQualityScorer | null = null;
  private deduplicator: ChunkDeduplicator | null = null;

  /**
   * Typed provider registries (fusion 1.2c), built from the active workspace
   * config in `init()` and again by `rebuildProviders()` after a settings
   * change. One per half: `registry` for chunk/query embeddings,
   * `llmRegistry` for NER. A registry only builds — and disposes — the half
   * it was asked for, so a generation change leaves the embedding provider of
   * a running sync alone. Disposed in `close()` to release HTTP agents /
   * native handles.
   */
  private registry: ProviderRegistry | null = null;
  private llmRegistry: ProviderRegistry | null = null;
  private llm: LLMProvider | null = null;
  private embedding: EmbeddingProvider | null = null;

  /**
   * La réindexation complète des extraits d'avant (H7) : son état, tel que le
   * renderer le lit, et ses passes en cours — celle du projet ouvert, et celle
   * d'un projet quitté qui finit de s'arrêter.
   */
  private reindexStatus: TropyReindexStatus = { phase: 'idle' };
  /** Chaque passe, avec le magasin qu'elle refait : une passe confirmée attend celles du sien. */
  private reindexRuns = new Map<Promise<void>, PrimarySourcesVectorStore>();
  /**
   * Le magasin dont la réindexation pour un nouveau modèle est confirmée (Q29), le temps de sa
   * passe : elle ne se propose plus, son message la dit.
   */
  private reembedPending: PrimarySourcesVectorStore | null = null;
  /** Les synchros en cours : la réindexation complète leur cède le magasin. */
  private syncsRunning = 0;
  private syncWaiters: Array<() => void> = [];
  /** La source que la réindexation complète embarque : une synchro attend qu'elle soit écrite. */
  private reindexStep: Promise<unknown> = Promise.resolve();

  /**
   * Initialise le service Tropy pour un projet
   */
  async init(projectPath: string, handle?: ProjectHandle): Promise<void> {
    // Bascule de projet : démonter l'instance précédente AVANT de la
    // remplacer. Sans ce teardown, l'ancien watcher chokidar survivait et son
    // callback `change` — closure sur le singleton — pouvait déclencher une
    // resync sur le projet nouvellement chargé ; l'ancien vector store restait
    // aussi ouvert (fuite de handle SQLite). Le moteur OCR de la synchro aussi :
    // un thread, le WASM de Tesseract et son modèle, gardés jusqu'à la fermeture
    // de l'app (S08-1-16). Une passe du projet quitté s'arrête alors en échec,
    // sans l'attendre.
    await this.teardown();

    // Une ouverture abandonnée par la séquence continue pendant qu'un autre
    // projet s'ouvre sur ce même service : elle n'installe rien.
    if (handle && !handle.isCurrent()) throw new ProjectChangedError();

    this.projectPath = projectPath;
    this.vectorStore = new PrimarySourcesVectorStore(projectPath);
    // La réindexation du projet quitté ne parle plus au renderer (`reportReindex`).
    this.reindexStatus = { phase: 'idle' };
    this.tropySync = new TropySync(ocrOptions());
    this.watcher = new TropyWatcher();
    this.ocrPipeline = new TropyOCRPipeline(ocrOptions());

    // Build the typed provider registry from the active config. Same
    // self-contained lifecycle as retrieval-service; le précédent est déjà
    // libéré par `teardown`, et rien ne s'attend entre ici et la fin.
    try {
      const llmConfig = configManager.getLLMConfig();
      this.llmRegistry = createRegistryFromClioDeckConfig(llmConfig);
      this.llm = this.llmRegistry.getLLM();
      this.registry = createRegistryFromClioDeckConfig(llmConfig);
      this.embedding = this.registry.getEmbedding();
    } catch (e) {
      console.warn('[tropy-service] failed to build provider registry:', e);
      // Sans attente : les champs se vident tout de suite, et un démontage qui arriverait pendant
      // la libération trouverait ce projet à moitié installé.
      void this.disposePreviousRegistry();
    }

    // Initialize chunking optimization modules
    this.chunker = new DocumentChunker(CHUNKING_CONFIGS.cpuOptimized);
    this.qualityScorer = new ChunkQualityScorer();
    this.deduplicator = new ChunkDeduplicator();
    console.log('📐 [TROPY-SERVICE] Chunking optimization modules initialized');

    // Vérifier s'il y a un projet Tropy déjà enregistré
    const existingProject = this.vectorStore.getTropyProject();
    if (existingProject) {
      this.currentTPYPath = existingProject.tpyPath;
      console.log(`📚 Tropy project loaded: ${existingProject.name}`);

      // Lien d'avant project_uuid : son identité se lit dans le .tpy
      // enregistré, s'il est toujours là. Sinon la garde s'en remettra à
      // l'empreinte des photos. Jamais une raison de faire échouer l'ouverture.
      if (existingProject.projectUuid === null && fs.existsSync(existingProject.tpyPath)) {
        try {
          const { projectId } = readTropyProjectIdentity(existingProject.tpyPath);
          if (projectId) this.vectorStore.recordTropyProjectUuid(existingProject.id, projectId);
        } catch (error) {
          console.warn('⚠️ [TROPY-SERVICE] Could not read the linked Tropy project identity:', error);
        }
      }

      // Démarrer le watcher si auto-sync était activé
      if (existingProject.autoSync && fs.existsSync(existingProject.tpyPath)) {
        this.startWatching();
      }
    }

    // En arrière-plan : ni l'ouverture du projet, ni l'éditeur, ni le chat ne l'attendent.
    this.startFullReindex();
  }

  /**
   * Ferme le service et libère les ressources
   */
  async close(): Promise<void> {
    await this.teardown();
  }

  /**
   * Démonte le projet ouvert. Tout est détaché AVANT la moindre attente : un
   * `init` ou un `close` qui reprend pendant ce temps ne retrouve ni ce magasin
   * ni ces moteurs, et chaque libération qui lève (le `.tpy` refermé par
   * `tropySync.dispose`, un moteur OCR) n'empêche ni les autres ni
   * l'ouverture suivante.
   */
  private async teardown(): Promise<void> {
    this.stopWatching();
    const { ocrPipeline, tropySync, vectorStore } = this;
    const registries = [this.registry, this.llmRegistry];
    this.vectorStore = null;
    this.reindexStatus = { phase: 'idle' };
    this.reembedPending = null;
    this.tropySync = null;
    this.watcher = null;
    this.ocrPipeline = null;
    this.currentTPYPath = null;
    this.projectPath = null;
    this.registry = null;
    this.llmRegistry = null;
    this.llm = null;
    this.embedding = null;

    // Clean up chunking optimization modules
    this.chunker = null;
    this.qualityScorer = null;
    this.deduplicator = null;

    const release = async (what: string, run: () => unknown): Promise<void> => {
      try {
        await run();
      } catch (error: unknown) {
        console.warn(`⚠️ [TROPY-SERVICE] libération de ${what} impossible :`, error);
      }
    };
    await release('la passe OCR', () => ocrPipeline?.dispose());
    await release('la synchro', () => tropySync?.dispose());
    await release('la base', () => vectorStore?.close());
    await Promise.all(registries.map((r) => r?.dispose().catch(() => undefined)));
  }

  private async disposePreviousRegistry(): Promise<void> {
    const previous = [this.registry, this.llmRegistry];
    this.registry = null;
    this.llmRegistry = null;
    this.llm = null;
    this.embedding = null;
    await Promise.all(previous.map((r) => r?.dispose().catch(() => undefined)));
  }

  /**
   * Relit la configuration après un changement de réglages. Le registre n'était construit qu'à
   * l'ouverture du projet : décocher les embeddings cloud laissait partir les transcriptions et les
   * requêtes vers l'ancien service, avec l'ancienne clé, jusqu'à la réouverture (S08-1-21).
   *
   * Le nouveau fournisseur est construit avant que l'ancien ne soit libéré : une synchro en vol passe
   * au nouveau à l'extrait suivant. Un échec met tout à null, jamais de repli sur l'ancien — il porte
   * peut-être le consentement qu'on vient de retirer. Service à l'arrêt : `init` lira la configuration.
   */
  async rebuildProviders({ embeddingChanged }: { embeddingChanged: boolean }): Promise<void> {
    if (!this.projectPath) return;
    const previous = embeddingChanged ? [this.llmRegistry, this.registry] : [this.llmRegistry];
    try {
      const llmConfig = configManager.getLLMConfig();
      const llmRegistry = createRegistryFromClioDeckConfig(llmConfig);
      const llm = llmRegistry.getLLM();
      const registry = embeddingChanged ? createRegistryFromClioDeckConfig(llmConfig) : this.registry;
      const embedding = embeddingChanged ? (registry?.getEmbedding() ?? null) : this.embedding;
      this.llmRegistry = llmRegistry;
      this.llm = llm;
      this.registry = registry;
      this.embedding = embedding;
    } catch (e) {
      console.warn('[tropy-service] failed to rebuild provider registry:', e);
      await this.disposePreviousRegistry();
      if (this.vectorStore) this.announceReembedProposal(this.vectorStore);
      return;
    }
    // Un autre modèle d'embeddings : les archives à réindexer ne sont plus les mêmes (Q29), et l'index
    // est contrôlé à la dimension du nouveau, comme à l'ouverture. Sinon, il restait à celle de
    // l'ancien jusqu'à la réouverture du projet : revenu au modèle d'avant après une réindexation
    // interrompue, l'historien voyait la synchro refuser ses nouvelles pièces au nom d'une dimension
    // que la plupart des archives n'avaient plus. Rien n'est réembarqué (`provider-change`).
    if (embeddingChanged && this.vectorStore) {
      this.announceReembedProposal(this.vectorStore);
      this.startFullReindex('provider-change');
    }
    await Promise.all(previous.map((r) => r?.dispose().catch(() => undefined)));
  }

  /**
   * Embed a single text via the typed provider; returns the Float32Array
   * shape PrimarySourcesVectorStore expects.
   */
  private async embedOne(text: string): Promise<Float32Array> {
    if (!this.embedding) {
      throw new Error(
        'tropy-service: embedding provider not configured (call init() first)'
      );
    }
    const [vec] = await this.embedding.embed([text]);
    return Float32Array.from(vec);
  }

  /**
   * Vérifie si le service est initialisé
   */
  isInitialized(): boolean {
    return this.vectorStore !== null;
  }

  // MARK: - Project Management

  /**
   * Ouvre un projet Tropy (.tpy) en lecture seule
   */
  async openProject(tpyPath: string): Promise<TropyOpenResult> {
    try {
      if (!fs.existsSync(tpyPath)) {
        return { success: false, error: `File not found: ${tpyPath}` };
      }

      // Un projet ClioDeck, un projet Tropy (Q25) : un autre projet n'est
      // pas suivi, et la synchro automatique qui suit l'ouverture n'a pas
      // lieu. currentTPYPath reste celui du projet lié.
      if (this.vectorStore) {
        const { decision, identity } = assessTropyBinding(tpyPath, this.vectorStore);
        if (decision.kind === 'different') {
          return {
            success: false,
            error: `Different Tropy project: "${identity.name}" is not the linked project "${decision.linkedName}"`,
            issue: {
              code: 'different-project',
              linkedName: decision.linkedName,
              candidateName: identity.name,
              sourceCount: decision.sourceCount,
            },
          };
        }
      }

      const reader = new TropyReader();
      reader.openProject(tpyPath);

      const projectInfo = reader.getProjectInfo();
      reader.closeProject();

      this.currentTPYPath = tpyPath;

      console.log(`📚 Opened Tropy project: ${projectInfo.name} (${projectInfo.itemCount} items)`);

      return {
        success: true,
        projectName: projectInfo.name,
        itemCount: projectInfo.itemCount,
        lastModified: projectInfo.lastModified.toISOString(),
      };
    } catch (error: unknown) {
      console.error('Failed to open Tropy project:', error);
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  /**
   * Retourne les informations du projet Tropy actuel
   */
  getProjectInfo(): TropyProjectInfo | null {
    if (!this.vectorStore) return null;

    const project = this.vectorStore.getTropyProject();
    if (!project) return null;

    return {
      name: project.name,
      itemCount: this.vectorStore.getStatistics().sourceCount,
      lastModified: project.lastSync,
      isWatching: this.watcher?.isActive() || false,
      tpyPath: project.tpyPath,
    };
  }

  // MARK: - Synchronization

  /**
   * Synchronise le projet Tropy avec ClioDeck
   * Inclut la génération des embeddings pour la recherche vectorielle
   */
  async sync(options: TropySyncOptions): Promise<TropySyncResult> {
    // Le projet de la synchro, pris à l'entrée : ses appels au modèle et son lot
    // d'embeddings vont au journal d'usage de ce projet, même finis après
    // l'ouverture d'un autre (S10-1-33).
    const { tropySync, vectorStore, currentTPYPath, projectPath } = this;
    if (!tropySync || !vectorStore || !currentTPYPath || !projectPath) {
      return {
        success: false,
        projectName: '',
        totalItems: 0,
        newItems: 0,
        updatedItems: 0,
        skippedItems: 0,
        ocrPerformed: 0,
        transcriptionsImported: 0,
        transcriptionsWritten: 0,
        errors: ['Service not initialized or no project opened'],
        issues: [],
      };
    }

    // La réindexation complète cède le magasin à la synchro (H7) : elle se met
    // en pause après la source qu'elle embarque, et reprend quand la dernière
    // synchro a fini. L'historien qui synchronise n'attend pas une passe de
    // plusieurs heures.
    this.syncsRunning += 1;
    try {
      return await runWithJournalContext({ workspaceRoot: projectPath }, () =>
        this.runSync(tropySync, vectorStore, currentTPYPath, options)
      );
    } finally {
      this.syncsRunning -= 1;
      if (this.syncsRunning === 0) {
        for (const resume of this.syncWaiters.splice(0)) resume();
      }
    }
  }

  /** La synchro elle-même : métadonnées et OCR, puis embarquement des sources sans extrait. */
  private async runSync(
    tropySync: TropySync,
    vectorStore: PrimarySourcesVectorStore,
    tpyPath: string,
    options: TropySyncOptions
  ): Promise<TropySyncResult> {
    // Notifier la progression via IPC
    const onProgress = (progress: TropySyncProgress) => {
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send('tropy:sync-progress', progress);
      });
    };

    // Phase 1: Synchroniser les métadonnées (NER runs only when
    // `extractEntities` is true *and* the typed registry built in `init()`
    // exposes a usable LLM provider).
    const syncOptions = {
      ...options,
      llm: this.llm ?? undefined,
      extractEntities: options.extractEntities === true,
    };

    const result = await tropySync.sync(
      tpyPath,
      vectorStore,
      syncOptions,
      onProgress
    );

    // Phase 2: Générer les embeddings pour les sources avec du texte
    // Always try to generate embeddings - the method will skip sources that already have chunks
    if (result.success) {
      // Pas deux embarquements à la fois sur le magasin : la source que la
      // réindexation complète embarquait s'écrit d'abord (H7).
      await this.reindexStep.catch(() => undefined);
      try {
        console.log('📐 [TROPY-SERVICE] Starting embedding generation...');
        // Scope de batch : agrège les embeddings par chunk en un seul
        // `embedding_batch` (journal d'usage IA) pour cette synchro Tropy.
        const embeddingResult = await runBatch('tropy', () =>
          this.generateEmbeddingsForSources(onProgress)
        );
        console.log(`📐 [TROPY-SERVICE] Embeddings generated: ${embeddingResult.chunksCreated} chunks for ${embeddingResult.sourcesProcessed} sources`);
        // La synchro a réussi, mais ces sources ne sont pas encore citées par
        // l'assistant : le dire, au lieu d'un succès sans réserve.
        if (embeddingResult.issue) result.issues.push(embeddingResult.issue);

        // Save HNSW index after embedding generation
        if (embeddingResult.chunksCreated > 0 && this.vectorStore) {
          console.log('💾 [TROPY-SERVICE] Saving HNSW index...');
          this.vectorStore.saveHNSWIndex();
          const stats = this.vectorStore.getIndexStats();
          console.log(`💾 [TROPY-SERVICE] Index saved. HNSW: ${stats.hnswSize}, BM25: ${stats.bm25Size}`);
        }
      } catch (error: unknown) {
        console.error('❌ [TROPY-SERVICE] Embedding generation failed:', error);
        result.errors.push(`Embedding generation failed: ${(error instanceof Error ? error.message : String(error))}`);
      }
    }

    return result;
  }

  /**
   * Génère les embeddings pour toutes les sources qui n'en ont pas encore.
   *
   * Une source dont l'embarquement échoue reste sans extrait (tout ou rien,
   * `indexSourceChunks`) : ce filtre la reprend à la synchro suivante. Les
   * échecs sont comptés et rendus en `issue`, pour que l'historien sache que
   * l'assistant ne cite pas encore ces sources. Le filtre lit les sources au
   * départ de la passe ; une source réécrite depuis n'est pas indexée avec son
   * ancien texte (`superseded`).
   */
  private async generateEmbeddingsForSources(
    onProgress?: (progress: TropySyncProgress) => void
  ): Promise<{ sourcesProcessed: number; chunksCreated: number; issue?: TropySyncIssue }> {
    if (!this.vectorStore) {
      return { sourcesProcessed: 0, chunksCreated: 0 };
    }

    // Récupérer toutes les sources
    const allSources = this.vectorStore.getAllSources();
    let sourcesProcessed = 0;
    let chunksCreated = 0;
    let sourcesFailed = 0;

    // Filtrer les sources qui ont du texte mais pas encore de chunks
    const sourcesToProcess = allSources.filter(source => {
      // Vérifier si la source a du texte (transcription ou métadonnées)
      const hasText = source.transcription && source.transcription.trim().length > 0;
      if (!hasText) return false;

      // Vérifier si la source a déjà des chunks
      const existingChunks = this.vectorStore!.getChunks(source.id);
      return existingChunks.length === 0;
    });

    // DEBUG: Log transcription status
    const withTranscription = allSources.filter(s => s.transcription && s.transcription.trim().length > 0);
    const withLongTranscription = allSources.filter(s => s.transcription && s.transcription.trim().length > 100);
    console.log(`📐 [TROPY-SERVICE] Sources: ${allSources.length} total, ${withTranscription.length} with transcription, ${withLongTranscription.length} with transcription > 100 chars`);

    if (withTranscription.length > 0) {
      const sample = withTranscription[0];
      console.log(`📐 [TROPY-SERVICE] Sample source "${sample.title}": transcription length = ${sample.transcription?.length || 0}`);
      console.log(`📐 [TROPY-SERVICE] Sample transcription preview: "${sample.transcription?.substring(0, 200)}..."`);
    }

    if (sourcesToProcess.length === 0) {
      console.log('📐 [TROPY-SERVICE] No sources need embedding generation');
      return { sourcesProcessed: 0, chunksCreated: 0 };
    }

    // Sans fournisseur, rien ne s'indexe — mais seulement s'il y avait de quoi.
    if (!this.embedding) {
      console.warn('⚠️ [TROPY-SERVICE] No embedding provider configured, skipping embedding generation');
      return {
        sourcesProcessed: 0,
        chunksCreated: 0,
        issue: { code: 'no-embedding-provider', sources: sourcesToProcess.length },
      };
    }

    console.log(`📐 [TROPY-SERVICE] Processing ${sourcesToProcess.length} sources for embeddings...`);

    let spaceChanged: EmbeddingSpaceMismatchError | null = null;
    let notTried = 0;
    for (let i = 0; i < sourcesToProcess.length; i++) {
      const source = sourcesToProcess[i];

      onProgress?.({
        phase: 'indexing',
        current: i + 1,
        total: sourcesToProcess.length,
        currentItem: source.title,
      });

      try {
        const outcome = await this.indexSourceChunks(source);
        // Réécrite pendant la passe (OCR manuel, import) : son écrivain la
        // réindexe, ou la passe suivante la reprend. Ni traitée, ni en échec.
        if (outcome.status === 'superseded') {
          console.log(`📐 [TROPY-SERVICE] Source ${source.id} modifiée pendant son embarquement : extraits non écrits`);
          continue;
        }
        chunksCreated += outcome.chunks;
        sourcesProcessed++;
      } catch (error) {
        // Le modèle d'embeddings a changé depuis l'indexation des archives (L06-9) : rien n'a été
        // écrit, et chaque source suivante serait embarquée pour être refusée de même. Elles
        // attendent la réindexation des archives, proposée dans le panneau (Q29).
        if (error instanceof EmbeddingSpaceMismatchError) {
          spaceChanged = error;
          notTried = sourcesToProcess.length - i - 1;
          console.warn(`⚠️ [TROPY-SERVICE] ${error.message} : ${notTried + 1} source(s) laissée(s) sans extrait`);
          break;
        }
        sourcesFailed++;
        console.error(`❌ [TROPY-SERVICE] Failed to process source ${source.id}:`, error);
      }
    }

    if (spaceChanged) {
      return {
        sourcesProcessed,
        chunksCreated,
        issue: {
          code: 'embedding-space-changed',
          sources: sourcesFailed + notTried + 1,
          expected: Number(spaceChanged.expected),
          actual: Number(spaceChanged.actual),
        },
      };
    }
    const issue: TropySyncIssue | undefined =
      sourcesFailed > 0 ? { code: 'embedding-failed', sources: sourcesFailed } : undefined;
    return { sourcesProcessed, chunksCreated, issue };
  }

  /**
   * Découpe un texte en chunks pour l'indexation
   * Utilise DocumentChunker pour un chunking optimisé avec:
   * - Respect des limites de phrases
   * - Overlap configurable
   * - Contexte document ajouté aux chunks
   */
  private chunkText(
    text: string,
    sourceId: string,
    sourceMeta?: { title?: string }
  ): Array<{ id: string; sourceId: string; content: string; chunkIndex: number; startPosition: number; endPosition: number }> {
    if (!this.chunker) {
      console.warn('⚠️ [TROPY-SERVICE] Chunker not initialized, using fallback');
      // Fallback simple si chunker non initialisé
      return [{
        id: `${sourceId}-chunk-0`,
        sourceId,
        content: text,
        chunkIndex: 0,
        startPosition: 0,
        endPosition: text.length,
      }];
    }

    // Convert text to pages format expected by DocumentChunker
    const pages = [{ pageNumber: 1, text }];

    // Use DocumentChunker with document metadata for context
    const documentChunks = this.chunker.createChunks(pages, sourceId, sourceMeta);

    // Map to expected format with sourceId instead of documentId
    return documentChunks.map(chunk => ({
      id: chunk.id,
      sourceId: sourceId,
      content: chunk.content,
      chunkIndex: chunk.chunkIndex,
      startPosition: chunk.startPosition,
      endPosition: chunk.endPosition,
    }));
  }

  /**
   * Retourne les chunks bruts du DocumentChunker (pour optimisation)
   * Ces chunks ont le format DocumentChunk avec documentId et pageNumber
   * Compatible avec ChunkQualityScorer et ChunkDeduplicator
   */
  private getRawChunks(
    text: string,
    sourceId: string,
    sourceMeta?: { title?: string }
  ): Array<{ id: string; documentId: string; content: string; chunkIndex: number; pageNumber: number; startPosition: number; endPosition: number }> {
    if (!this.chunker) {
      console.warn('⚠️ [TROPY-SERVICE] Chunker not initialized, using fallback');
      return [{
        id: `${sourceId}-chunk-0`,
        documentId: sourceId,
        content: text,
        chunkIndex: 0,
        pageNumber: 1,
        startPosition: 0,
        endPosition: text.length,
      }];
    }

    // Convert text to pages format expected by DocumentChunker
    const pages = [{ pageNumber: 1, text }];

    // Use DocumentChunker with document metadata for context
    return this.chunker.createChunks(pages, sourceId, sourceMeta);
  }

  /**
   * Vérifie si une synchronisation est nécessaire
   */
  checkSyncNeeded(): boolean {
    if (!this.tropySync || !this.vectorStore || !this.currentTPYPath) {
      return false;
    }

    return this.tropySync.checkSyncNeeded(this.currentTPYPath, this.vectorStore);
  }

  // MARK: - File Watching

  /**
   * Démarre la surveillance du projet Tropy lié au projet courant
   * (`currentTPYPath`, posé par `init` ou `openProject`). Aucun chemin n'est
   * reçu : celui que passait le renderer était adopté comme `currentTPYPath`,
   * et un chemin resté du projet ClioDeck précédent faisait importer son
   * archive dans celui-ci à la synchro suivante (S18-1-30).
   */
  startWatching(): { success: boolean; error?: string } {
    const pathToWatch = this.currentTPYPath;

    if (!pathToWatch) {
      return { success: false, error: 'No Tropy project linked to the current project' };
    }

    if (!this.watcher) {
      this.watcher = new TropyWatcher();
    }

    // Le watcher est REUTILISE d'un appel à l'autre : sans purge, chaque
    // bascule de la synchro automatique empilait un écouteur de plus, et
    // un seul enregistrement dans Tropy déclenchait alors autant de `sync()`
    // concurrents qu'il y avait eu d'activations — sur le même store.
    this.watcher.removeAllListeners('change');
    this.watcher.removeAllListeners('error');

    // Configurer le callback de changement
    this.watcher.on('change', async (changedPath: string) => {
      console.log(`📝 Tropy file changed: ${changedPath}`);

      // Notifier le renderer
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send('tropy:file-changed', changedPath);
      });

      // Auto-sync si configuré
      const project = this.vectorStore?.getTropyProject();
      if (project?.autoSync) {
        await this.sync({
          performOCR: false,
          ocrLanguage: 'fra',
        });
      }
    });

    this.watcher.on('error', (error: Error) => {
      console.error('Tropy watcher error:', error);
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send('tropy:watcher-error', error.message);
      });
    });

    this.watcher.watch(pathToWatch);

    return { success: true };
  }

  /**
   * Arrête la surveillance
   */
  stopWatching(): void {
    // Retirer les écouteurs AVANT de démonter : `unwatch()` ne les touche
    // pas, et un watcher gardé en champ les conserverait pour la prochaine
    // activation.
    this.watcher?.removeAllListeners('change');
    this.watcher?.removeAllListeners('error');
    this.watcher?.unwatch();
  }

  /**
   * Vérifie si le watcher est actif
   */
  isWatching(): boolean {
    return this.watcher?.isActive() || false;
  }

  // MARK: - OCR

  /**
   * Effectue l'OCR sur une image
   */
  async performOCR(
    imagePath: string,
    language: string
  ): Promise<{ success: boolean; text?: string; confidence?: number; error?: string }> {
    try {
      if (!this.ocrPipeline) {
        this.ocrPipeline = new TropyOCRPipeline(ocrOptions());
      }

      const result = await this.ocrPipeline.performOCR(imagePath, { language });

      return {
        success: true,
        text: result.text,
        confidence: result.confidence,
      };
    } catch (error: unknown) {
      console.error('OCR failed:', error);
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  /**
   * Effectue l'OCR sur plusieurs images
   */
  async performBatchOCR(
    imagePaths: string[],
    language: string
  ): Promise<{ success: boolean; text?: string; confidence?: number; error?: string }> {
    try {
      if (!this.ocrPipeline) {
        this.ocrPipeline = new TropyOCRPipeline(ocrOptions());
      }

      const result = await this.ocrPipeline.performBatchOCR(imagePaths, { language });

      // Sans Poppler, le texte ne porte que les images : l'écrire remplacerait,
      // sans le dire, la transcription complète de la source. L'OCR manuel
      // échoue alors, comme pour une source qui n'a que des PDF.
      if (result.missingTool === 'poppler') {
        throw new PopplerNotFoundError();
      }

      return {
        success: true,
        text: result.text,
        confidence: result.confidence,
      };
    } catch (error: unknown) {
      console.error('Batch OCR failed:', error);
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  /**
   * Retourne les langues OCR supportées
   */
  getSupportedOCRLanguages(): Array<{ code: string; name: string }> {
    return [...SUPPORTED_OCR_LANGUAGES];
  }

  // MARK: - OCR Quality Reports

  getSourceOCRReport(sourceId: string) {
    return this.vectorStore?.getSourceOCRReport(sourceId) ?? null;
  }

  getCorpusOCRReport() {
    return this.vectorStore?.getCorpusOCRReport() ?? null;
  }

  // MARK: - Transcription Import

  /**
   * Importe une transcription externe
   */
  async importTranscription(
    filePath: string,
    type?: TranscriptionFormat
  ): Promise<{ success: boolean; text?: string; format?: TranscriptionFormat; error?: string }> {
    try {
      if (!this.ocrPipeline) {
        this.ocrPipeline = new TropyOCRPipeline(ocrOptions());
      }

      // Détecter le format si non spécifié
      const format = type || this.ocrPipeline.detectFormat(filePath);
      if (!format) {
        return { success: false, error: 'Could not detect transcription format' };
      }

      const result = await this.ocrPipeline.importTranscription({ type: format, filePath });

      return {
        success: true,
        text: result.text,
        format: result.format,
      };
    } catch (error: unknown) {
      console.error('Transcription import failed:', error);
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  // MARK: - Search

  /**
   * Recherche dans les sources primaires
   * Accepte une query text et des options, génère l'embedding via OllamaClient
   * Utilise la recherche hybride (HNSW + BM25) pour de meilleurs résultats
   *
   * Une panne lève : `fanOutCorpora` la rapporte alors (« Archives échec » dans
   * le détail du message, bande d'échec, consigne d'échec au modèle). Un
   * `catch` qui rendait `[]` faisait passer Ollama arrêté, un index d'un autre
   * modèle ou l'absence de fournisseur pour des archives sans rien de
   * pertinent (E2) : « Archives 0 », et aucune bande d'échec quand les
   * archives étaient seules à tomber — au pire « Aucune source pertinente
   * trouvée. », quand aucun autre corpus ne trouvait rien. Seuls « aucun
   * projet ouvert » et « aucun extrait embarqué » rendent `[]` en silence.
   */
  async search(
    query: string,
    options?: { topK?: number; threshold?: number }
  ): Promise<Array<PrimarySourceSearchResult & { source?: any }>> {
    console.log(`📜 [TROPY-SERVICE] Search called with query: "${query}"`);

    if (!this.vectorStore) {
      console.warn('⚠️ [TROPY-SERVICE] VectorStore not initialized');
      return [];
    }

    // Aucun extrait embarqué — pas de projet Tropy lié, ou rien d'indexé
    // encore : rien à trouver, donc rien à embarquer. Lu avant d'exiger un
    // fournisseur, sinon un Ollama arrêté ferait passer pour en panne des
    // archives que le projet n'a pas.
    if (!this.vectorStore.hasEmbeddedChunks()) {
      console.log('📜 [TROPY-SERVICE] No embedded chunk, nothing to search');
      return [];
    }

    // Debug: Check index state
    const indexStats = this.vectorStore.getIndexStats();
    console.log(`📜 [TROPY-SERVICE] Index stats: HNSW=${indexStats.hnswSize}, BM25=${indexStats.bm25Size}, dimension=${indexStats.hnswDimension}`);

    const topK = options?.topK || 10;
    // Le store publie la pertinence du contrat commun (`relevance.ts`, échelle
    // du cosinus) : le seuil s'applique donc tel quel. Il était auparavant
    // ramené à 0,005, conversion pensée pour des scores RRF que le store ne
    // publie plus — ce qui revenait à ne filtrer aucun extrait d'archive.
    const threshold = options?.threshold ?? configManager.getRAGConfig().similarityThreshold;

    // Expand query for multilingual search (FR + EN)
    const expandedQuery = await this.expandQueryMultilingual(query);
    console.log(`📜 [TROPY-SERVICE] Expanded query: "${expandedQuery}"`);

    // Generate embedding for the expanded query. Sans fournisseur, `embedOne` lève.
    const queryEmbedding = await this.embedOne(expandedQuery);
    console.log(`📜 [TROPY-SERVICE] Query embedding generated, dimension: ${queryEmbedding.length}`);

    // Search using hybrid search (HNSW + BM25) - pass both embedding and text
    const results = this.vectorStore.search(queryEmbedding, topK * 2, expandedQuery);

    // Seuil, avec le même repli que la bibliographie : des archives
    // peuvent être dans une autre langue que la question, et trois extraits
    // limites valent mieux qu'une réponse vide. Le repli gardait jusqu'ici
    // `topK` extraits — de quoi remplir toutes les places avec du hors-sujet.
    const enrichedResults = applyThreshold(results, threshold, CROSS_LANGUAGE_FALLBACK);

    console.log(`📜 [TROPY-SERVICE] Hybrid search found ${enrichedResults.length} results (threshold: ${threshold})`);

    // Debug: Show top result if any
    if (enrichedResults.length > 0) {
      const topResult = enrichedResults[0];
      console.log(`📜 [TROPY-SERVICE] Top result: "${topResult.source?.title}" (relevance: ${topResult.similarity.toFixed(4)})`);
    } else {
      console.log(`📜 [TROPY-SERVICE] No results found. Total results before threshold: ${results.length}`);
    }

    return enrichedResults.slice(0, topK);
  }

  /**
   * Expand query with multilingual terms (FR/EN).
   * Même mécanisme que SecondaryRetriever (dictionnaire built-in +
   * `rag.queryExpansionDictionary` de la config), réutilisé via
   * `expandQueryToText` : requête inchangée quand aucun terme ne matche.
   * Comblait le trou documenté « expansion seulement côté secondaire ».
   */
  private async expandQueryMultilingual(query: string): Promise<string> {
    const userDict = configManager.getRAGConfig().queryExpansionDictionary;
    return expandQueryToText(query, userDict);
  }

  /**
   * Search with entity boosting (Graph RAG)
   * Uses NER to extract entities from query and boost matching results
   */
  async searchWithEntities(
    query: string,
    options?: { topK?: number; threshold?: number; useEntities?: boolean }
  ): Promise<PrimarySourceSearchResult[]> {
    if (!this.vectorStore) {
      console.warn('⚠️ [TROPY-SERVICE] VectorStore not initialized');
      return [];
    }

    const topK = options?.topK || 10;
    // Échelle du cosinus, comme `search()` — plus de conversion vers le RRF.
    const threshold = options?.threshold ?? configManager.getRAGConfig().similarityThreshold;
    const useEntities = options?.useEntities ?? true;

    try {
      if (!this.embedding) {
        console.warn('⚠️ [TROPY-SERVICE] No embedding provider configured');
        return [];
      }

      // NER initialisation is done via TropySync.initNERServiceWithProvider
      // during sync(); here, if NER is requested but no service is yet
      // initialised (e.g. search before any sync), we degrade to plain
      // hybrid search rather than spinning up NER ad-hoc with the legacy
      // OllamaClient — that path was retired in fusion 1.2c.
      if (useEntities && !this.nerService) {
        console.log('🏷️ [TROPY-SERVICE] No NER service yet — falling back to hybrid search');
      }

      // Generate query embedding (with query prefix for embedded models)
      const expandedQuery = await this.expandQueryMultilingual(query);
      const queryEmbedding = await this.embedOne(expandedQuery);

      // If not using entities, fallback to hybrid search
      if (!useEntities || !this.nerService) {
        const results = this.vectorStore.search(queryEmbedding, topK * 2, expandedQuery);
        return applyThreshold(results, threshold, CROSS_LANGUAGE_FALLBACK).slice(0, topK);
      }

      // Extract entities from query
      const queryEntities = await this.nerService.extractQueryEntities(query);

      console.log(`🏷️ [TROPY-SERVICE] Query entities: ${queryEntities.map(e => `${e.name}(${e.type})`).join(', ')}`);

      // Search with entity boosting
      const results = this.vectorStore.searchWithEntityBoost(
        queryEmbedding,
        queryEntities,
        topK * 2,
        expandedQuery
      );

      const filteredResults = applyThreshold(results, threshold, CROSS_LANGUAGE_FALLBACK);

      console.log(`🏷️ [TROPY-SERVICE] Entity-boosted search found ${filteredResults.length} results`);

      return filteredResults.slice(0, topK);
    } catch (error) {
      console.error('❌ [TROPY-SERVICE] Entity search failed:', error);
      // Fallback to regular search
      return this.search(query, options);
    }
  }

  /**
   * Recherche avec un embedding pré-calculé
   */
  searchWithEmbedding(
    queryEmbedding: Float32Array,
    topK: number = 10
  ): PrimarySourceSearchResult[] {
    if (!this.vectorStore) {
      return [];
    }

    return this.vectorStore.search(queryEmbedding, topK);
  }

  /**
   * Récupère toutes les sources primaires
   */
  getAllSources(): PrimarySourceDocument[] {
    if (!this.vectorStore) {
      return [];
    }

    return this.vectorStore.getAllSources();
  }

  /**
   * Récupère une source par son ID
   */
  getSource(id: string): PrimarySourceDocument | null {
    if (!this.vectorStore) {
      return null;
    }

    return this.vectorStore.getSource(id);
  }

  /**
   * Chemins d'images uniques et existants d'une source, pour l'OCR manuel
   * (#23). Même règle que TropySync.performOCROnItem : Tropy crée une
   * entrée photo par page de PDF, on déduplique par chemin et on écarte
   * les fichiers disparus. Une lecture du .tpy ratée lève `TropyReadError`
   * (J6) : le handler la rend en échec, au lieu d'une source « sans image ».
   */
  getSourcePhotoPaths(sourceId: string): string[] {
    if (!this.vectorStore || !this.currentTPYPath) {
      return [];
    }
    const source = this.vectorStore.getSource(sourceId);
    if (!source) {
      return [];
    }

    const reader = new TropyReader();
    reader.openProject(this.currentTPYPath);
    try {
      const item = reader.getItem(source.tropyId);
      const unique = [...new Set((item?.photos ?? []).map((p) => p.path))];
      return unique.filter((p) => fs.existsSync(p));
    } finally {
      reader.closeProject();
    }
  }

  // MARK: - Statistics

  /**
   * Retourne les statistiques des sources primaires
   */
  getStatistics(): PrimarySourcesStatistics | null {
    if (!this.vectorStore) {
      return null;
    }

    return this.vectorStore.getStatistics();
  }

  /**
   * Retourne tous les tags
   */
  getAllTags(): string[] {
    if (!this.vectorStore) {
      return [];
    }

    return this.vectorStore.getAllTags();
  }

  /**
   * Retourne les statistiques des entités (Graph RAG)
   */
  getEntityStatistics(): EntityStatistics | null {
    if (!this.vectorStore) {
      return null;
    }

    return this.vectorStore.getEntityStatistics();
  }

  // MARK: - Indexing

  /**
   * Met à jour la transcription d'une source : OCR manuel d'une carte
   * ('tesseract', avec sa confiance), import d'un fichier ('transkribus' ou
   * 'imported'), saisie ('manual', sans confiance).
   *
   * Les extraits de l'ancien texte sont supprimés dans la même transaction que
   * la ligne : ils mentent dès qu'elle change. La réindexation qui suit
   * (`reindexSource`) en écrit de nouveaux ; si elle échoue, la source reste
   * sans extrait et la synchro suivante la reprend.
   *
   * Un texte indexé inchangé (même fichier réimporté, OCR relancé qui rend le
   * même texte, seule la provenance change) garde ses extraits : ils découpent
   * toujours ce texte. Les retirer faisait sortir la source du RAG dès que le
   * fournisseur était en panne. `indexUpToDate` : ces extraits existent, il
   * n'y a rien à réembarquer.
   */
  async updateSourceTranscription(
    sourceId: string,
    transcription: string,
    source: Exclude<NonNullable<PrimarySourceItem['transcriptionSource']>, 'tropy-notes'>,
    confidence?: number
  ): Promise<{ success: boolean; error?: string; code?: 'source-not-found'; indexUpToDate?: boolean }> {
    try {
      const store = this.vectorStore;
      if (!store) {
        return { success: false, error: 'Service not initialized' };
      }

      const written = store.transaction(() => {
        const before = store.getSource(sourceId);
        const rows = store.updateSource(sourceId, {
          transcription,
          transcriptionSource: source,
          ocrConfidence: confidence,
          lastModified: new Date(),
        });
        if (rows === 0) return null;
        const after = store.getSource(sourceId);
        // En-tête, corps et notes : ce que découpent les extraits. Une source
        // 'tropy-notes' qui devient un corps change de texte (ses notes
        // passent après lui).
        const textChanged = !before || !after || this.indexableText(before) !== this.indexableText(after);
        if (textChanged) {
          store.deleteChunks(sourceId);
          return { indexUpToDate: false };
        }
        return { indexUpToDate: store.getChunks(sourceId).length > 0 };
      });
      // Source absente (purge, autre projet) : rien n'a été écrit.
      if (!written) {
        return { success: false, error: `Source not found: ${sourceId}`, code: 'source-not-found' };
      }

      return { success: true, indexUpToDate: written.indexUpToDate };
    } catch (error: unknown) {
      console.error('Failed to update transcription:', error);
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }


  /**
   * Le texte que découpent les extraits d'une source : son en-tête, son corps,
   * puis ses notes. Deux sources qui donnent le même texte ont les mêmes
   * extraits (`indexSourceChunks` s'en sert pour voir qu'une source a changé
   * pendant son embarquement).
   */
  private indexableText(source: IndexableSource): string {
    let fullText = '';
    if (source.title) fullText += `Titre: ${source.title}\n\n`;
    if (source.creator) fullText += `Auteur: ${source.creator}\n`;
    if (source.date) fullText += `Date: ${source.date}\n`;
    if (source.archive) fullText += `Archive: ${source.archive}\n`;
    if (source.collection) fullText += `Collection: ${source.collection}\n`;
    fullText += '\n';
    if (source.transcription) fullText += source.transcription;
    // Les notes Tropy viennent après le corps, qu'elles ne remplacent plus.
    // Une source 'tropy-notes' les a déjà pour transcription.
    if (source.notesText && source.transcriptionSource !== 'tropy-notes') {
      fullText += `\n\n${source.notesText}`;
    }
    return fullText;
  }

  /**
   * Découpe, filtre et déduplique le texte d'une source (`indexableText`) : les
   * extraits à embarquer, sans rien écrire encore.
   */
  private prepareSourceChunks(source: IndexableSource, fullText: string): PrimarySourceChunk[] {
    // Get raw chunks from DocumentChunker for optimization
    const rawChunks = this.getRawChunks(fullText, source.id, { title: source.title });
    const initialChunkCount = rawChunks.length;

    // Les extraits qui ne sont pas une fin contenue dans le précédent.
    const wholeChunks = withoutContainedChunks(rawChunks);
    let optimizedChunks = wholeChunks;

    // Quality filtering - remove low-quality chunks (works on DocumentChunk type)
    if (this.qualityScorer && rawChunks.length > 0) {
      // Une archive n'a pas à faire des phrases ni 20 mots : un télégramme
      // (« … STOP »), une liste nominative, un registre ou une courte note
      // sans point perdaient tous leurs extraits (S08-2-0). Restent les
      // filtres d'entropie, de mots distincts et de longueur des mots.
      const qualityResult = this.qualityScorer.filterByQuality(rawChunks, {
        minEntropy: 0.3,
        minUniqueWordRatio: 0.4,
        minSentenceCount: 0,
        minWordCount: 3,
      }, false); // Don't log each filtered chunk

      if (qualityResult.stats.filteredChunks > 0) {
        console.log(`🎯 [TROPY] Quality filtering for "${source.title}": ${qualityResult.stats.passedChunks}/${qualityResult.stats.totalChunks} passed`);
      }
      // Une fin contenue dans l'extrait précédent ne s'écarte, comme
      // redondante, que si cet extrait est gardé. Écartée avant le filtre, elle
      // emportait les dernières entrées d'un registre dont l'extrait qui la
      // contient était trop répétitif pour le filtre.
      let kept = withoutContainedChunks(qualityResult.passed);
      // Une source transcrite a au moins un extrait plein : quand aucun ne
      // passe (feuille d'appel trop répétitive, texte de deux mots), le
      // meilleur reste, avec les fins gardées qu'il ne contient pas. Sans lui,
      // le panneau la disait transcrite, mais ni l'assistant ni `search_tropy`
      // ne la trouvaient jamais. La synchro suivante reprend d'elle-même une
      // source restée sans extrait.
      if (!kept.some((chunk) => wholeChunks.includes(chunk))) {
        const best = this.qualityScorer.bestChunk(wholeChunks);
        if (best) kept = withoutContainedChunks([best, ...kept].sort((a, b) => a.chunkIndex - b.chunkIndex));
      }
      optimizedChunks = kept;
    }

    // Deduplication - remove duplicate chunks (works on DocumentChunk type)
    if (this.deduplicator && optimizedChunks.length > 0) {
      const dedupResult = this.deduplicator.deduplicate(optimizedChunks, {
        useContentHash: true,
        useSimilarity: false, // Fast mode - hash only
      });

      if (dedupResult.duplicateCount > 0) {
        console.log(`🔄 [TROPY] Deduplication for "${source.title}": removed ${dedupResult.duplicateCount} duplicates`);
      }
      optimizedChunks = dedupResult.uniqueChunks;
    }

    // Log optimization results
    if (optimizedChunks.length !== initialChunkCount) {
      console.log(`📊 [TROPY] Chunks for "${source.title}": ${initialChunkCount} → ${optimizedChunks.length} after optimization`);
    }

    // Convert to source chunks format, with their quality score
    return optimizedChunks.map((rawChunk) => ({
      id: rawChunk.id,
      sourceId: source.id,
      content: rawChunk.content,
      chunkIndex: rawChunk.chunkIndex,
      startPosition: rawChunk.startPosition,
      endPosition: rawChunk.endPosition,
      qualityScore: this.qualityScorer
        ? this.qualityScorer.scoreChunk(rawChunk.content).overallScore
        : undefined,
    }));
  }

  /**
   * Découpe, embarque puis écrit les extraits d'une source, tout ou rien.
   *
   * Tous les extraits sont embarqués en mémoire avant la moindre écriture, puis
   * remplacent l'ancien jeu dans une transaction (`replaceSourceChunks`). Le
   * premier échec d'embarquement lève sans rien écrire : un échec avalé
   * extrait par extrait laissait la source à 9 extraits sur 10, et la synchro,
   * qui ne reprend que les sources sans extrait, ne complétait jamais le trou
   * (S08-1-30). Partagé par la synchro et `reindexSource`.
   *
   * `superseded` : la source a changé (ou disparu) pendant l'embarquement, et
   * rien n'est écrit. Une passe partie avec l'ancien texte écrasait sinon les
   * extraits que l'écriture de transcription venait de produire : la source
   * gardait des extraits d'un texte qui n'existait plus, et le filtre « sans
   * extrait » de la synchro ne la reprenait jamais. L'écrivain plus récent a
   * sa propre réindexation, ou bien la source reste sans extrait (il les a
   * retirés) et la synchro suivante la reprend. Ce n'est pas une panne.
   */
  private async indexSourceChunks(source: IndexableSource): Promise<IndexOutcome> {
    // Le magasin du départ : un changement de projet pendant l'embarquement ne
    // doit pas faire écrire ces extraits dans celui du projet suivant.
    const store = this.vectorStore;
    if (!store) {
      throw new Error('tropy-service: vector store not initialized');
    }

    const text = this.indexableText(source);
    const items: Array<{ chunk: PrimarySourceChunk; embedding: Float32Array }> = [];
    for (const chunk of this.prepareSourceChunks(source, text)) {
      const embedding = await this.embedOne(chunk.content);
      // Dès le premier vecteur, le refus d'un corpus d'une autre dimension (L06-9) : la source
      // s'embarquait sinon en entier, pour être refusée à l'écriture (`replaceSourceChunks`).
      if (items.length === 0) store.checkEmbeddingDimension(embedding.length, source.id);
      items.push({ chunk, embedding });
    }

    // Relire la source puis écrire, sans `await` entre les deux : better-sqlite3
    // est synchrone, aucun autre écrivain du main ne peut s'intercaler.
    const current = store.getSource(source.id);
    if (!current || this.indexableText(current) !== text) {
      return { status: 'superseded' };
    }
    store.replaceSourceChunks(source.id, items);
    return { status: 'written', chunks: items.length };
  }

  /**
   * Réembarque une source et remplace ses extraits, tout ou rien.
   *
   * Jamais `success: true` quand l'embarquement a échoué : la source sortait du
   * RAG en silence. Un échec laisse les extraits en place — ceux d'un texte inchangé
   * restent bons ; après une écriture qui change le texte il n'y en a plus
   * (`updateSourceTranscription` les retire), et la synchro suivante reprend
   * la source. Une source réécrite pendant la réindexation n'est pas un échec :
   * rien n'est écrit, et le texte plus récent a sa propre indexation.
   */
  async reindexSource(sourceId: string): Promise<{ success: boolean; error?: string; code?: ReindexFailure }> {
    try {
      // Le magasin du départ, que `indexSourceChunks` capture aussi.
      const store = this.vectorStore;
      if (!store) {
        return { success: false, error: 'Service not initialized' };
      }

      const source = store.getSource(sourceId);
      if (!source) {
        return { success: false, error: `Source not found: ${sourceId}`, code: 'source-not-found' };
      }
      if (!this.embedding) {
        return { success: false, error: 'No embedding provider configured', code: 'no-embedding-provider' };
      }

      const outcome = await this.indexSourceChunks(source);
      if (outcome.status === 'superseded') {
        // Réécrite entre-temps : son écrivain suivant la réindexe, ou la
        // synchro la reprend. L'écriture de cet appel a bien eu lieu.
        console.log(`🔁 [TROPY] Source ${sourceId} modifiée pendant sa réindexation : rien d'écrit, le texte plus récent l'emporte`);
        return { success: true };
      }
      // L'index sur disque tout de suite : il ne s'écrivait qu'à la fermeture
      // du magasin, et une app plantée ou arrêtée de force avant relisait
      // celui d'avant, sans ces extraits, à reconstruire en entier à la relance
      // (S08-1-23). Une vingtaine de millisecondes pour 40 650 extraits
      // (mesuré). Projet changé entre-temps : sa fermeture l'a écrit.
      if (this.vectorStore === store) store.saveHNSWIndex();
      console.log(`🔁 [TROPY] Source ${sourceId} réindexée : ${outcome.chunks} chunk(s)`);
      return { success: true };
    } catch (error: unknown) {
      console.error('Failed to reindex source:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof EmbeddingSpaceMismatchError ? 'embedding-space-changed' : 'embedding-failed',
      };
    }
  }

  // MARK: - Réindexation complète

  /** Où en est la réindexation complète du projet ouvert, pour un panneau qui s'ouvre. */
  getReindexStatus(): TropyReindexStatus {
    return this.reindexStatus;
  }

  /**
   * Se résout quand les réindexations complètes lancées jusqu'ici sont finies
   * ou arrêtées, y compris celle d'un projet quitté.
   */
  async whenFullReindexSettled(): Promise<void> {
    await Promise.all([...this.reindexRuns.keys()]);
  }

  /**
   * La dimension du fournisseur d'embeddings, s'il y en a un et qu'il la connaît. C'est celle qu'il
   * déclare : Ollama, OpenAI et Mistral refusent tout vecteur d'une autre taille, et Gemini comme le
   * modèle embarqué n'ont qu'un modèle, de dimension connue. Un vecteur écrit a donc toujours cette
   * dimension (`tropy-declared-dimension.test.ts`). Un modèle Ollama hors de la table de l'adaptateur
   * (bge-m3) est déclaré en 768 et ne rend rien (S05-1-14, L07-12) ; quand L07-12 lui fera adopter
   * la dimension de sa première réponse, la proposition (Q29) et le filtre de la passe d'ouverture
   * (J7) devront lire celle-là, et ne rien conclure d'une dimension seulement supposée.
   */
  private embeddingDimension(): number | undefined {
    const dimension = this.embedding?.dimension;
    return dimension && dimension > 0 ? dimension : undefined;
  }

  /**
   * Lance une passe sur le magasin ouvert : celle d'ouverture (H7), celle que l'historien a
   * confirmée après un changement de modèle (`model-change`, Q29), ou le contrôle de l'index après
   * un changement de fournisseur (`provider-change`). Une passe à la fois par magasin : la seconde
   * attend la fin de la première. Finie, la proposition a pu changer : le panneau la relit.
   */
  private startFullReindex(cause?: FullReindexCause): void {
    const store = this.vectorStore;
    const projectPath = this.projectPath;
    if (!store || !projectPath) return;
    const previous = [...this.reindexRuns].filter(([, of]) => of === store).map(([run]) => run);
    const pass = (): Promise<void> => this.reindexOutdatedChunks(store, projectPath, cause);
    const started =
      previous.length === 0
        ? pass()
        : Promise.all(previous).then(() => (this.vectorStore === store ? pass() : undefined));
    const run: Promise<void> = started.finally(() => {
      this.reindexRuns.delete(run);
      if (cause === 'model-change' && this.reembedPending === store) this.reembedPending = null;
      this.announceReembedProposal(store);
    });
    this.reindexRuns.set(run, store);
  }

  /**
   * La réindexation proposée après un changement de modèle d'embeddings (J7, Q29) : les sources
   * dont des extraits sont à une autre dimension que celle du fournisseur. Les questions du chat,
   * à la nouvelle, ne peuvent pas comparer leurs vecteurs : elles sortent de la recherche par le
   * sens. Proposée dans le panneau des sources primaires, jamais faite d'office ; `null` sans
   * fournisseur (aucune dimension à viser), sans rien à refaire, ou quand la passe confirmée
   * tourne, que son message dit.
   */
  getReembedProposal(): TropyReembedProposal | null {
    const store = this.vectorStore;
    const actual = this.embeddingDimension();
    if (!store || !actual || this.reembedPending === store) return null;
    const sources = store.listOtherDimensionSources(actual);
    if (sources.length === 0) return null;
    // Une première ligne lue, pas la dimension majoritaire : la proposition est relue au moins deux
    // fois à chaque ouverture du projet, et la répartition parcourt tous les extraits.
    const expected = store.otherEmbeddingDimension(actual);
    if (expected === null) return null;
    return {
      sources: sources.length,
      chunks: sources.reduce((sum, source) => sum + source.chunks, 0),
      expected,
      actual,
    };
  }

  /**
   * « Réindexer », confirmé par l'historien (Q29) : la passe de H7, sur les sources d'une autre
   * dimension que le fournisseur, à la sienne. Source par source, en arrière-plan, dite dans le
   * panneau et la barre d'état ; transcriptions, notes et métadonnées gardées, Tropy ni relu ni
   * repassé à l'OCR. Interrompue (projet fermé, app quittée), elle ne reprend pas seule : les
   * sources restantes sont toujours à l'autre dimension, et la proposition revient.
   */
  requestReembed(): ReembedRequest {
    const store = this.vectorStore;
    if (!store) return { started: false, reason: 'nothing-to-reembed' };
    if (this.reembedPending === store) return { started: true };
    const dimension = this.embeddingDimension();
    if (!dimension) return { started: false, reason: 'no-embedding-provider' };
    if (store.listOtherDimensionSources(dimension).length === 0) {
      return { started: false, reason: 'nothing-to-reembed' };
    }
    this.reembedPending = store;
    this.startFullReindex('model-change');
    this.announceReembedProposal(store);
    return { started: true };
  }

  /**
   * Dit au renderer que la proposition de réindexation a pu changer, pour le magasin du projet
   * ouvert : il la relit (`tropy:get-reembed-proposal`), avec le projet qu'il affiche.
   */
  private announceReembedProposal(store: PrimarySourcesVectorStore): void {
    if (this.vectorStore !== store) return;
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('tropy:reembed-proposal-changed');
    });
  }

  /**
   * Dit au renderer où en est la réindexation de `store`, tant qu'il est le
   * magasin du projet ouvert : celle d'un projet quitté se tait.
   */
  private reportReindex(store: PrimarySourcesVectorStore, status: TropyReindexStatus): void {
    if (this.vectorStore !== store) return;
    // Déjà dit : la reconstruction de départ et la première source disent le même état.
    if (JSON.stringify(status) === JSON.stringify(this.reindexStatus)) return;
    this.reindexStatus = status;
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('tropy:reindex-progress', status);
    });
  }

  /**
   * Refait une fois les extraits écrits avant `TROPY_CHUNKS_VERSION` (H7) : une
   * source renommée dans Tropy avant L06-2 gardait son ancien titre dans ses
   * extraits, et plus rien ne le voyait.
   *
   * Source par source, par le chemin de la synchro (`indexSourceChunks`) : les
   * extraits d'une source sont remplacés d'un bloc, jamais retirés avant que
   * les nouveaux soient prêts, et le RAG garde toutes les sources pendant la
   * passe. La marque d'une source tombe avec l'écriture de ses nouveaux
   * extraits (`replaceSourceChunks`) : une interruption (projet fermé ou
   * changé, fournisseur absent ou en panne) laisse les suivantes marquées, et
   * la passe reprend à la prochaine ouverture, là où elle en était. Seuls les
   * extraits et leurs vecteurs changent : transcriptions, notes et métadonnées
   * ne sont jamais réécrites.
   *
   * Elle cède le magasin à une synchronisation (`sync`) : la source en cours
   * s'écrit, puis la passe attend la fin de la synchro et reprend. Une source
   * dont l'embarquement échoue deux fois de suite l'arrête : un Ollama arrêté
   * ferait échouer toutes les suivantes. HNSW et BM25, alimentés au fil de la
   * passe, sont reconstruits une fois à la fin, par tranches, sans les points
   * des anciens extraits (`rebuildIndexesInSlices`).
   *
   * Chaque passe commence par contrôler l'index HNSW relu du disque, même sans
   * source à refaire (`checkHnswIndex`). Il ne s'écrit qu'à la fermeture du
   * magasin, après une synchro ou la réindexation d'une source, et en fin de
   * reconstruction, et l'app plantée ou arrêtée de force en pleine passe
   * laissait celui d'avant : les sources refaites échappaient à la recherche
   * dense, toutes et pour de bon si l'arrêt tombait pendant la reconstruction
   * finale. En retard, il est reconstruit par
   * tranches avant la suite, à la dimension du fournisseur d'embeddings : après
   * un changement de modèle, la base mêle deux dimensions jusqu'à la fin de la
   * passe. Plus aucune source à refaire, cette reconstruction est dite à
   * l'écran si des extraits manquent à l'index, puis sa fin.
   *
   * Après un changement de modèle d'embeddings (J7) : les sources dont des
   * extraits sont à une autre dimension que celle du fournisseur ne sont pas
   * réembarquées à l'ouverture, qui enverrait tout le corpus au fournisseur
   * sans geste de l'historien. Elles lui sont proposées
   * (`getReembedProposal`), et, confirmée (`cause: 'model-change'`, Q29), la
   * passe les refait par ce même chemin. Elle fait alors passer l'index à la
   * dimension du fournisseur, par tranches, une fois qu'il a répondu
   * (`probeProvider`) : les points de l'ancienne ne servent plus aucune
   * question, et les extraits refaits y entrent au fil de la passe.
   * Interrompue, elle ne reprend pas seule à la prochaine ouverture : les
   * sources restantes sont toujours à l'autre dimension, et elle est proposée
   * de nouveau. Le modèle changé de nouveau dans les Paramètres pendant la
   * passe l'arrête : ce qui reste n'est plus à refaire pour lui.
   *
   * Après un changement de fournisseur dans les Paramètres
   * (`cause: 'provider-change'`), seul le contrôle de l'index a lieu, à la
   * dimension du nouveau, sans rien réembarquer ; sa reconstruction est dite à
   * l'écran comme celle de l'ouverture, avec sa propre raison.
   *
   * Au journal d'usage IA, un lot d'embeddings par source, inscrit dès qu'elle
   * est finie, et lié au projet de la passe : une passe interrompue laisse la
   * trace de ce qu'elle a fait, et un changement de projet n'inscrit rien dans
   * le journal du suivant (`recordBatch` de `usage-journal-service`).
   */
  private async reindexOutdatedChunks(
    store: PrimarySourcesVectorStore,
    projectPath: string,
    cause?: FullReindexCause
  ): Promise<void> {
    const reembed = cause === 'model-change';
    // Après un changement de fournisseur : le contrôle de l'index seul, aucune source refaite.
    const indexOnly = cause === 'provider-change';
    const tag = reembed ? { cause: 'model-change' as const } : {};
    try {
      // La dimension du fournisseur, celle des questions du chat ; sans fournisseur, celle de l'index.
      const providerDimension = this.embeddingDimension();
      const dimension = providerDimension ?? store.getIndexStats().hnswDimension;
      const remainingSources = (): Array<{ id: string; chunks: number }> =>
        reembed ? store.listOtherDimensionSources(dimension) : store.listOutdatedChunkSources(dimension);
      const stillToDo = (id: string): boolean =>
        reembed ? store.hasOtherDimensionChunks(id, dimension) : store.hasOutdatedChunks(id, dimension);
      const outdated = indexOnly ? [] : remainingSources();
      const total = outdated.length;
      const chunks = outdated.reduce((sum, source) => sum + source.chunks, 0);
      const running = (done: number, waitingForSync: boolean): TropyReindexStatus => ({
        phase: 'running',
        ...tag,
        done,
        total,
        chunks,
        waitingForSync,
      });
      // Le modèle changé dans les Paramètres depuis le début de la passe : ses sources ne sont plus
      // à refaire pour lui, ni à la même dimension. Le contrôle que ce changement lance prend la
      // suite (`rebuildProviders`), et la réindexation est proposée de nouveau s'il le faut.
      const providerChanged = (): boolean => this.embeddingDimension() !== providerDimension;

      // Contrôlé avant la première attente : la reconstruction en cours retient
      // la recherche du chat d'en lancer une autre. À la dimension du
      // fournisseur d'embeddings, celle des questions du chat : après un
      // changement de modèle, l'index relu peut être de l'ancienne alors que
      // des extraits sont déjà refaits à la nouvelle (app quittée en pleine
      // passe). La passe confirmée doit y faire passer l'index ; sans aucun
      // extrait à cette dimension (`index.dimension`, celle de l'index relu),
      // elle ne le fait qu'au premier extrait qu'elle écrit, une fois que le
      // fournisseur a répondu (`probeProvider`). Fait ici, l'index vide
      // s'écrivait sur disque à la place de celui de l'ancien modèle, même
      // quand le nouveau ne répondait pas.
      const index = store.checkHnswIndex(providerDimension);
      let switchPending = reembed && total > 0 && index.dimension !== dimension;
      const target = index.dimension;
      if (!switchPending && (index.needsRebuild || target !== store.getIndexStats().hnswDimension)) {
        console.log(
          `🔨 [TROPY-SERVICE] Index des sources primaires en retard sur la base (${index.missing} extrait(s) absent(s), ${index.stale} point(s) inutile(s)) : reconstruction par tranches, dimension ${target}`
        );
        // Plus aucune source à refaire, mais des extraits manquent à l'index
        // (app quittée pendant la reconstruction finale, ou après une
        // transcription) : la recherche par le sens ne les trouve pas avant la
        // fin, une centaine de secondes sur 40 000 extraits. Dit à l'écran,
        // comme sa fin. Des points inutiles seuls ne changent rien à la
        // recherche : leur compactage se tait.
        // Après un changement de fournisseur, la raison est autre : l'index n'a
        // pas été perdu, il passe à la dimension du modèle choisi.
        const announced = total === 0 && index.missing > 0;
        const why = indexOnly ? { cause: 'model-change' as const } : {};
        if (total > 0) {
          this.reportReindex(store, running(0, false));
        } else if (announced) {
          this.reportReindex(store, { phase: 'rebuilding-index', ...why, missing: index.missing });
        }
        const rebuild = store.rebuildIndexesInSlices(undefined, target);
        this.reindexStep = rebuild;
        if (!(await rebuild) || this.vectorStore !== store) return;
        if (announced) {
          this.reportReindex(store, { phase: 'index-rebuilt', ...why });
          // Dit une fois, comme la fin d'une passe.
          this.reindexStatus = { phase: 'idle' };
        }
      }

      if (total === 0) return;
      console.log(
        reembed
          ? `🔁 [TROPY-SERVICE] Réindexation pour le nouveau modèle : ${total} source(s), ${chunks} extrait(s) à une autre dimension que ${dimension}`
          : `🔁 [TROPY-SERVICE] Réindexation complète : ${total} source(s), ${chunks} extrait(s) d'avant la version ${TROPY_CHUNKS_VERSION}`
      );

      let done = 0;
      let written = 0;
      let stopped: 'no-embedding-provider' | 'embedding-failed' | null = null;
      // Une seconde chance par source : sur des heures de requêtes, une coupure
      // passagère (connexion réinitialisée, délai) ne doit pas arrêter la passe
      // jusqu'à la prochaine ouverture. Un fournisseur en panne échoue deux fois.
      let retried = false;
      for (let i = 0; i < outdated.length; ) {
        const { id } = outdated[i];
        while (this.syncsRunning > 0 && this.vectorStore === store) {
          this.reportReindex(store, running(done, true));
          await new Promise<void>((resume) => this.syncWaiters.push(resume));
        }
        // Projet fermé ou changé : la suite reprendra à sa prochaine ouverture,
        // ou, pour un changement de modèle, y sera proposée de nouveau.
        if (this.vectorStore !== store) return;
        if (!this.embedding) {
          stopped = 'no-embedding-provider';
          break;
        }
        this.reportReindex(store, running(done, false));

        // Refaite ou vidée depuis par la synchro ou une transcription : plus rien à faire ici.
        const source = store.getSource(id);
        if (source && stillToDo(id)) {
          if (!reembed && !source.transcription?.trim()) {
            // Comme la synchro : sans transcription, rien à embarquer ; ses
            // extraits sont gardés. La passe confirmée refait toutes ses
            // sources : des extraits d'une autre dimension ne servent plus la
            // recherche par le sens, transcription ou non.
            store.markChunksCurrent(id);
          } else {
            try {
              if (switchPending) {
                // Le fournisseur a répondu, à sa dimension, avant que l'index n'y passe.
                await this.probeProvider(projectPath, source, dimension);
                if (this.vectorStore !== store) return;
                if (!providerChanged()) {
                  console.log(`🔨 [TROPY-SERVICE] Index des sources primaires porté à la dimension du nouveau modèle, ${dimension}, par tranches`);
                  const rebuild = store.rebuildIndexesInSlices(undefined, dimension);
                  this.reindexStep = rebuild;
                  if (!(await rebuild) || this.vectorStore !== store) return;
                  switchPending = false;
                }
              }
              if (providerChanged()) {
                console.warn('⚠️ [TROPY-SERVICE] Réindexation arrêtée : le modèle d\'embeddings a changé dans les Paramètres');
                this.reportReindex(store, { phase: 'idle' });
                return;
              }
              const step = runWithJournalContext({ workspaceRoot: projectPath }, () =>
                runBatch('tropy', () => this.indexSourceChunks(source))
              );
              this.reindexStep = step;
              if ((await step).status === 'written') written += 1;
            } catch (error) {
              // Son magasin fermé pendant l'embarquement : ce n'est pas une panne.
              if (this.vectorStore !== store) return;
              // Le modèle a changé pendant la passe : les sources restantes ne sont plus à la
              // dimension du fournisseur, et sa nouvelle réindexation est proposée (Q29). Ni
              // second essai, ni panne à dire.
              if (error instanceof EmbeddingSpaceMismatchError) {
                console.warn(`⚠️ [TROPY-SERVICE] Réindexation arrêtée, le modèle d'embeddings a changé : ${error.message}`);
                this.reportReindex(store, { phase: 'idle' });
                return;
              }
              if (!retried) {
                retried = true;
                console.warn(`⚠️ [TROPY-SERVICE] Réindexation complète : source ${id} en échec, nouvel essai`, error);
                await new Promise((resolve) => setTimeout(resolve, FULL_REINDEX_RETRY_DELAY_MS));
                continue;
              }
              console.error(`❌ [TROPY-SERVICE] Réindexation complète arrêtée à la source ${id}:`, error);
              stopped = 'embedding-failed';
              break;
            }
          }
        }
        retried = false;
        done += 1;
        i += 1;
      }

      if (this.vectorStore !== store) return;
      if (stopped) {
        // Dit avant la reconstruction : la passe est arrêtée, et la
        // reconstruction ne change rien à ce qui reste à faire.
        const remaining = remainingSources().length;
        this.reportReindex(store, { phase: 'stopped', ...tag, reason: stopped, total, remaining });
        console.warn(`⚠️ [TROPY-SERVICE] Réindexation complète arrêtée (${stopped}) : ${remaining} source(s) restent à refaire`);
      } else if (written > 0) {
        // Toutes les sources sont faites : pendant la reconstruction finale,
        // une centaine de secondes sur 40 000 extraits, l'écran ne dit pas
        // qu'il en reste une.
        this.reportReindex(store, running(done, false));
      }
      if (written > 0) {
        // Par tranches : d'un bloc, une centaine de secondes de gel du processus
        // principal sur 40 000 extraits (mesuré). Une synchro attend la fin pour
        // embarquer, comme elle attend une source en cours.
        const rebuild = store.rebuildIndexesInSlices();
        this.reindexStep = rebuild;
        // Magasin fermé en route (app quittée, projet changé) : le contrôle de
        // l'index, à la prochaine ouverture, la refera.
        if (!(await rebuild) || this.vectorStore !== store) return;
      }
      if (!stopped) {
        this.reportReindex(store, { phase: 'done', ...tag, total });
        // Dit une fois : un panneau ouvert plus tard n'a plus rien à annoncer.
        this.reindexStatus = { phase: 'idle' };
        console.log(`✅ [TROPY-SERVICE] Réindexation complète finie : ${total} source(s)`);
      }
    } catch (error: unknown) {
      // Jamais une raison de faire tomber le main. Les sources gardent leur
      // marque ; le message en cours ne doit pas rester figé.
      if (this.vectorStore !== store) return;
      console.warn('⚠️ [TROPY-SERVICE] Réindexation complète interrompue:', error);
      this.reportReindex(store, { phase: 'idle' });
    }
  }

  /**
   * Avant que la passe confirmée (Q29) ne fasse passer l'index à `dimension`, celle du fournisseur :
   * il doit avoir répondu, à cette dimension. Sans aucun extrait à celle-ci, le nouvel index est
   * vide, et il s'écrit sur disque à la place de celui de l'ancien modèle. Un modèle choisi dans les
   * Paramètres mais pas encore installé (`ollama pull`) arrêtait la passe à la première source,
   * l'index de l'ancien déjà perdu : revenu à l'ancien modèle, l'historien n'avait plus que la
   * recherche par les mots, sans message, jusqu'à ce qu'une question lance une reconstruction.
   *
   * Le premier extrait de `source`, la première source à refaire : ce que la passe lui envoie
   * ensuite, rien d'autre. Un lot d'un extrait au journal d'usage IA. Lève l'erreur du fournisseur,
   * ou `EmbeddingSpaceMismatchError` pour un vecteur d'une autre dimension.
   */
  private async probeProvider(projectPath: string, source: IndexableSource, dimension: number): Promise<void> {
    const text = this.prepareSourceChunks(source, this.indexableText(source))[0]?.content ?? this.indexableText(source);
    const vector = await runWithJournalContext({ workspaceRoot: projectPath }, () =>
      runBatch('tropy', () => this.embedOne(text))
    );
    if (vector.length !== dimension) {
      throw new EmbeddingSpaceMismatchError({ kind: 'dimension', expected: dimension, actual: vector.length });
    }
  }

  /**
   * Purge la base de données des sources primaires
   * Supprime toutes les sources, chunks, photos et tags
   */
  async purge(): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.vectorStore || !this.projectPath) {
        return { success: false, error: 'Service not initialized' };
      }

      // Drop and recreate every `tropy_*` table (post db-fusion brain.db
      // hosts other domains, so we can't just unlink the file).
      this.vectorStore.purgeAll();
      // Plus de projet lié : sa surveillance s'arrête aussi (S08-2-9).
      this.stopWatching();
      this.currentTPYPath = null;
      // Plus d'extrait : plus rien à proposer de réindexer (Q29).
      this.announceReembedProposal(this.vectorStore);
      console.log('🗑️ Purged tropy_* tables in brain.db');

      return { success: true };
    } catch (error: unknown) {
      console.error('Failed to purge primary sources database:', error);
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  /**
   * Retourne le chemin de la base de données
   */
  getDatabasePath(): string | null {
    if (!this.projectPath) return null;
    return path.join(this.projectPath, '.cliodeck', 'brain.db');
  }
}

// Singleton
export const tropyService = new TropyService();
