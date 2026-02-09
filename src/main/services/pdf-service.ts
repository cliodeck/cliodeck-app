// @ts-nocheck
import { PDFIndexer } from '../../../backend/core/pdf/PDFIndexer.js';
import { VectorStore } from '../../../backend/core/vector-store/VectorStore.js';
import { EnhancedVectorStore } from '../../../backend/core/vector-store/EnhancedVectorStore.js';
import { OllamaClient } from '../../../backend/core/llm/OllamaClient.js';
import { LLMProviderManager, type LLMProvider } from '../../../backend/core/llm/LLMProviderManager.js';
import { KnowledgeGraphBuilder } from '../../../backend/core/analysis/KnowledgeGraphBuilder.js';
import { TopicModelingService } from '../../../backend/core/analysis/TopicModelingService.js';
import { TextometricsService } from '../../../backend/core/analysis/TextometricsService.js';
import { QueryEmbeddingCache } from '../../../backend/core/rag/QueryEmbeddingCache.js';
import { configManager } from './config-manager.js';
import { tropyService } from './tropy-service.js';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';

// Source type for multi-source search
export type SourceType = 'secondary' | 'primary' | 'both';

// Dictionnaire de termes académiques FR→EN pour query expansion
const ACADEMIC_TERMS_FR_TO_EN: Record<string, string[]> = {
  'taxonomie de bloom': ['bloom\'s taxonomy', 'bloom taxonomy', 'blooms taxonomy'],
  'zone proximale développement': ['zone of proximal development', 'zpd', 'vygotsky'],
  'apprentissage significatif': ['meaningful learning', 'significant learning'],
  'constructivisme': ['constructivism', 'constructivist'],
  'socioconstructivisme': ['social constructivism', 'socioconstructivism'],
  'métacognition': ['metacognition', 'metacognitive'],
  'pédagogie active': ['active learning', 'active pedagogy'],
  // Ajoutez d'autres termes selon vos besoins
};

/**
 * Détecte et traduit les termes académiques français en anglais
 */
function expandQueryMultilingual(query: string): string[] {
  const queries = [query]; // Version originale
  const lowerQuery = query.toLowerCase();

  // Chercher des termes connus à traduire
  for (const [frTerm, enTranslations] of Object.entries(ACADEMIC_TERMS_FR_TO_EN)) {
    if (lowerQuery.includes(frTerm)) {
      // Ajouter chaque traduction anglaise
      enTranslations.forEach(enTerm => {
        const translatedQuery = query.replace(new RegExp(frTerm, 'gi'), enTerm);
        queries.push(translatedQuery);
      });
    }
  }

  console.log('🌐 [MULTILINGUAL] Query expansion:', {
    original: query,
    expanded: queries,
    count: queries.length
  });

  return queries;
}

class PDFService {
  private pdfIndexer: PDFIndexer | null = null;
  private vectorStore: VectorStore | EnhancedVectorStore | null = null;
  private ollamaClient: OllamaClient | null = null;
  private llmProviderManager: LLMProviderManager | null = null;
  private currentProjectPath: string | null = null;

  // Query embedding cache for faster repeated searches
  private queryEmbeddingCache = new QueryEmbeddingCache(500, 60);

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

      // Initialiser le LLM Provider Manager (gère Ollama + modèle embarqué)
      this.llmProviderManager = new LLMProviderManager({
        provider: (config.generationProvider as LLMProvider) || 'auto',
        embeddedModelPath: config.embeddedModelPath,
        embeddedModelId: config.embeddedModelId,
        ollamaURL: config.ollamaURL,
        ollamaChatModel: config.ollamaChatModel,
        ollamaEmbeddingModel: config.ollamaEmbeddingModel,
      });

      // Initialiser le manager (charge le modèle embarqué si disponible)
      await this.llmProviderManager.initialize();

      // Initialiser VectorStore (Enhanced ou Standard selon config)
      const useEnhancedSearch =
        ragConfig.useHNSWIndex !== false || ragConfig.useHybridSearch !== false;

