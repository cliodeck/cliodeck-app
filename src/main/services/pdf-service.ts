import { type IndexingProgress } from '../../../backend/core/pdf/PDFIndexer.js';
import { VectorStore } from '../../../backend/core/vector-store/VectorStore.js';
import { EnhancedVectorStore } from '../../../backend/core/vector-store/EnhancedVectorStore.js';
import { PdfVectorStore } from './pdf/PdfVectorStore.js';
import { PdfIndexer } from './pdf/PdfIndexer.js';
import {
  createRegistryFromClioDeckConfig,
} from '../../../backend/core/llm/providers/cliodeck-config-adapter.js';
import type {
  EmbeddingProvider,
  LLMProvider,
} from '../../../backend/core/llm/providers/base.js';
import type { ProviderRegistry } from '../../../backend/core/llm/providers/registry.js';
import { KnowledgeGraphBuilder, type GraphNode, type GraphEdge } from '../../../backend/core/analysis/KnowledgeGraphBuilder.js';
import { type TopicAnalysisResult, type TopicAnalysisOptions } from '../../../backend/core/analysis/TopicModelingService.js';
import { TextometricsService, type CorpusTextStatistics } from '../../../backend/core/analysis/TextometricsService.js';
import type { PDFDocument, VectorStoreStatistics } from '../../../backend/types/pdf-document.js';
import { configManager } from './config-manager.js';
import { retrievalService, type SourceType } from './retrieval-service.js';
import { extractPdfIsolated } from './pdf-extract-isolated.js';
import path from 'path';
import fs from 'fs';

// Re-exported for back-compat with existing imports of pdf-service.
export type { SourceType };

/** Options for building a knowledge graph */
interface KnowledgeGraphOptions {
  includeSimilarityEdges?: boolean;
  similarityThreshold?: number;
  includeAuthorNodes?: boolean;
  computeLayout?: boolean;
}

/** Options for topic analysis */
interface AnalyzeTopicsOptions {
  minTopicSize?: number;
  nrTopics?: number | 'auto';
  language?: 'french' | 'english' | 'multilingual';
  nGramRange?: [number, number];
}

class PDFService {
  private pdfIndexer: PdfIndexer | null = null;
  private vectorStore: VectorStore | EnhancedVectorStore | null = null;
  private currentProjectPath: string | null = null;

  /**
   * Typed provider registry (fusion 1.2e). pdf-service owns the
   * `ProviderRegistry` lifecycle for the active project: built from
   * the workspace LLM config in `init()`, rebuilt by
   * `updateEmbeddedModel()` / `disableEmbeddedModel()` / etc., disposed
   * at `init()` re-entry. Replaces the legacy `OllamaClient` +
   * `LLMProviderManager` pair that this service used to instantiate
   * twice per project.
   */
  private registry: ProviderRegistry | null = null;
  private llm: LLMProvider | null = null;
  private embedding: EmbeddingProvider | null = null;

