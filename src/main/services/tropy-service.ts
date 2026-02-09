import { BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { TropyReader, TropyItem, PrimarySourceItem } from '../../../backend/integrations/tropy/TropyReader.js';
import { TropySync, TropySyncOptions, TropySyncResult, TropySyncProgress } from '../../../backend/integrations/tropy/TropySync.js';
import { TropyWatcher } from '../../../backend/integrations/tropy/TropyWatcher.js';
import { TropyOCRPipeline, OCRResult, TranscriptionFormat, SUPPORTED_OCR_LANGUAGES } from '../../../backend/integrations/tropy/TropyOCRPipeline.js';
import { PrimarySourcesVectorStore, PrimarySourceDocument, PrimarySourceSearchResult, PrimarySourcesStatistics } from '../../../backend/core/vector-store/PrimarySourcesVectorStore.js';
import { NERService, createNERService } from '../../../backend/core/ner/NERService.js';
import type { EntityStatistics, ExtractedEntity } from '../../../backend/types/entity.js';

// Chunking optimization modules
import { DocumentChunker, CHUNKING_CONFIGS } from '../../../backend/core/chunking/DocumentChunker.js';
import { ChunkQualityScorer } from '../../../backend/core/chunking/ChunkQualityScorer.js';
import { ChunkDeduplicator } from '../../../backend/core/chunking/ChunkDeduplicator.js';

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
}

export interface TropySearchResult {
  success: boolean;
  results?: PrimarySourceSearchResult[];
  error?: string;
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
   * Initialise le service Tropy pour un projet
   */
  async init(projectPath: string): Promise<void> {
    this.projectPath = projectPath;
    this.vectorStore = new PrimarySourcesVectorStore(projectPath);
    this.tropySync = new TropySync();
    this.watcher = new TropyWatcher();
    this.ocrPipeline = new TropyOCRPipeline();

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

      // Démarrer le watcher si auto-sync était activé
      if (existingProject.autoSync && fs.existsSync(existingProject.tpyPath)) {
        this.startWatching(existingProject.tpyPath);
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
    } catch (error: any) {
      console.error('Failed to open Tropy project:', error);
      return { success: false, error: error.message };
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
        errors: ['Service not initialized or no project opened'],
      };
    }