      if (useEnhancedSearch) {
        console.log('🚀 [PDF-SERVICE] Using EnhancedVectorStore (HNSW + BM25)');
        this.vectorStore = new EnhancedVectorStore(projectPath);

        // Set rebuild progress callback if provided
        if (onRebuildProgress) {
          this.vectorStore.setRebuildProgressCallback(onRebuildProgress);
        }

        await this.vectorStore.initialize();

        // Check if indexes need to be rebuilt - run in background to avoid blocking UI
        if (this.vectorStore.needsRebuild()) {
          console.log('🔨 [PDF-SERVICE] Indexes need rebuild, starting rebuild in background...');
          // Don't await - let it run in background
          this.vectorStore.rebuildIndexes().then(() => {
            console.log('✅ [PDF-SERVICE] Indexes rebuilt successfully');
          }).catch((error) => {
            console.error('❌ [PDF-SERVICE] Rebuild failed:', error);
          });
        }

        // Configure search modes
        if (ragConfig.useHNSWIndex !== undefined) {
          this.vectorStore.setUseHNSW(ragConfig.useHNSWIndex);
        }
        if (ragConfig.useHybridSearch !== undefined) {
          this.vectorStore.setUseHybrid(ragConfig.useHybridSearch);
        }
      } else {
        console.log('📊 [PDF-SERVICE] Using standard VectorStore (linear search)');
        this.vectorStore = new VectorStore(projectPath);
      }

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

      // Initialiser PDFIndexer avec configuration complète du RAG
      this.pdfIndexer = new PDFIndexer(
        this.vectorStore,
        this.ollamaClient,
        ragConfig.chunkingConfig,
        summarizerConfig,
        ragConfig.useAdaptiveChunking !== false, // Enable by default
        ragConfig // Pass full RAG config for optimization features
      );

      this.currentProjectPath = projectPath;

      console.log('✅ PDF Service initialized for project');
      console.log(`   Project: ${projectPath}`);
      console.log(`   VectorStore DB: ${this.vectorStore.projectPath}/.cliodeck/vectors.db`);
      console.log(`   Ollama URL: ${config.ollamaURL}`);
      console.log(`   Chat Model: ${config.ollamaChatModel}`);
      console.log(`   Embedding Model: ${config.ollamaEmbeddingModel}`);