  /**
   * Initialise le PDF Service pour un projet spécifique
   * @param projectPath Chemin absolu vers le dossier du projet
   * @param onRebuildProgress Callback optionnel pour la progression du rebuild
   * @throws Error si projectPath n'est pas fourni
   */
  async init(
    projectPath: string,
    onRebuildProgress?: (progress: {
      current: number;
      total: number;
      status: string;
      percentage: number;
    }) => void
  ) {
    if (!projectPath) {
      throw new Error('PDF Service requires a project path');
    }

    // Fermer la base précédente si elle existe
    if (this.vectorStore) {
      this.vectorStore.close();
    }

    try {
      const config = configManager.getLLMConfig();
      const ragConfig = configManager.getRAGConfig();

      // Build the typed provider registry from the active config.
      // Replaces the previous `new OllamaClient(...)` + `new LLMProviderManager(...)`
      // pair (the latter held a *third* OllamaClient internally — that's
      // gone now too).
      await this.rebuildLLMRegistry();

      // Initialiser VectorStore (Enhanced ou Standard selon config)
      const { store, initPromise: vsInitPromise } = PdfVectorStore.create(
        projectPath,
        ragConfig,
        { onRebuildProgress }
      );
      this.vectorStore = store;

      if (vsInitPromise) {
        await vsInitPromise;
      }

      // Post-init: configure search modes on the enhanced store. Any
      // rebuild is deferred until after warmup (see below) so we don't
      // run embedding warmup + a large batched rebuild concurrently.
      PdfVectorStore.configureEnhanced(this.vectorStore, ragConfig);

      // Convertir le nouveau format de config en ancien format pour le summarizer
      // Support pour compatibilité ascendante et descendante
      const summarizerConfig = ragConfig.summarizer || {
        enabled: ragConfig.summaryGeneration !== 'disabled' && ragConfig.summaryGeneration !== undefined,
        method: ragConfig.summaryGeneration === 'abstractive' ? 'abstractive' : 'extractive',
        maxLength: ragConfig.summaryMaxLength || 750,
        llmModel: config.ollamaChatModel
      };

      console.log('📝 [PDF-SERVICE] Summarizer config:', {
        enabled: summarizerConfig.enabled,
        method: summarizerConfig.method,
        maxLength: summarizerConfig.maxLength
      });

      // Log RAG optimization features
      console.log('📝 [PDF-SERVICE] RAG optimization config:', {
        enableQualityFiltering: ragConfig.enableQualityFiltering ?? true,
        enablePreprocessing: ragConfig.enablePreprocessing ?? true,
        enableDeduplication: ragConfig.enableDeduplication ?? true,
        useSemanticChunking: ragConfig.useSemanticChunking ?? false,
        customChunkingEnabled: ragConfig.customChunkingEnabled ?? false,
      });

      // Initialiser l'indexeur (façade — la fonction d'embedding et la
      // construction du backend PDFIndexer vivent maintenant dans
      // ./pdf/PdfIndexer.ts).
      if (!this.embedding) {
        throw new Error('PDF Service: embedding provider not configured');
      }
      this.pdfIndexer = new PdfIndexer({
        vectorStore: this.vectorStore,
        embeddingProvider: this.embedding,
        ragConfig,
        summarizerConfig,
      });

      this.currentProjectPath = projectPath;

      // Wire the shared RetrievalService to this project's vector store.
      // (As of 1.2b, RetrievalService owns its own typed embedding
      // provider, built from the workspace config — no manager handoff.)
      retrievalService.configure({
        vectorStore: this.vectorStore,
        workspaceRoot: projectPath,
      });

      console.log('✅ PDF Service initialized for project');
      console.log(`   Project: ${projectPath}`);
      console.log(`   VectorStore DB: ${projectPath}/.cliodeck/vectors.db`);
      console.log(`   Ollama URL: ${config.ollamaURL}`);
      console.log(`   Chat Model: ${config.ollamaChatModel}`);
      console.log(`   Embedding Model: ${config.ollamaEmbeddingModel}`);

      // Warmup embedding model (Phase 6), then trigger any pending
      // HNSW/BM25 rebuild. Serialized to avoid the warmup embedding
      // call racing with a batched rebuild that also hits the embedder.
      const storeForRebuild = this.vectorStore;
      void this.warmupEmbeddingModel().then(() => {
        if (storeForRebuild) {
          return PdfVectorStore.maybeRebuild(storeForRebuild);
        }
        return undefined;
      });
    } catch (error: unknown) {
      console.error('❌ Failed to initialize PDF Service:', error);
      throw error;
    }
  }

  /**
   * Warmup embedding model to reduce first-query latency
   */
  private async warmupEmbeddingModel(): Promise<void> {
    if (!this.embedding) return;

    console.log('🔥 [WARMUP] Pre-loading embedding model...');
    try {
      await this.embedding.embed(['warmup query']);
      console.log('✅ [WARMUP] Embedding model ready');
    } catch (_e: unknown) {
      console.warn('⚠️  [WARMUP] Failed - first query may be slower');
    }
  }

