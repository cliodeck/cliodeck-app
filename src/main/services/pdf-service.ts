import { type IndexingProgress } from '../../../backend/core/pdf/PDFIndexer.js';
import { VectorStore } from '../../../backend/core/vector-store/VectorStore.js';
import { EnhancedVectorStore } from '../../../backend/core/vector-store/EnhancedVectorStore.js';
import { PdfVectorStore } from './pdf/PdfVectorStore.js';
import { PdfIndexer } from './pdf/PdfIndexer.js';
import { OllamaClient } from '../../../backend/core/llm/OllamaClient.js';
import { LLMProviderManager, type LLMProvider } from '../../../backend/core/llm/LLMProviderManager.js';
import { KnowledgeGraphBuilder, type GraphNode, type GraphEdge } from '../../../backend/core/analysis/KnowledgeGraphBuilder.js';
import { type TopicAnalysisResult, type TopicAnalysisOptions } from '../../../backend/core/analysis/TopicModelingService.js';
import { TextometricsService, type CorpusTextStatistics } from '../../../backend/core/analysis/TextometricsService.js';
import type { PDFDocument, VectorStoreStatistics } from '../../../backend/types/pdf-document.js';
import { configManager } from './config-manager.js';
import { retrievalService, type SourceType } from './retrieval-service.js';
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
  private ollamaClient: OllamaClient | null = null;
  private llmProviderManager: LLMProviderManager | null = null;
  private currentProjectPath: string | null = null;
  /**
   * Optional typed embedding provider (fusion 1.4i). When set, the
   * embedding function passed to PDFIndexer routes through it instead of
   * `llmProviderManager.generateEmbedding`. Callers wire this to the
   * workspace's `EmbeddingProvider` from the phase 1.3 registry so
   * indexing uses the configured backend uniformly with the rest of the
   * app. Legacy path preserved for existing init flows.
   */
  private embeddingProvider:
    | import('../../../backend/core/llm/providers/base').EmbeddingProvider
    | null = null;

  setEmbeddingProvider(
    p:
      | import('../../../backend/core/llm/providers/base').EmbeddingProvider
      | null
  ): void {
    this.embeddingProvider = p;
  }

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

      // Initialiser Ollama client avec la config actuelle
      this.ollamaClient = new OllamaClient(
        config.ollamaURL,
        config.ollamaChatModel,
        config.ollamaEmbeddingModel,
        config.embeddingStrategy || 'nomic-fallback'
      );

      // Initialiser le LLM Provider Manager (gère Ollama + modèle embarqué pour génération ET embeddings)
      this.llmProviderManager = new LLMProviderManager({
        provider: (config.generationProvider as LLMProvider) || 'auto',
        embeddedModelPath: config.embeddedModelPath,
        embeddedModelId: config.embeddedModelId,
        ollamaURL: config.ollamaURL,
        ollamaChatModel: config.ollamaChatModel,
        ollamaEmbeddingModel: config.ollamaEmbeddingModel,
        // Embedded embedding model support
        embeddedEmbeddingModelPath: config.embeddedEmbeddingModelPath,
        embeddedEmbeddingModelId: config.embeddedEmbeddingModelId,
        embeddingProvider: config.embeddingProvider,
      });

      // Start LLM initialization (runs in parallel with VectorStore)
      const llmInitPromise = this.llmProviderManager.initialize();

      // Initialiser VectorStore (Enhanced ou Standard selon config)
      const { store, initPromise: vsInitPromise } = PdfVectorStore.create(
        projectPath,
        ragConfig,
        { onRebuildProgress }
      );
      this.vectorStore = store;

      // Wait for both LLM and VectorStore to finish initializing in parallel
      await Promise.all([llmInitPromise, vsInitPromise].filter(Boolean));

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
      this.pdfIndexer = new PdfIndexer({
        vectorStore: this.vectorStore,
        llmProviderManager: this.llmProviderManager,
        embeddingProvider: this.embeddingProvider,
        ragConfig,
        summarizerConfig,
      });

      this.currentProjectPath = projectPath;

      // Wire the shared RetrievalService to this project's store/providers.
      retrievalService.configure({
        vectorStore: this.vectorStore,
        llmProviderManager: this.llmProviderManager,
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
    if (!this.llmProviderManager) return;

    console.log('🔥 [WARMUP] Pre-loading embedding model...');
    try {
      await this.llmProviderManager.generateEmbedding('warmup query');
      console.log('✅ [WARMUP] Embedding model ready');
    } catch (_e: unknown) {
      console.warn('⚠️  [WARMUP] Failed - first query may be slower');
    }
  }

  /**
   * Vérifie si le service est initialisé
   */
  private ensureInitialized() {
    if (!this.vectorStore || !this.pdfIndexer || !this.llmProviderManager) {
      throw new Error('PDF Service not initialized. Call init(projectPath) first.');
    }
  }

  async extractPDFMetadata(filePath: string) {
    // This doesn't require initialization since we're just extracting metadata
    const PDFExtractor = (await import('../../../backend/core/pdf/PDFExtractor.js')).PDFExtractor;
    const extractor = new PDFExtractor();

    try {
      const extracted = await extractor.extractDocument(filePath);
      return {
        title: extracted.title || filePath.split('/').pop()?.replace('.pdf', '') || 'Untitled',
        author: extracted.metadata.creator,
        pageCount: extracted.pages.length,
      };
    } catch (error: unknown) {
      console.error('Failed to extract PDF metadata:', error);
      // Fallback to filename
      return {
        title: filePath.split('/').pop()?.replace('.pdf', '') || 'Untitled',
        pageCount: 0,
      };
    }
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
   * keep the same signature and result shape.
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
    return retrievalService.search({
      query,
      topK: options?.topK,
      threshold: options?.threshold,
      documentIds: options?.documentIds,
      collectionKeys: options?.collectionKeys,
      sourceType: options?.sourceType,
      includeVault: options?.includeVault,
    });
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

  getOllamaClient() {
    return this.ollamaClient;
  }

  /**
   * Retourne le LLM Provider Manager pour la génération de texte
   * Gère automatiquement le fallback entre Ollama et le modèle embarqué
   */
  getLLMProviderManager() {
    return this.llmProviderManager;
  }

  /**
   * Met à jour le modèle embarqué dans le LLMProviderManager
   * Appelé après le téléchargement d'un nouveau modèle
   */
  async updateEmbeddedModel(modelPath: string, modelId?: string): Promise<boolean> {
    if (!this.llmProviderManager) {
      console.warn('⚠️  [PDF-SERVICE] LLMProviderManager not initialized, cannot update embedded model');
      return false;
    }

    console.log(`🔄 [PDF-SERVICE] Updating embedded model: ${modelPath}`);
    const success = await this.llmProviderManager.setEmbeddedModelPath(modelPath, modelId);

    if (success) {
      console.log('✅ [PDF-SERVICE] Embedded model updated successfully');
    } else {
      console.error('❌ [PDF-SERVICE] Failed to update embedded model');
    }

    return success;
  }

  /**
   * Désactive le modèle embarqué dans le LLMProviderManager
   * Appelé après la suppression d'un modèle
   */
  async disableEmbeddedModel(): Promise<void> {
    if (!this.llmProviderManager) {
      console.warn('⚠️  [PDF-SERVICE] LLMProviderManager not initialized');
      return;
    }

    console.log('🔄 [PDF-SERVICE] Disabling embedded model');
    await this.llmProviderManager.disableEmbedded();
    console.log('✅ [PDF-SERVICE] Embedded model disabled');
  }

  /**
   * Met à jour le modèle d'embedding embarqué dans le LLMProviderManager
   * Appelé après le téléchargement d'un nouveau modèle d'embedding
   */
  async updateEmbeddedEmbeddingModel(modelPath: string, modelId?: string): Promise<boolean> {
    if (!this.llmProviderManager) {
      console.warn('⚠️  [PDF-SERVICE] LLMProviderManager not initialized, cannot update embedded embedding model');
      return false;
    }

    console.log(`🔄 [PDF-SERVICE] Updating embedded embedding model: ${modelPath}`);
    const success = await this.llmProviderManager.setEmbeddedEmbeddingModelPath(modelPath, modelId);

    if (success) {
      console.log('✅ [PDF-SERVICE] Embedded embedding model updated successfully');
    } else {
      console.error('❌ [PDF-SERVICE] Failed to update embedded embedding model');
    }

    return success;
  }

  /**
   * Désactive le modèle d'embedding embarqué dans le LLMProviderManager
   * Appelé après la suppression d'un modèle d'embedding
   */
  async disableEmbeddedEmbeddingModel(): Promise<void> {
    if (!this.llmProviderManager) {
      console.warn('⚠️  [PDF-SERVICE] LLMProviderManager not initialized');
      return;
    }

    console.log('🔄 [PDF-SERVICE] Disabling embedded embedding model');
    await this.llmProviderManager.disableEmbeddedEmbedding();
    console.log('✅ [PDF-SERVICE] Embedded embedding model disabled');
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

    // Libérer les ressources du LLM Provider Manager
    if (this.llmProviderManager) {
      console.log('🔒 Disposing LLM Provider Manager...');
      await this.llmProviderManager.dispose();
      this.llmProviderManager = null;
    }

    this.pdfIndexer = null;
    this.ollamaClient = null;
    this.currentProjectPath = null;

    console.log('✅ PDF Service closed');
  }
}

export const pdfService = new PDFService();