      // Warmup embedding model (Phase 6) - run in background
      this.warmupEmbeddingModel();
    } catch (error) {
      console.error('❌ Failed to initialize PDF Service:', error);
      throw error;
    }
  }

  /**
   * Warmup embedding model to reduce first-query latency
   */
  private async warmupEmbeddingModel(): Promise<void> {
    if (!this.ollamaClient) return;

    console.log('🔥 [WARMUP] Pre-loading embedding model...');
    try {
      await this.ollamaClient.generateEmbedding('warmup query');
      console.log('✅ [WARMUP] Embedding model ready');
    } catch (e) {
      console.warn('⚠️  [WARMUP] Failed - first query may be slower');
    }
  }

  /**
   * Get query embedding with caching
   * Returns cached embedding if available, otherwise generates and caches
   */
  private async getQueryEmbedding(query: string): Promise<Float32Array> {
    // Check cache first
    const cached = this.queryEmbeddingCache.get(query);
    if (cached) {
      return cached;
    }

    // Generate and cache
    const embedding = await this.ollamaClient!.generateEmbedding(query);
    this.queryEmbeddingCache.set(query, embedding);
    return embedding;
  }

  /**
   * Vérifie si le service est initialisé
   */
  private ensureInitialized() {
    if (!this.vectorStore || !this.pdfIndexer || !this.ollamaClient) {
      throw new Error('PDF Service not initialized. Call init(projectPath) first.');
    }
  }

  async extractPDFMetadata(filePath: string) {
    // This doesn't require initialization since we're just extracting metadata
    const PDFExtractor = (await import('../../../backend/core/pdf/PDFExtractor.js')).PDFExtractor;
    const extractor = new PDFExtractor();

    try {
      const extracted = await extractor.extractFromPDF(filePath);
      return {
        title: extracted.title || filePath.split('/').pop()?.replace('.pdf', '') || 'Untitled',
        author: extracted.metadata.creator,
        pageCount: extracted.pages.length,
      };
    } catch (error) {
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
    onProgress?: any,
    bibliographyMetadata?: { title?: string; author?: string; year?: string },
    collectionKeys?: string[]
  ) {
    this.ensureInitialized();
    const document = await this.pdfIndexer!.indexPDF(filePath, bibtexKey, onProgress, bibliographyMetadata);

    // Link document to collections if provided
    if (collectionKeys && collectionKeys.length > 0) {
      this.vectorStore!.setDocumentCollections(document.id, collectionKeys);
      console.log(`📁 Linked document ${document.id.substring(0, 8)} to ${collectionKeys.length} collection(s)`);
    }

    return document;
  }

  async search(query: string, options?: { topK?: number; threshold?: number; documentIds?: string[]; collectionKeys?: string[]; sourceType?: SourceType }) {
    this.ensureInitialized();

    const sourceType = options?.sourceType || 'both';
    const searchStart = Date.now();
    const ragConfig = configManager.getRAGConfig();
    const topK = options?.topK || ragConfig.topK;
    const threshold = options?.threshold || ragConfig.similarityThreshold;

    console.log(`🔍 [PDF-SERVICE] Multi-source search: sourceType=${sourceType}, topK=${topK}`);

    // Container for all results (both sources)
    let allSourceResults: any[] = [];

    // Search secondary sources (bibliography/PDFs) if needed
    if (sourceType === 'secondary' || sourceType === 'both') {
      const secondaryResults = await this.searchSecondary(query, {
        topK: sourceType === 'both' ? Math.ceil(topK * 0.6) : topK,
        threshold,
        documentIds: options?.documentIds,
        collectionKeys: options?.collectionKeys,
      });
      // Mark results with source type
      allSourceResults.push(...secondaryResults.map((r: any) => ({
        ...r,
        sourceType: 'secondary' as const,
      })));
      console.log(`📚 [PDF-SERVICE] Secondary sources: ${secondaryResults.length} results`);
    }

    // Search primary sources (Tropy archives) if needed
    if (sourceType === 'primary' || sourceType === 'both') {
      try {
        const primaryResults = await tropyService.search(query, {
          topK: sourceType === 'both' ? Math.ceil(topK * 0.4) : topK,
          threshold,
        });
        // Map primary source results to match the expected format
        const mappedPrimaryResults = primaryResults.map((r: any) => ({
          chunk: {
            id: r.chunk?.id || r.id,
            content: r.chunk?.content || r.content,
            documentId: r.sourceId || r.chunk?.sourceId,
            chunkIndex: r.chunk?.chunkIndex || 0,
          },
          document: {
            id: r.sourceId,
            title: r.source?.title || r.title,
            author: r.source?.creator,
            bibtexKey: null, // Primary sources don't have bibtexKey
          },
          source: r.source,
          similarity: r.similarity,
          sourceType: 'primary' as const,
        }));
        allSourceResults.push(...mappedPrimaryResults);
        console.log(`📜 [PDF-SERVICE] Primary sources: ${primaryResults.length} results`);
      } catch (error) {
        console.warn('⚠️ [PDF-SERVICE] Primary source search failed (Tropy not initialized?):', error);
        // Continue with secondary sources only
      }
    }

    // Sort all results by similarity and take top K
    const sortedResults = allSourceResults
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);

    console.log(`🔍 [PDF-SERVICE] Final combined results: ${sortedResults.length} (from ${allSourceResults.length} total)`);
    console.log(`🔍 [PDF-SERVICE] Total search duration: ${Date.now() - searchStart}ms`);

    return sortedResults;
  }

  /**
   * Search in secondary sources (bibliography/PDFs)
   * This is the original search logic, refactored into a separate method
   */
  private async searchSecondary(query: string, options?: { topK?: number; threshold?: number; documentIds?: string[]; collectionKeys?: string[] }) {
    const searchStart = Date.now();
    const ragConfig = configManager.getRAGConfig();
    const topK = options?.topK || ragConfig.topK;
    const threshold = options?.threshold || ragConfig.similarityThreshold;

    // Resolve collection filter to document IDs
    let documentIdsFilter = options?.documentIds;

    if (options?.collectionKeys && options.collectionKeys.length > 0) {
      const docsInCollections = this.vectorStore!.getDocumentIdsInCollections(
        options.collectionKeys,
        true // recursive: include subcollections
      );

      console.log(`🔍 [PDF-SERVICE] Collection filter: ${options.collectionKeys.length} collection(s) -> ${docsInCollections.length} document(s)`);

      // Intersect with existing documentIds filter if provided
      if (documentIdsFilter && documentIdsFilter.length > 0) {
        documentIdsFilter = documentIdsFilter.filter((id) => docsInCollections.includes(id));
        console.log(`🔍 [PDF-SERVICE] After intersection with documentIds: ${documentIdsFilter.length} document(s)`);
      } else {
        documentIdsFilter = docsInCollections;
      }

      // If no documents match the collection filter, return empty results
      if (documentIdsFilter.length === 0) {
        console.log('🔍 [PDF-SERVICE] No documents match the collection filter, returning empty results');
        return [];
      }
    }

    // 🆕 Query expansion multilingue
    const expandedQueries = expandQueryMultilingual(query);
    const allResults = new Map<string, any>(); // chunk.id → meilleur résultat

    // 🚀 PARALLEL: Generate all embeddings in parallel (using cache)
    const embeddingStart = Date.now();
    console.log(`🔍 [PDF-SERVICE] Generating ${expandedQueries.length} embeddings in parallel...`);

    const embeddingPromises = expandedQueries.map(q => this.getQueryEmbedding(q));
    const embeddings = await Promise.all(embeddingPromises);

    const embeddingDuration = Date.now() - embeddingStart;
    console.log(`✅ [PDF-SERVICE] All embeddings generated in ${embeddingDuration}ms`);

    // Log cache stats periodically
    const cacheStats = this.queryEmbeddingCache.getStats();
    if ((cacheStats.hits + cacheStats.misses) % 10 === 0) {
      console.log(`💾 [EMB CACHE] Stats: ${cacheStats.hits} hits, ${cacheStats.misses} misses (${cacheStats.hitRate})`);
    }

    // 🚀 PARALLEL: Search with all embeddings in parallel
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
        return Promise.resolve(this.vectorStore!.search(
          queryEmbedding,
          topK,
          documentIdsFilter
        ));
      }
    });

    const allSearchResults = await Promise.all(searchPromises);
    const searchDuration = Date.now() - searchStart2;
    console.log(`✅ [PDF-SERVICE] All searches completed in ${searchDuration}ms`);

    // Merge results (keep best score per chunk)
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

    console.log(`🔍 [PDF-SERVICE] Merged ${allResults.size} unique chunks from ${expandedQueries.length} query variants`);

    // Convertir Map en array et trier par similarité
    let mergedResults = Array.from(allResults.values())
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK); // Garder seulement top K résultats

    // Filter by similarity threshold
    let filteredResults = mergedResults.filter(r => r.similarity >= threshold);

    // 🆕 Fallback automatique pour recherche multilingue
    if (filteredResults.length === 0 && mergedResults.length > 0) {
      const minFallbackResults = Math.min(3, mergedResults.length);
      console.warn('⚠️  [PDF-SERVICE DEBUG] All results filtered out by threshold!');
      console.warn('⚠️  [PDF-SERVICE DEBUG] Applying fallback: keeping top', minFallbackResults, 'results');
      console.warn('⚠️  [PDF-SERVICE DEBUG] Best similarity:', mergedResults[0]?.similarity.toFixed(4));
      console.warn('⚠️  [PDF-SERVICE DEBUG] This may indicate cross-language search (e.g., FR query → EN docs)');

      filteredResults = mergedResults.slice(0, minFallbackResults);
    }

    console.log('🔍 [PDF-SERVICE DEBUG] Secondary search results:', {
      totalUniqueChunks: mergedResults.length,
      filteredResults: filteredResults.length,
      threshold: threshold,
      fallbackApplied: filteredResults.length > 0 && filteredResults.length < mergedResults.filter(r => r.similarity >= threshold).length,
      totalDuration: `${Date.now() - searchStart}ms`,
    });

    return filteredResults;
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
    const documents = this.vectorStore!.getAllDocuments();
    return documents.find((doc) => doc.id === documentId) || null;
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
    } catch (error) {
      console.warn('⚠️  [PROJECT CONTEXT] Could not read context file:', error);
    }

    return null;
  }

  /**
   * Construit et retourne le graphe de connaissances
   */
  async buildKnowledgeGraph(options?: any) {
    this.ensureInitialized();

    // Récupérer le seuil de similarité depuis la configuration utilisateur
    const ragConfig = configManager.get('rag');
    const defaultThreshold = ragConfig?.explorationSimilarityThreshold ?? 0.7;

    const graphBuilder = new KnowledgeGraphBuilder(this.vectorStore!);
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

    // Récupérer le texte de chaque document
    const corpusDocuments: Array<{ id: string; text: string }> = [];

    for (const doc of documents) {
      const chunks = this.vectorStore!.getChunksForDocument(doc.id);
      console.log(`   Document ${doc.id.substring(0, 8)}: ${chunks.length} chunks`);

      const fullText = chunks.map((chunkWithEmbedding) => chunkWithEmbedding.chunk.content).join(' ');
      console.log(`   Text length: ${fullText.length} characters`);

      corpusDocuments.push({
        id: doc.id,
        text: fullText,
      });
    }

    console.log(`📊 Total corpus documents prepared: ${corpusDocuments.length}`);
    console.log(`📊 Total text length: ${corpusDocuments.reduce((sum, doc) => sum + doc.text.length, 0)} characters`);

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
  async analyzeTopics(options?: any) {
    this.ensureInitialized();

    const documents = await this.vectorStore!.getAllDocuments();

    if (documents.length < 5) {
      throw new Error('Topic modeling requires at least 5 documents');
    }

    // Récupérer les embeddings et textes
    const embeddings: Float32Array[] = [];
    const texts: string[] = [];
    const documentIds: string[] = [];

    // D'abord, déterminer la dimension d'embedding la plus commune
    const dimensionCounts = new Map<number, number>();

    for (const doc of documents) {
      let embedding: Float32Array | null = null;

      if (doc.summaryEmbedding) {
        embedding = doc.summaryEmbedding;
      } else {
        const chunks = this.vectorStore!.getChunksForDocument(doc.id);
        if (chunks.length > 0 && chunks[0].embedding) {
          embedding = chunks[0].embedding;
        }
      }

      if (embedding && embedding.length > 0) {
        const count = dimensionCounts.get(embedding.length) || 0;
        dimensionCounts.set(embedding.length, count + 1);
      }
    }

    // Trouver la dimension la plus fréquente
    let expectedDimension = 0;
    let maxCount = 0;
    for (const [dim, count] of dimensionCounts.entries()) {
      if (count > maxCount) {
        maxCount = count;
        expectedDimension = dim;
      }
    }

    console.log(`📊 Expected embedding dimension: ${expectedDimension} (found in ${maxCount} documents)`);
    if (dimensionCounts.size > 1) {
      console.warn(`⚠️ Found ${dimensionCounts.size} different embedding dimensions:`, Array.from(dimensionCounts.entries()));
    }

    // Maintenant collecter les embeddings avec la bonne dimension
    for (const doc of documents) {
      // Utiliser le résumé si disponible, sinon le titre
      const text = doc.summary || doc.title;
      let embedding: Float32Array | null = null;

      // Essayer d'utiliser l'embedding du résumé
      if (doc.summaryEmbedding) {
        embedding = doc.summaryEmbedding;
      } else {
        // Sinon, utiliser l'embedding du premier chunk
        const chunks = this.vectorStore!.getChunksForDocument(doc.id);
        if (chunks.length > 0 && chunks[0].embedding) {
          embedding = chunks[0].embedding;
        }
      }

      if (text && embedding) {
        // Vérifier la dimension
        if (embedding.length !== expectedDimension) {
          console.warn(`⚠️ Skipping document ${doc.id}: wrong embedding dimension (expected ${expectedDimension}, got ${embedding.length})`);
          continue;
        }

        // Valider que l'embedding est complet (pas de valeurs null/undefined)
        const isValid = embedding.length > 0 && !Array.from(embedding).some(v => v === null || v === undefined || isNaN(v));

        if (isValid) {
          embeddings.push(embedding);
          texts.push(text);
          documentIds.push(doc.id);
        } else {
          console.warn(`⚠️ Skipping document ${doc.id}: invalid embedding (contains null/NaN values)`);
        }
      }
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

    const analysisOptions = {
      minTopicSize: adjustedMinTopicSize,
      nrTopics: requestedTopics,
      language: options?.language || 'multilingual',
      nGramRange: options?.nGramRange || [1, 3],
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