  /**
   * Build (or rebuild) the typed provider registry from the active
   * workspace LLM config. Disposes the previous registry first so the
   * native handles / HTTP agents it owns are released cleanly. Used by
   * `init()` and by the embedded-model setters below — the latter are
   * called after `embedded-llm-handlers` updates `configManager`.
   */
  private async rebuildLLMRegistry(): Promise<void> {
    const prev = this.registry;
    this.registry = null;
    this.llm = null;
    this.embedding = null;
    if (prev) {
      await prev.dispose().catch(() => undefined);
    }

    try {
      this.registry = createRegistryFromClioDeckConfig(configManager.getLLMConfig());
      this.llm = this.registry.getLLM();
      this.embedding = this.registry.getEmbedding();
    } catch (e) {
      console.error('❌ [PDF-SERVICE] Failed to build provider registry:', e);
      this.registry = null;
      this.llm = null;
      this.embedding = null;
      throw e;
    }
  }

  /**
   * Vérifie si le service est initialisé
   */
  private ensureInitialized() {
    if (!this.vectorStore || !this.pdfIndexer || !this.llm || !this.embedding) {
      throw new Error('PDF Service not initialized. Call init(projectPath) first.');
    }
  }

  async extractPDFMetadata(filePath: string) {
    // Uses isolated worker so a pdfjs SIGSEGV does not crash the app
    const result = await extractPdfIsolated(filePath);

    if (result.ok === false) {
      console.error('Failed to extract PDF metadata (isolated):', result.error);
      return {
        title: filePath.split('/').pop()?.replace('.pdf', '') || 'Untitled',
        pageCount: 0,
      };
    }

    return {
      title: result.title || filePath.split('/').pop()?.replace('.pdf', '') || 'Untitled',
      author: result.metadata.creator as string | undefined,
      pageCount: result.pages.length,
    };
  }

  async indexPDF(
    filePath: string,
    bibtexKey?: string,
    onProgress?: (progress: IndexingProgress) => void,
    bibliographyMetadata?: { title?: string; author?: string; year?: string },
    collectionKeys?: string[]
  ): Promise<PDFDocument> {
    this.ensureInitialized();
    return this.pdfIndexer!.indexPDF(
      filePath,
      bibtexKey,
      onProgress,
      bibliographyMetadata,
      collectionKeys
    );
  }

  /**
   * Thin facade: delegates to RetrievalService (fusion B1). Legacy callers
   * (incl. the `pdf:search` IPC handler consumed by the renderer) keep
   * the flat-array return shape they expect; the typed
   * `RetrievalSearchResult` envelope (fusion 1.7) is unwrapped here.
   * Per-corpus outcomes are still available to internal callers via
   * `retrievalService.search(...)` directly.
   */
  async search(
    query: string,
    options?: {
      topK?: number;
      threshold?: number;
      documentIds?: string[];
      collectionKeys?: string[];
      sourceType?: SourceType;
      includeVault?: boolean;
    }
  ) {
    this.ensureInitialized();
    const { hits } = await retrievalService.search({
      query,
      topK: options?.topK,
      threshold: options?.threshold,
      documentIds: options?.documentIds,
      collectionKeys: options?.collectionKeys,
      sourceType: options?.sourceType,
      includeVault: options?.includeVault,
    });
    return hits;
  }

  async getAllDocuments() {
    this.ensureInitialized();
    return this.vectorStore!.getAllDocuments();
  }

  /**
   * Get a specific document by its ID
   */
  async getDocument(documentId: string) {
    this.ensureInitialized();
    // Indexed lookup — avoids hydrating the full document list (+ N
    // chunk-count queries) just to find one by id.
    return PdfVectorStore.getDocumentById(this.vectorStore!, documentId) || null;
  }

  async deleteDocument(documentId: string) {
    this.ensureInitialized();
    return this.vectorStore!.deleteDocument(documentId);
  }

  async getStatistics() {
    this.ensureInitialized();
    return this.vectorStore!.getStatistics();
  }

  /**
   * Retourne le chemin du projet actuel
   */
  getCurrentProjectPath(): string | null {
    return this.currentProjectPath;
  }

