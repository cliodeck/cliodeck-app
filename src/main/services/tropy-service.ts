import { BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { TropyReader, TropyItem, PrimarySourceItem } from '../../../backend/integrations/tropy/TropyReader.js';
import { TropySync, TropySyncOptions, TropySyncResult, TropySyncProgress, TropySyncIssue } from '../../../backend/integrations/tropy/TropySync.js';
import { assessTropyBinding, readTropyProjectIdentity } from '../../../backend/integrations/tropy/tropy-project-identity.js';
import { TropyWatcher } from '../../../backend/integrations/tropy/TropyWatcher.js';
import { TropyOCRPipeline, OCRResult, TranscriptionFormat, SUPPORTED_OCR_LANGUAGES } from '../../../backend/integrations/tropy/TropyOCRPipeline.js';
import { PrimarySourcesVectorStore, PrimarySourceChunk, PrimarySourceDocument, PrimarySourceSearchResult, PrimarySourcesStatistics } from '../../../backend/core/vector-store/PrimarySourcesVectorStore.js';
import type { NERService } from '../../../backend/core/ner/NERService.js';
import type { EntityStatistics, ExtractedEntity } from '../../../backend/types/entity.js';

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
import { runBatch } from '../../../backend/core/usage-journal/context.js';
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

/** Pourquoi une source n'a pas été réindexée, à dire par le renderer. */
export type ReindexFailure = 'source-not-found' | 'no-embedding-provider' | 'embedding-failed';

/** Ce que le découpage d'une source lit : son en-tête, son texte, ses notes. */
type IndexableSource = Pick<
  PrimarySourceDocument,
  'id' | 'title' | 'creator' | 'date' | 'archive' | 'collection' | 'transcription' | 'transcriptionSource' | 'notesText'
>;

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
   * Initialise le service Tropy pour un projet
   */
  async init(projectPath: string): Promise<void> {
    // Bascule de projet : démonter l'instance précédente AVANT de la
    // remplacer. project:load appelle init() sans close() ; sans ce
    // teardown, l'ancien watcher chokidar survivait et son callback
    // `change` — closure sur le singleton — pouvait déclencher une resync
    // sur le projet nouvellement chargé ; l'ancien vector store restait
    // aussi ouvert (fuite de handle SQLite).
    this.stopWatching();
    await this.ocrPipeline?.dispose();
    this.vectorStore?.close();
    this.currentTPYPath = null;

    this.projectPath = projectPath;
    this.vectorStore = new PrimarySourcesVectorStore(projectPath);
    this.tropySync = new TropySync();
    this.watcher = new TropyWatcher();
    this.ocrPipeline = new TropyOCRPipeline();

    // Build the typed provider registry from the active config. Same
    // self-contained lifecycle as retrieval-service: dispose any previous
    // registry before re-init.
    await this.disposePreviousRegistry();
    try {
      const llmConfig = configManager.getLLMConfig();
      this.llmRegistry = createRegistryFromClioDeckConfig(llmConfig);
      this.llm = this.llmRegistry.getLLM();
      this.registry = createRegistryFromClioDeckConfig(llmConfig);
      this.embedding = this.registry.getEmbedding();
    } catch (e) {
      console.warn('[tropy-service] failed to build provider registry:', e);
      await this.disposePreviousRegistry();
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
  }

  /**
   * Ferme le service et libère les ressources
   */
  async close(): Promise<void> {
    this.stopWatching();
    await this.ocrPipeline?.dispose();
    this.vectorStore?.close();
    await this.disposePreviousRegistry();

    this.vectorStore = null;
    this.tropySync = null;
    this.watcher = null;
    this.ocrPipeline = null;
    this.currentTPYPath = null;
    this.projectPath = null;

    // Clean up chunking optimization modules
    this.chunker = null;
    this.qualityScorer = null;
    this.deduplicator = null;
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
      return;
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
    if (!this.tropySync || !this.vectorStore || !this.currentTPYPath) {
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

    const result = await this.tropySync.sync(
      this.currentTPYPath,
      this.vectorStore,
      syncOptions,
      onProgress
    );

    // Phase 2: Générer les embeddings pour les sources avec du texte
    // Always try to generate embeddings - the method will skip sources that already have chunks
    if (result.success) {
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
   * l'assistant ne cite pas encore ces sources.
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

    for (let i = 0; i < sourcesToProcess.length; i++) {
      const source = sourcesToProcess[i];

      onProgress?.({
        phase: 'indexing',
        current: i + 1,
        total: sourcesToProcess.length,
        currentItem: source.title,
      });

      try {
        chunksCreated += await this.indexSourceChunks(source);
        sourcesProcessed++;
      } catch (error) {
        sourcesFailed++;
        console.error(`❌ [TROPY-SERVICE] Failed to process source ${source.id}:`, error);
      }
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
        this.ocrPipeline = new TropyOCRPipeline();
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
        this.ocrPipeline = new TropyOCRPipeline();
      }

      const result = await this.ocrPipeline.performBatchOCR(imagePaths, { language });

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
        this.ocrPipeline = new TropyOCRPipeline();
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

    // Debug: Check index state
    const indexStats = this.vectorStore.getIndexStats();
    console.log(`📜 [TROPY-SERVICE] Index stats: HNSW=${indexStats.hnswSize}, BM25=${indexStats.bm25Size}, dimension=${indexStats.hnswDimension}`);

    const topK = options?.topK || 10;
    // Le store publie la pertinence du contrat commun (`relevance.ts`, échelle
    // du cosinus) : le seuil s'applique donc tel quel. Il était auparavant
    // ramené à 0,005, conversion pensée pour des scores RRF que le store ne
    // publie plus — ce qui revenait à ne filtrer aucun extrait d'archive.
    const threshold = options?.threshold ?? configManager.getRAGConfig().similarityThreshold;

    try {
      if (!this.embedding) {
        console.warn('⚠️ [TROPY-SERVICE] No embedding provider configured, cannot generate embedding');
        return [];
      }

      // Expand query for multilingual search (FR + EN)
      const expandedQuery = await this.expandQueryMultilingual(query);
      console.log(`📜 [TROPY-SERVICE] Expanded query: "${expandedQuery}"`);

      // Generate embedding for the expanded query.
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
    } catch (error) {
      console.error('❌ [TROPY-SERVICE] Search failed:', error);
      return [];
    }
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
   * les fichiers disparus.
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
   */
  async updateSourceTranscription(
    sourceId: string,
    transcription: string,
    source: Exclude<NonNullable<PrimarySourceItem['transcriptionSource']>, 'tropy-notes'>,
    confidence?: number
  ): Promise<{ success: boolean; error?: string; code?: 'source-not-found' }> {
    try {
      const store = this.vectorStore;
      if (!store) {
        return { success: false, error: 'Service not initialized' };
      }

      const changed = store.transaction(() => {
        const rows = store.updateSource(sourceId, {
          transcription,
          transcriptionSource: source,
          ocrConfidence: confidence,
          lastModified: new Date(),
        });
        if (rows > 0) store.deleteChunks(sourceId);
        return rows;
      });
      // Source absente (purge, autre projet) : rien n'a été écrit.
      if (changed === 0) {
        return { success: false, error: `Source not found: ${sourceId}`, code: 'source-not-found' };
      }

      return { success: true };
    } catch (error: unknown) {
      console.error('Failed to update transcription:', error);
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }


  /**
   * Découpe, filtre et déduplique le texte d'une source : les extraits à
   * embarquer, sans rien écrire encore.
   */
  private prepareSourceChunks(source: IndexableSource): PrimarySourceChunk[] {
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

    // Get raw chunks from DocumentChunker for optimization
    const rawChunks = this.getRawChunks(fullText, source.id, { title: source.title });
    const initialChunkCount = rawChunks.length;

    // Quality filtering - remove low-quality chunks (works on DocumentChunk type)
    let optimizedChunks = rawChunks;
    if (this.qualityScorer && optimizedChunks.length > 0) {
      const qualityResult = this.qualityScorer.filterByQuality(optimizedChunks, {
        minEntropy: 0.3,
        minUniqueWordRatio: 0.4,
      }, false); // Don't log each filtered chunk

      if (qualityResult.stats.filteredChunks > 0) {
        console.log(`🎯 [TROPY] Quality filtering for "${source.title}": ${qualityResult.stats.passedChunks}/${qualityResult.stats.totalChunks} passed`);
      }
      optimizedChunks = qualityResult.passed;
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
   * Renvoie le nombre d'extraits écrits.
   *
   * Tous les extraits sont embarqués en mémoire avant la moindre écriture, puis
   * remplacent l'ancien jeu dans une transaction (`replaceSourceChunks`). Le
   * premier échec d'embarquement lève sans rien écrire : un échec avalé
   * extrait par extrait laissait la source à 9 extraits sur 10, et la synchro,
   * qui ne reprend que les sources sans extrait, ne complétait jamais le trou
   * (S08-1-30). Partagé par la synchro et `reindexSource`.
   */
  private async indexSourceChunks(source: IndexableSource): Promise<number> {
    // Le magasin du départ : un changement de projet pendant l'embarquement ne
    // doit pas faire écrire ces extraits dans celui du projet suivant.
    const store = this.vectorStore;
    if (!store) {
      throw new Error('tropy-service: vector store not initialized');
    }

    const items: Array<{ chunk: PrimarySourceChunk; embedding: Float32Array }> = [];
    for (const chunk of this.prepareSourceChunks(source)) {
      items.push({ chunk, embedding: await this.embedOne(chunk.content) });
    }
    store.replaceSourceChunks(source.id, items);
    return items.length;
  }

  /**
   * Réembarque une source et remplace ses extraits, tout ou rien.
   *
   * Jamais `success: true` quand l'embarquement a échoué : la source sortait du
   * RAG en silence. Un échec laisse les extraits en place — ceux d'un texte inchangé
   * restent bons ; après une écriture de transcription il n'y en a plus
   * (`updateSourceTranscription` les retire), et la synchro suivante reprend
   * la source.
   */
  async reindexSource(sourceId: string): Promise<{ success: boolean; error?: string; code?: ReindexFailure }> {
    try {
      if (!this.vectorStore) {
        return { success: false, error: 'Service not initialized' };
      }

      const source = this.vectorStore.getSource(sourceId);
      if (!source) {
        return { success: false, error: `Source not found: ${sourceId}`, code: 'source-not-found' };
      }
      if (!this.embedding) {
        return { success: false, error: 'No embedding provider configured', code: 'no-embedding-provider' };
      }

      const chunks = await this.indexSourceChunks(source);
      console.log(`🔁 [TROPY] Source ${sourceId} réindexée : ${chunks} chunk(s)`);
      return { success: true };
    } catch (error: unknown) {
      console.error('Failed to reindex source:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        code: 'embedding-failed',
      };
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