    // Notifier la progression via IPC
    const onProgress = (progress: TropySyncProgress) => {
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send('tropy:sync-progress', progress);
      });
    };

    // Get OllamaClient for NER extraction
    let ollamaClient = null;
    try {
      const { pdfService } = await import('./pdf-service.js');
      ollamaClient = pdfService.getOllamaClient();
    } catch (error) {
      console.warn('⚠️ [TROPY-SERVICE] Could not get OllamaClient for NER:', error);
    }

    // Phase 1: Synchroniser les métadonnées (includes NER if ollamaClient is available)
    const syncOptions = {
      ...options,
      ollamaClient,  // Pass to TropySync for NER extraction
      extractEntities: options.extractEntities === true,  // Disabled by default (opt-in due to slow performance)
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
        const embeddingResult = await this.generateEmbeddingsForSources(onProgress);
        console.log(`📐 [TROPY-SERVICE] Embeddings generated: ${embeddingResult.chunksCreated} chunks for ${embeddingResult.sourcesProcessed} sources`);

        // Save HNSW index after embedding generation
        if (embeddingResult.chunksCreated > 0 && this.vectorStore) {
          console.log('💾 [TROPY-SERVICE] Saving HNSW index...');
          this.vectorStore.saveHNSWIndex();
          const stats = this.vectorStore.getIndexStats();
          console.log(`💾 [TROPY-SERVICE] Index saved. HNSW: ${stats.hnswSize}, BM25: ${stats.bm25Size}`);
        }
      } catch (error: any) {
        console.error('❌ [TROPY-SERVICE] Embedding generation failed:', error);
        result.errors.push(`Embedding generation failed: ${error.message}`);
      }
    }

    return result;
  }

  /**
   * Génère les embeddings pour toutes les sources qui n'en ont pas encore
   */
  private async generateEmbeddingsForSources(
    onProgress?: (progress: TropySyncProgress) => void
  ): Promise<{ sourcesProcessed: number; chunksCreated: number }> {
    if (!this.vectorStore) {
      return { sourcesProcessed: 0, chunksCreated: 0 };
    }

    // Import OllamaClient dynamically to avoid circular dependencies
    const { pdfService } = await import('./pdf-service.js');
    const ollamaClient = pdfService.getOllamaClient();

    if (!ollamaClient) {
      console.warn('⚠️ [TROPY-SERVICE] OllamaClient not available, skipping embedding generation');
      return { sourcesProcessed: 0, chunksCreated: 0 };
    }

    // Récupérer toutes les sources
    const allSources = this.vectorStore.getAllSources();
    let sourcesProcessed = 0;
    let chunksCreated = 0;

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
        // Créer le texte complet pour le chunking
        let fullText = '';
        if (source.title) fullText += `Titre: ${source.title}\n\n`;
        if (source.creator) fullText += `Auteur: ${source.creator}\n`;
        if (source.date) fullText += `Date: ${source.date}\n`;
        if (source.archive) fullText += `Archive: ${source.archive}\n`;
        if (source.collection) fullText += `Collection: ${source.collection}\n`;
        fullText += '\n';
        if (source.transcription) fullText += source.transcription;

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

        // Convert to source chunks format and generate embeddings
        for (const rawChunk of optimizedChunks) {
          try {
            const sourceChunk = {
              id: rawChunk.id,
              sourceId: source.id,
              content: rawChunk.content,
              chunkIndex: rawChunk.chunkIndex,
              startPosition: rawChunk.startPosition,
              endPosition: rawChunk.endPosition,
            };
            const embedding = await ollamaClient.generateEmbedding(sourceChunk.content);
            this.vectorStore!.saveChunk(sourceChunk, embedding);
            chunksCreated++;
          } catch (error) {
            console.warn(`⚠️ [TROPY-SERVICE] Failed to generate embedding for chunk in source ${source.id}:`, error);
          }
        }

        sourcesProcessed++;
      } catch (error) {
        console.error(`❌ [TROPY-SERVICE] Failed to process source ${source.id}:`, error);
      }
    }

    return { sourcesProcessed, chunksCreated };
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
   * Démarre la surveillance du fichier .tpy
   */
  startWatching(tpyPath?: string): { success: boolean; error?: string } {
    const pathToWatch = tpyPath || this.currentTPYPath;

    if (!pathToWatch) {
      return { success: false, error: 'No project path specified' };
    }

    if (!this.watcher) {
      this.watcher = new TropyWatcher();
    }

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
    this.currentTPYPath = pathToWatch;

    return { success: true };
  }

  /**
   * Arrête la surveillance
   */
  stopWatching(): void {
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
    } catch (error: any) {
      console.error('OCR failed:', error);
      return { success: false, error: error.message };
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
    } catch (error: any) {
      console.error('Batch OCR failed:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Retourne les langues OCR supportées
   */
  getSupportedOCRLanguages(): Array<{ code: string; name: string }> {
    return [...SUPPORTED_OCR_LANGUAGES];
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
    } catch (error: any) {
      console.error('Transcription import failed:', error);
      return { success: false, error: error.message };
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
    // RRF (Reciprocal Rank Fusion) scores are much smaller than cosine similarity
    // Typical RRF scores range from 0.001 to 0.02 due to the formula: weight / (k + rank)
    // We use a very low threshold (0.005) to allow RRF results through
    // If the passed threshold is high (>0.05), it's likely meant for cosine similarity
    // so we convert it to an appropriate RRF threshold
    const passedThreshold = options?.threshold || 0.2;
    const threshold = passedThreshold > 0.05 ? 0.005 : passedThreshold;

    try {
      // Import OllamaClient dynamically to avoid circular dependencies
      const { pdfService } = await import('./pdf-service.js');
      const ollamaClient = pdfService.getOllamaClient();

      if (!ollamaClient) {
        console.warn('⚠️ [TROPY-SERVICE] OllamaClient not available, cannot generate embedding');
        return [];
      }

      // Expand query for multilingual search (FR + EN)
      const expandedQuery = await this.expandQueryMultilingual(query, ollamaClient);
      console.log(`📜 [TROPY-SERVICE] Expanded query: "${expandedQuery}"`);

      // Generate embedding for the expanded query
      const queryEmbedding = await ollamaClient.generateEmbedding(expandedQuery);
      console.log(`📜 [TROPY-SERVICE] Query embedding generated, dimension: ${queryEmbedding.length}`);

      // Search using hybrid search (HNSW + BM25) - pass both embedding and text
      const results = this.vectorStore.search(queryEmbedding, topK * 2, expandedQuery);

      // Filter by threshold - results already include source data
      let enrichedResults = results.filter((r) => r.similarity >= threshold);

      console.log(`📜 [TROPY-SERVICE] Hybrid search found ${enrichedResults.length} results (RRF threshold: ${threshold})`);

      // Fallback: if all results are filtered out but we have results, keep top ones
      if (enrichedResults.length === 0 && results.length > 0) {
        const minFallbackResults = Math.min(topK, results.length);
        console.warn(`⚠️ [TROPY-SERVICE] All results below threshold, applying fallback: keeping top ${minFallbackResults}`);
        console.warn(`⚠️ [TROPY-SERVICE] Best RRF score: ${results[0].similarity.toFixed(4)}`);
        enrichedResults = results.slice(0, minFallbackResults);
      }

      // Debug: Show top result if any
      if (enrichedResults.length > 0) {
        const topResult = enrichedResults[0];
        console.log(`📜 [TROPY-SERVICE] Top result: "${topResult.source?.title}" (RRF score: ${topResult.similarity.toFixed(4)})`);
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
   * Expand query with multilingual terms (FR/EN)
   * This helps find relevant results across languages
   */
  private async expandQueryMultilingual(query: string, ollamaClient: any): Promise<string> {
    // Simple heuristic: if query is short, keep it as is
    if (query.length < 20) {
      return query;
    }

    // For longer queries, we could use LLM to translate key terms
    // For now, just return the original query
    // TODO: Add LLM-based term expansion for better cross-lingual search
    return query;
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
    // Convert high thresholds (meant for cosine similarity) to RRF-appropriate values
    const passedThreshold = options?.threshold || 0.2;
    const threshold = passedThreshold > 0.05 ? 0.005 : passedThreshold;
    const useEntities = options?.useEntities ?? true;

    try {
      // Import OllamaClient dynamically
      const { pdfService } = await import('./pdf-service.js');
      const ollamaClient = pdfService.getOllamaClient();

      if (!ollamaClient) {
        console.warn('⚠️ [TROPY-SERVICE] OllamaClient not available');
        return [];
      }

      // Initialize NER service if needed
      if (!this.nerService && useEntities) {
        this.nerService = createNERService(ollamaClient);
        console.log('🏷️ [TROPY-SERVICE] NER service initialized');
      }

      // Generate query embedding
      const expandedQuery = await this.expandQueryMultilingual(query, ollamaClient);
      const queryEmbedding = await ollamaClient.generateEmbedding(expandedQuery);

      // If not using entities, fallback to hybrid search
      if (!useEntities || !this.nerService) {
        const results = this.vectorStore.search(queryEmbedding, topK * 2, expandedQuery);
        let filtered = results.filter(r => r.similarity >= threshold);
        // Fallback if all filtered out
        if (filtered.length === 0 && results.length > 0) {
          filtered = results.slice(0, Math.min(topK, results.length));
        }
        return filtered.slice(0, topK);
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

      let filteredResults = results.filter(r => r.similarity >= threshold);
      // Fallback if all filtered out
      if (filteredResults.length === 0 && results.length > 0) {
        filteredResults = results.slice(0, Math.min(topK, results.length));
      }

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
   * Met à jour la transcription d'une source
   */
  async updateSourceTranscription(
    sourceId: string,
    transcription: string,
    source: 'tesseract' | 'transkribus' | 'manual'
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.vectorStore) {
        return { success: false, error: 'Service not initialized' };
      }

      this.vectorStore.updateSource(sourceId, {
        transcription,
        transcriptionSource: source,
        lastModified: new Date(),
      });

      return { success: true };
    } catch (error: any) {
      console.error('Failed to update transcription:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Supprime les chunks existants et réindexe une source
   */
  async reindexSource(sourceId: string): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.vectorStore) {
        return { success: false, error: 'Service not initialized' };
      }

      // Supprimer les chunks existants
      this.vectorStore.deleteChunks(sourceId);

      // TODO: Regénérer les chunks et embeddings
      // Cela nécessite l'accès à OllamaClient pour les embeddings

      return { success: true };
    } catch (error: any) {
      console.error('Failed to reindex source:', error);
      return { success: false, error: error.message };
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

      // Fermer la base de données actuelle
      this.vectorStore.close();

      // Supprimer le fichier de base de données
      const dbPath = path.join(this.projectPath, '.cliodeck', 'primary-sources.db');
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
        console.log(`🗑️ Deleted primary sources database: ${dbPath}`);
      }

      // Réinitialiser le vectorStore (crée une nouvelle base vide)
      this.vectorStore = new PrimarySourcesVectorStore(this.projectPath);
      this.currentTPYPath = null;

      return { success: true };
    } catch (error: any) {
      console.error('Failed to purge primary sources database:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Retourne le chemin de la base de données
   */
  getDatabasePath(): string | null {
    if (!this.projectPath) return null;
    return path.join(this.projectPath, '.cliodeck', 'primary-sources.db');
  }
}

// Singleton
export const tropyService = new TropyService();