  /**
   * Public typed-provider accessors (fusion 1.2e). Replace the legacy
   * `getOllamaClient()` / `getLLMProviderManager()` getters that were
   * the last entry points into the OllamaClient + LLMProviderManager
   * pair. Callers use these to drive chat / embedding work without
   * caring about backend choice.
   */
  getLLMProvider(): LLMProvider | null {
    return this.llm;
  }
  getEmbeddingProvider(): EmbeddingProvider | null {
    return this.embedding;
  }

  /**
   * Embedded-model lifecycle. Each call assumes `embedded-llm-handlers`
   * has already updated `configManager` with the new (or cleared)
   * embedded model paths; we just rebuild the registry so the next
   * chat / embedding call picks up the change.
   */
  async updateEmbeddedModel(modelPath: string, _modelId?: string): Promise<boolean> {
    console.log(`🔄 [PDF-SERVICE] Updating embedded model: ${modelPath}`);
    try {
      await this.rebuildLLMRegistry();
      console.log('✅ [PDF-SERVICE] Embedded model updated successfully');
      return true;
    } catch (e) {
      console.error('❌ [PDF-SERVICE] Failed to rebuild registry after embedded-model change:', e);
      return false;
    }
  }

  async disableEmbeddedModel(): Promise<void> {
    console.log('🔄 [PDF-SERVICE] Disabling embedded model');
    try {
      await this.rebuildLLMRegistry();
      console.log('✅ [PDF-SERVICE] Embedded model disabled');
    } catch (e) {
      console.error('❌ [PDF-SERVICE] Failed to rebuild registry after disabling embedded model:', e);
    }
  }

  async updateEmbeddedEmbeddingModel(modelPath: string, _modelId?: string): Promise<boolean> {
    console.log(`🔄 [PDF-SERVICE] Updating embedded embedding model: ${modelPath}`);
    try {
      await this.rebuildLLMRegistry();
      console.log('✅ [PDF-SERVICE] Embedded embedding model updated successfully');
      return true;
    } catch (e) {
      console.error('❌ [PDF-SERVICE] Failed to rebuild registry after embedded-embedding change:', e);
      return false;
    }
  }

  async disableEmbeddedEmbeddingModel(): Promise<void> {
    console.log('🔄 [PDF-SERVICE] Disabling embedded embedding model');
    try {
      await this.rebuildLLMRegistry();
      console.log('✅ [PDF-SERVICE] Embedded embedding model disabled');
    } catch (e) {
      console.error('❌ [PDF-SERVICE] Failed to rebuild registry after disabling embedded embedding:', e);
    }
  }

  getVectorStore() {
    return this.vectorStore;
  }

  /**
   * Lit le contexte du projet depuis context.md
   */
  getProjectContext(): string | null {
    if (!this.currentProjectPath) {
      return null;
    }

    const contextPath = path.join(this.currentProjectPath, 'context.md');

    try {
      if (fs.existsSync(contextPath)) {
        const context = fs.readFileSync(contextPath, 'utf-8').trim();
        console.log('📋 [PROJECT CONTEXT] Loaded:', context.substring(0, 100) + '...');
        return context;
      }
    } catch (error: unknown) {
      console.warn('⚠️  [PROJECT CONTEXT] Could not read context file:', error);
    }

    return null;
  }

  /**
   * Construit et retourne le graphe de connaissances
   */
  async buildKnowledgeGraph(options?: KnowledgeGraphOptions): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    this.ensureInitialized();

    // Récupérer le seuil de similarité depuis la configuration utilisateur
    const ragConfig = configManager.get('rag');
    const defaultThreshold = ragConfig?.explorationSimilarityThreshold ?? 0.7;

    const baseStore = this.vectorStore instanceof EnhancedVectorStore
      ? this.vectorStore.getBaseStore()
      : this.vectorStore!;
    const graphBuilder = new KnowledgeGraphBuilder(baseStore);
    const graph = await graphBuilder.buildGraph({
      includeSimilarityEdges: options?.includeSimilarityEdges !== false,
      similarityThreshold: options?.similarityThreshold ?? defaultThreshold,
      includeAuthorNodes: options?.includeAuthorNodes || false,
      computeLayout: options?.computeLayout !== false,
    });

    return graphBuilder.exportForVisualization(graph);
  }

  /**
   * Retourne les statistiques du corpus
   */
  async getCorpusStatistics() {
    this.ensureInitialized();

    const stats = await this.vectorStore!.getStatistics();
    const documents = await this.vectorStore!.getAllDocuments();

    // Calculer statistiques supplémentaires
    const languages = new Set<string>();
    const years = new Set<string>();
    const authors = new Set<string>();

    for (const doc of documents) {
      if (doc.language) languages.add(doc.language);
      if (doc.year) years.add(doc.year);
      if (doc.author) authors.add(doc.author);
    }

    // Compter les citations
    const totalCitationsExtracted = this.vectorStore!.getTotalCitationsCount();
    const matchedCitations = this.vectorStore!.getMatchedCitationsCount();

    return {
      documentCount: stats.documentCount,
      chunkCount: stats.chunkCount,
      citationCount: matchedCitations, // Citations internes (matchées dans le corpus)
      totalCitationsExtracted: totalCitationsExtracted, // Total des citations extraites
      languageCount: languages.size,
      languages: Array.from(languages),
      yearRange: (() => {
        const validYears = Array.from(years)
          .map(y => parseInt(y))
          .filter(y => !isNaN(y) && y > 0);
        return validYears.length > 0 ? {
          min: Math.min(...validYears),
          max: Math.max(...validYears),
        } : null;
      })(),
      authorCount: authors.size,
    };
  }

  /**
   * Analyse textométrique du corpus
   */
  async getTextStatistics(options?: { topN?: number }) {
    this.ensureInitialized();

    const documents = await this.vectorStore!.getAllDocuments();

    if (documents.length === 0) {
      throw new Error('No documents found in corpus');
    }

    console.log(`📊 Analyzing text statistics for ${documents.length} documents...`);

    // Stream doc-by-doc: build the corpus list lazily without keeping
    // intermediate per-chunk arrays or emitting a per-doc log line per
    // document (which quickly gets expensive for large corpora). The
    // previous code also forced a full `reduce` over every doc.text
    // just for a summary log; that's been dropped.
    const corpusDocuments: Array<{ id: string; text: string }> = new Array(documents.length);
    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i];
      const chunks = this.vectorStore!.getChunksForDocument(doc.id);
      // Single pass: accumulate content into one string per doc without
      // an intermediate `.map()` array.
      let text = '';
      for (let c = 0; c < chunks.length; c++) {
        if (c > 0) text += ' ';
        text += chunks[c].chunk.content;
      }
      corpusDocuments[i] = { id: doc.id, text };
    }

    // Analyser avec le service textométrique
    const textometricsService = new TextometricsService();
    const statistics = textometricsService.analyzeCorpus(
      corpusDocuments,
      options?.topN || 50
    );

    console.log(`✅ Text statistics computed:`, {
      totalWords: statistics.totalWords,
      vocabularySize: statistics.vocabularySize,
      lexicalRichness: statistics.lexicalRichness.toFixed(3),
      topWordsCount: statistics.topWords.length,
    });

    // Convertir Map en objet pour JSON serialization
    const wordFrequencyDistributionObj: Record<number, number> = {};
    statistics.wordFrequencyDistribution.forEach((count, freq) => {
      wordFrequencyDistributionObj[freq] = count;
    });

    return {
      ...statistics,
      wordFrequencyDistribution: wordFrequencyDistributionObj,
    };
  }

  /**
   * Analyse les topics du corpus avec BERTopic
   */
  async analyzeTopics(options?: AnalyzeTopicsOptions): Promise<TopicAnalysisResult> {
    this.ensureInitialized();

    const documents = await this.vectorStore!.getAllDocuments();

    if (documents.length < 5) {
      throw new Error('Topic modeling requires at least 5 documents');
    }

    // Single-pass collection: in one iteration we both tally embedding
    // dimensions *and* stash the candidate (text, embedding, id) for
    // each document. The previous implementation iterated the corpus
    // twice (once just to pick the dominant dim, once to actually
    // build the arrays) which meant fetching per-chunk rows from
    // SQLite twice for every document lacking a summary embedding.
    interface Candidate { id: string; text: string; embedding: Float32Array }
    const candidates: Candidate[] = [];
    const dimensionCounts = new Map<number, number>();

    for (const doc of documents) {
      const text = doc.summary || doc.title;
      if (!text) continue;

      let embedding: Float32Array | null = null;
      if (doc.summaryEmbedding) {
        embedding = doc.summaryEmbedding;
      } else {
        const chunks = this.vectorStore!.getChunksForDocument(doc.id);
        if (chunks.length > 0 && chunks[0].embedding) {
          embedding = chunks[0].embedding;
        }
      }

      if (!embedding || embedding.length === 0) continue;

      dimensionCounts.set(embedding.length, (dimensionCounts.get(embedding.length) || 0) + 1);
      candidates.push({ id: doc.id, text, embedding });
    }

    // Pick the dominant dimension (ties broken by first-seen via Map order).
    let expectedDimension = 0;
    let maxCount = 0;
    for (const [dim, count] of dimensionCounts) {
      if (count > maxCount) {
        maxCount = count;
        expectedDimension = dim;
      }
    }

    console.log(`📊 Expected embedding dimension: ${expectedDimension} (found in ${maxCount} documents)`);
    if (dimensionCounts.size > 1) {
      console.warn(`⚠️ Found ${dimensionCounts.size} different embedding dimensions:`, Array.from(dimensionCounts.entries()));
    }

    // Filter candidates to the dominant dimension and drop any with
    // NaN/null components.
    const embeddings: Float32Array[] = [];
    const texts: string[] = [];
    const documentIds: string[] = [];
    for (const cand of candidates) {
      if (cand.embedding.length !== expectedDimension) {
        console.warn(`⚠️ Skipping document ${cand.id}: wrong embedding dimension (expected ${expectedDimension}, got ${cand.embedding.length})`);
        continue;
      }
      // Early-exit scan for invalid values — avoids Array.from on
      // large Float32Arrays.
      let invalid = false;
      for (let i = 0; i < cand.embedding.length; i++) {
        const v = cand.embedding[i];
        if (v === null || v === undefined || Number.isNaN(v)) { invalid = true; break; }
      }
      if (invalid) {
        console.warn(`⚠️ Skipping document ${cand.id}: invalid embedding (contains null/NaN values)`);
        continue;
      }
      embeddings.push(cand.embedding);
      texts.push(cand.text);
      documentIds.push(cand.id);
    }

    if (embeddings.length < 5) {
      throw new Error(`Not enough documents with embeddings for topic modeling. Found ${embeddings.length} documents, need at least 5.`);
    }

    // Utiliser le singleton du service Topic Modeling (importé depuis topic-modeling-service)
    const { topicModelingService } = await import('./topic-modeling-service.js');

    // Démarrer le service s'il n'est pas déjà en cours d'exécution
    // Le service reste en mémoire entre les analyses pour de meilleures performances
    const status = topicModelingService.getStatus();
    if (!status.isRunning && !status.isStarting) {
      console.log('🚀 Starting topic modeling service (will be cached for future use)...');
      await topicModelingService.start();
    } else if (status.isStarting) {
      console.log('⏳ Topic modeling service is already starting, waiting...');
      // Attendre que le service démarre
      await topicModelingService.start();
    } else {
      console.log('✅ Topic modeling service already running (using cached instance)');
    }

    // Paramètres par défaut optimisés pour de meilleurs résultats
    // Heuristique intelligente pour le nombre de topics basée sur la taille du corpus:
    // - Petits corpus (< 30 docs): 3-5 topics
    // - Moyens corpus (30-100 docs): 5-10 topics
    // - Grands corpus (100-500 docs): 10-20 topics
    // - Très grands corpus (> 500 docs): 20-30 topics
    let defaultNrTopics: number | 'auto' = 'auto';
    if (!options?.nrTopics) {
      const numDocs = embeddings.length;
      if (numDocs < 30) {
        defaultNrTopics = Math.max(3, Math.floor(numDocs / 6));
      } else if (numDocs < 100) {
        defaultNrTopics = Math.max(5, Math.floor(numDocs / 10));
      } else if (numDocs < 500) {
        defaultNrTopics = Math.max(10, Math.floor(numDocs / 10));
      } else {
        defaultNrTopics = Math.max(20, Math.floor(numDocs / 20));
      }
      console.log(`📊 Auto-calculated nrTopics: ${defaultNrTopics} (based on ${numDocs} documents)`);
    }

    // Ajuster min_topic_size en fonction du nombre de topics demandés
    // Si l'utilisateur demande beaucoup de topics, réduire min_topic_size
    // Minimum absolu: 2 (validation Pydantic du service Python)
    let adjustedMinTopicSize = options?.minTopicSize || 2;
    const requestedTopics = options?.nrTopics || defaultNrTopics;

    if (requestedTopics !== 'auto' && typeof requestedTopics === 'number') {
      // Si on demande beaucoup de topics par rapport au corpus, réduire min_topic_size
      const topicsPerDoc = requestedTopics / embeddings.length;
      if (topicsPerDoc > 0.08) {
        // Plus de 1 topic pour 12 documents → très granulaire, utiliser min_topic_size=2 (minimum autorisé)
        adjustedMinTopicSize = 2;
        console.log(`📊 Adjusted minTopicSize to 2 (high topic granularity requested: ${requestedTopics} topics for ${embeddings.length} docs)`);
      }
    }

    const analysisOptions: TopicAnalysisOptions = {
      minTopicSize: adjustedMinTopicSize,
      nrTopics: requestedTopics,
      language: options?.language || 'multilingual',
      nGramRange: options?.nGramRange || [1, 3] as [number, number],
    };

    const result = await topicModelingService.analyzeTopics(
      embeddings,
      texts,
      documentIds,
      analysisOptions
    );

    // Sauvegarder les résultats dans la base de données
    this.vectorStore!.saveTopicAnalysis(result, analysisOptions);
    console.log('✅ Topic analysis saved to database');

    // NOTE: Le service reste en cours d'exécution pour de futures analyses
    // Il sera arrêté automatiquement quand l'application se ferme

    return result;
  }

  /**
   * Charge la dernière analyse de topics sauvegardée
   */
  loadTopicAnalysis() {
    this.ensureInitialized();

    const result = this.vectorStore!.loadLatestTopicAnalysis();
    return result;
  }

  /**
   * Récupère les données temporelles des topics (pour stream graph)
   */
  getTopicTimeline() {
    this.ensureInitialized();

    const result = this.vectorStore!.getTopicTimeline();
    return result;
  }

  /**
   * Purge toutes les données de la base vectorielle
   */
  purgeAllData() {
    this.ensureInitialized();

    console.log('🗑️ Purging all data from vector store...');
    this.vectorStore!.purgeAllData();
    console.log('✅ Vector store purged successfully');
  }

  /**
   * Nettoie les chunks orphelins (sans document parent)
   */
  cleanOrphanedChunks() {
    this.ensureInitialized();

    console.log('🧹 Cleaning orphaned chunks from vector store...');
    this.vectorStore!.cleanOrphanedChunks();
    console.log('✅ Orphaned chunks cleaned successfully');
  }

  /**
   * Ferme le PDF Service et libère les ressources
   */
  async close() {
    if (this.vectorStore) {
      console.log('🔒 Closing PDF Service vector store...');
      this.vectorStore.close();
      this.vectorStore = null;
    }

    // Libérer les ressources du registry typé (HTTP agents, native handles).
    if (this.registry) {
      console.log('🔒 Disposing LLM provider registry...');
      await this.registry.dispose().catch(() => undefined);
      this.registry = null;
      this.llm = null;
      this.embedding = null;
    }

    this.pdfIndexer = null;
    this.currentProjectPath = null;

    console.log('✅ PDF Service closed');
  }
}

export const pdfService = new PDFService();
