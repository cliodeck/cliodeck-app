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
import type { RebuildProgressEvent } from '../../../backend/types/rebuild-progress.js';
import type { RAGConfig } from '../../../backend/types/config.js';
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
  /** La section `rag` que l'indexeur a lue. */
  private appliedRagConfig: string | null = null;
  private vectorStore: VectorStore | EnhancedVectorStore | null = null;
  private currentProjectPath: string | null = null;

  /**
   * Indexations en vol. `init()`/`close()` les attendent avant de fermer le
   * store : l'indexeur garde sa propre référence SQLite et une bascule de
   * projet en plein `await` d'extraction le laissait écrire sur un handle
   * fermé (« database connection is not open »).
   */
  private inFlightIndexing = new Set<Promise<unknown>>();

  /**
   * Reconstruction des fournisseurs en cours (`refreshProviders`). L'attente des indexations ne porte
   * que sur celles déjà en vol : une indexation lancée pendant cette attente prenait l'ancien indexeur,
   * dont le registre libère le fournisseur juste après. `indexPDF` attend donc la fin de la
   * reconstruction et prend l'indexeur refait.
   */
  private providerRefresh: Promise<void> | null = null;

  /**
   * Typed provider registries (fusion 1.2e). pdf-service owns the
   * `ProviderRegistry` lifecycle for the active project: built from
   * the workspace LLM config in `init()`, rebuilt by `refreshProviders()`,
   * disposed at `init()` re-entry. One per half — `registry` for
   * embeddings, `llmRegistry` for generation — because a registry only
   * builds and disposes the half it was asked for: a generation change
   * leaves the indexer's embedding provider alive. Replaces the legacy
   * `OllamaClient` + `LLMProviderManager` pair that this service used to
   * instantiate twice per project.
   */
  private registry: ProviderRegistry | null = null;
  private llmRegistry: ProviderRegistry | null = null;
  private llm: LLMProvider | null = null;
  private embedding: EmbeddingProvider | null = null;
  /**
   * Pourquoi la dernière construction des registres a échoué (clé cloud absente ou illisible…), ou
   * null. Un registre invalide n'empêche plus d'ouvrir le projet : seule l'indexation, qui a besoin
   * des embeddings, le refuse, en citant cette cause.
   */
  private registryError: string | null = null;

  /**
   * Initialise le PDF Service pour un projet spécifique
   * @param projectPath Chemin absolu vers le dossier du projet
   * @param onRebuildProgress Callback optionnel pour la progression du rebuild
   * @throws Error si projectPath n'est pas fourni
   */
  async init(
    projectPath: string,
    onRebuildProgress?: (progress: RebuildProgressEvent) => void
  ) {
    if (!projectPath) {
      throw new Error('PDF Service requires a project path');
    }

    // Fermer la base précédente si elle existe — après avoir laissé les
    // indexations en vol se terminer (ou expirer).
    if (this.vectorStore) {
      await this.drainInFlightIndexing();
      this.vectorStore.close();
    }
    // Plus rien ne pointe sur le magasin fermé : si l'ouverture du nouveau échoue, les lectures disent
    // « not initialized » et une reconstruction des fournisseurs ne bâtit pas d'indexeur dessus.
    this.vectorStore = null;
    this.pdfIndexer = null;

    try {
      const config = configManager.getLLMConfig();
      const ragConfig = configManager.getRAGConfig();

      // Build the typed provider registry from the active config.
      // Replaces the previous `new OllamaClient(...)` + `new LLMProviderManager(...)`
      // pair (the latter held a *third* OllamaClient internally — that's
      // gone now too). Ne lève pas : un registre invalide laisse le projet s'ouvrir sans fournisseurs.
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

      await this.removeDuplicateDocuments(store, projectPath);

      // Post-init: configure search modes on the enhanced store. Any
      // rebuild is deferred until after warmup (see below) so we don't
      // run embedding warmup + a large batched rebuild concurrently.
      PdfVectorStore.configureEnhanced(this.vectorStore, ragConfig);

      // Log RAG optimization features
      console.log('📝 [PDF-SERVICE] RAG optimization config:', {
        enableQualityFiltering: ragConfig.enableQualityFiltering ?? true,
        enablePreprocessing: ragConfig.enablePreprocessing ?? true,
        enableDeduplication: ragConfig.enableDeduplication ?? true,
        useSemanticChunking: ragConfig.useSemanticChunking ?? false,
        customChunkingEnabled: ragConfig.customChunkingEnabled ?? false,
      });

      if (this.embedding) {
        this.createIndexer(ragConfig);
      }

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
      console.log(`   VectorStore DB: ${projectPath}/.cliodeck/brain.db (pdf_*)`);
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
      // La recherche a pu rester configurée sur le magasin qu'on vient de fermer.
      this.vectorStore = null;
      this.pdfIndexer = null;
      this.currentProjectPath = null;
      retrievalService.clear();
      throw error;
    }
  }

  /**
   * Construit l'indexeur (façade — la fonction d'embedding et la construction du backend PDFIndexer
   * vivent dans ./pdf/PdfIndexer.ts). Le découpage, le filtrage et le résumé s'y figent.
   */
  private createIndexer(ragConfig: RAGConfig): void {
    if (!this.vectorStore) {
      throw new Error('PDF Service: vector store not open');
    }
    if (!this.embedding) {
      throw new Error('PDF Service: embedding provider not configured');
    }
    // Convertir le nouveau format de config en ancien format pour le summarizer
    // Support pour compatibilité ascendante et descendante
    const summarizerConfig = ragConfig.summarizer || {
      enabled: ragConfig.summaryGeneration !== 'disabled' && ragConfig.summaryGeneration !== undefined,
      method: ragConfig.summaryGeneration === 'abstractive' ? 'abstractive' : 'extractive',
      maxLength: ragConfig.summaryMaxLength || 750,
      llmModel: configManager.getLLMConfig().ollamaChatModel,
    };

    console.log('📝 [PDF-SERVICE] Summarizer config:', {
      enabled: summarizerConfig.enabled,
      method: summarizerConfig.method,
      maxLength: summarizerConfig.maxLength,
    });

    this.pdfIndexer = new PdfIndexer({
      vectorStore: this.vectorStore,
      embeddingProvider: this.embedding,
      ragConfig,
      summarizerConfig,
    });
    this.appliedRagConfig = JSON.stringify(ragConfig);
  }

  /**
   * Répercute la section `rag` qui vient d'être écrite. Sans ça, seul `config:set('llm')` passe par
   * `init` : un changement de découpage seul restait sans effet jusqu'à la réouverture du projet, et
   * la réindexation suivante écrivait avec l'ancien préréglage, sans erreur.
   *
   * Ce n'est pas une relance : ni magasin fermé, ni fournisseurs refaits. Une indexation en vol finit
   * avec l'indexeur qu'elle a. Services à l'arrêt : `init` relira la section.
   */
  applyRagConfig(): void {
    if (!this.vectorStore || !this.embedding) return;
    const ragConfig = configManager.getRAGConfig();
    if (JSON.stringify(ragConfig) === this.appliedRagConfig) return;
    PdfVectorStore.configureEnhanced(this.vectorStore, ragConfig);
    this.createIndexer(ragConfig);
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
   * Build (or rebuild) the typed provider registries from the active
   * workspace LLM config. Disposes the previous ones first so the
   * native handles / HTTP agents they own are released cleanly. With
   * `embedding: false`, only the generation half is rebuilt. Used by
   * `init()` and `refreshProviders()`.
   *
   * Ne lève pas : rend la cause d'un échec (et la garde dans `registryError`), null sinon.
   */
  private async rebuildLLMRegistry({ embedding = true }: { embedding?: boolean } = {}): Promise<string | null> {
    const previous = embedding ? [this.llmRegistry, this.registry] : [this.llmRegistry];
    this.llmRegistry = null;
    this.llm = null;
    if (embedding) {
      this.registry = null;
      this.embedding = null;
    }
    await Promise.all(previous.map((r) => r?.dispose().catch(() => undefined)));

    try {
      const llmConfig = configManager.getLLMConfig();
      this.llmRegistry = createRegistryFromClioDeckConfig(llmConfig);
      this.llm = this.llmRegistry.getLLM();
      if (embedding) {
        this.registry = createRegistryFromClioDeckConfig(llmConfig);
        this.embedding = this.registry.getEmbedding();
      }
      this.registryError = null;
    } catch (e) {
      console.error('❌ [PDF-SERVICE] Failed to build provider registry:', e);
      // Tout à null : une configuration qui ne se construit pas ne laisse aucun fournisseur servir.
      const failed = [this.llmRegistry, this.registry];
      this.registry = null;
      this.llmRegistry = null;
      this.llm = null;
      this.embedding = null;
      await Promise.all(failed.map((r) => r?.dispose().catch(() => undefined)));
      this.registryError = e instanceof Error ? e.message : String(e);
    }
    return this.registryError;
  }

  /**
   * Relit la configuration des fournisseurs après un changement de réglages, sans rouvrir le projet.
   *
   * Embeddings changés : l'indexeur capture son fournisseur à la construction, et le `BackendPDFIndexer`
   * garde un cache d'embeddings indexé par texte. Refaire le registre sans refaire l'indexeur laissait
   * la réindexation demandée par l'interface écrire avec l'ancien modèle — ou avec un fournisseur
   * libéré. On attend donc les indexations en vol, puis on refait registre et indexeur.
   *
   * Génération seule : le registre de génération est refait, sans attendre ni toucher à l'indexeur.
   * Aucun magasin n'est ouvert ici : sans projet, `init` construira tout.
   */
  async refreshProviders({ embeddingChanged }: { embeddingChanged: boolean }): Promise<void> {
    // Une reconstruction à la fois, et `indexPDF` attend la reconstruction en cours (voir
    // `providerRefresh`). Le suivi ne rejette jamais : l'erreur revient à l'appelant par `run`.
    const previous = this.providerRefresh;
    const run = (async () => {
      await previous;
      await this.rebuildProviders({ embeddingChanged });
    })();
    const tracked: Promise<void> = run
      .catch(() => undefined)
      .finally(() => {
        if (this.providerRefresh === tracked) this.providerRefresh = null;
      });
    this.providerRefresh = tracked;
    return run;
  }

  private async rebuildProviders({ embeddingChanged }: { embeddingChanged: boolean }): Promise<void> {
    if (embeddingChanged) await this.drainInFlightIndexing();
    const cause = await this.rebuildLLMRegistry({ embedding: embeddingChanged });
    if (cause !== null) {
      // Un échec libère tout : l'indexeur tiendrait un fournisseur libéré. L'erreur remonte au
      // panneau des réglages, qui dit que la configuration n'est pas appliquée.
      this.pdfIndexer = null;
      throw new Error(cause);
    }
    if (embeddingChanged) {
      this.pdfIndexer = null;
      if (this.vectorStore && this.embedding) {
        this.createIndexer(configManager.getRAGConfig());
      }
    }
  }

  /** Vrai quand les fournisseurs manquent : la dernière construction a échoué, tout est à refaire. */
  providersMissing(): boolean {
    return !this.llm || !this.embedding;
  }

  /**
   * Vérifie que le magasin est ouvert. Les lectures n'ont pas besoin des fournisseurs : une clé
   * cloud illisible ne doit pas cacher la bibliographie.
   */
  private ensureStore() {
    if (!this.vectorStore) {
      throw new Error('PDF Service not initialized. Call init(projectPath) first.');
    }
  }

  /** Vérifie que l'indexation est possible : magasin ouvert et fournisseur d'embeddings construit. */
  private ensureIndexer() {
    this.ensureStore();
    if (!this.pdfIndexer) {
      throw new Error(
        `Fournisseur d'embeddings indisponible : ${this.registryError ?? 'registre non construit'}`
      );
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
    while (this.providerRefresh) await this.providerRefresh;
    this.ensureIndexer();
    const job = this.pdfIndexer!.indexPDF(
      filePath,
      bibtexKey,
      onProgress,
      bibliographyMetadata,
      collectionKeys
    );
    this.inFlightIndexing.add(job);
    void job
      .catch(() => undefined)
      .finally(() => {
        this.inFlightIndexing.delete(job);
        // Une réindexation a pu remplacer des copies : leurs vecteurs
        // restent dans HNSW jusqu'à reconstruction.
        this.scheduleIndexRebuild();
      });
    return job;
  }

  /**
   * Nettoie les documents en double hérités des versions précédentes (un
   * même PDF indexé à chaque clic sur « Indexer tous les PDFs » ou
   * « Télécharger depuis Zotero »). Sauvegarde `brain.db` avant d'y toucher.
   * Best-effort : un échec laisse la base telle quelle et n'empêche pas
   * l'ouverture du projet.
   */
  private async removeDuplicateDocuments(
    store: VectorStore | EnhancedVectorStore,
    projectPath: string
  ): Promise<void> {
    try {
      const extra = store.countDuplicateDocuments();
      if (extra === 0) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = path.join(projectPath, '.cliodeck', `brain.db.avant-dedoublonnage-${stamp}`);
      await store.backupTo(backup);
      const { files, removed } = store.removeDuplicateDocuments();
      console.log(
        `♻️  [PDF-SERVICE] ${removed} document(s) en double retiré(s) pour ${files} fichier(s) ; sauvegarde : ${backup}`
      );
    } catch (error: unknown) {
      console.error('❌ [PDF-SERVICE] Nettoyage des doublons impossible, base inchangée :', error);
    }
  }

  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Reconstruit HNSW/BM25 quand des documents ont quitté SQLite, une fois
   * les indexations en vol terminées : reconstruire pendant qu'une autre
   * écrit ses extraits ferait la course sur l'index.
   */
  private scheduleIndexRebuild(delayMs = 2000): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      const store = this.vectorStore;
      if (!store) return;
      if (this.inFlightIndexing.size > 0) {
        this.scheduleIndexRebuild(delayMs);
        return;
      }
      void PdfVectorStore.maybeRebuild(store);
    }, delayMs);
  }

  /**
   * Attend la fin des indexations en vol avant une fermeture de store.
   * Attente bornée : une extraction bloquée ne doit pas geler la bascule
   * de projet — au-delà du délai, on ferme quand même (l'indexation
   * échouera avec une erreur visible côté renderer, pas un crash muet).
   */
  private async drainInFlightIndexing(timeoutMs = 30_000): Promise<void> {
    if (this.inFlightIndexing.size === 0) return;
    console.log(
      `⏳ ${this.inFlightIndexing.size} indexation(s) PDF en vol — attente avant fermeture du vector store`
    );
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const drained = Promise.allSettled([...this.inFlightIndexing]).then(
      () => 'drained' as const
    );
    const outcome = await Promise.race([drained, timeout]);
    if (timer) clearTimeout(timer);
    if (outcome === 'timeout') {
      console.warn(
        `⚠️ Indexation(s) PDF toujours en vol après ${timeoutMs}ms — fermeture du store malgré tout`
      );
    }
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
    this.ensureStore();
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
    this.ensureStore();
    return this.vectorStore!.getAllDocuments();
  }

  /**
   * Get a specific document by its ID
   */
  async getDocument(documentId: string) {
    this.ensureStore();
    // Indexed lookup — avoids hydrating the full document list (+ N
    // chunk-count queries) just to find one by id.
    return PdfVectorStore.getDocumentById(this.vectorStore!, documentId) || null;
  }

  async deleteDocument(documentId: string) {
    this.ensureStore();
    const result = this.vectorStore!.deleteDocument(documentId);
    this.scheduleIndexRebuild();
    return result;
  }

  async getStatistics() {
    this.ensureStore();
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

  getVectorStore() {
    return this.vectorStore;
  }

  /**
   * Construit et retourne le graphe de connaissances
   */
  async buildKnowledgeGraph(options?: KnowledgeGraphOptions): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    this.ensureStore();

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
   * Returns the subgraph containing only the given document IDs and edges between them.
   * Lightweight: builds the full graph once, then filters. Useful for per-turn visualization.
   */
  async getSubgraphForDocuments(documentIds: string[]): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    this.ensureStore();
    if (documentIds.length === 0) return { nodes: [], edges: [] };

    const full = await this.buildKnowledgeGraph({
      includeSimilarityEdges: true,
      includeAuthorNodes: false,
      computeLayout: false,
    });

    const idSet = new Set(documentIds);
    const nodes = full.nodes.filter((n) => idSet.has(n.id));
    const edges = full.edges.filter(
      (e) => idSet.has(typeof e.source === 'string' ? e.source : (e.source as GraphNode).id)
        && idSet.has(typeof e.target === 'string' ? e.target : (e.target as GraphNode).id)
    );

    // Simple grid layout for the small subgraph
    const cols = Math.ceil(Math.sqrt(nodes.length));
    nodes.forEach((n, i) => {
      n.x = (i % cols) * 150;
      n.y = Math.floor(i / cols) * 150;
    });

    return { nodes, edges };
  }

  /**
   * Retourne les statistiques du corpus
   */
  async getCorpusStatistics() {
    this.ensureStore();

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
    this.ensureStore();

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
    this.ensureStore();

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
    this.ensureStore();

    const result = this.vectorStore!.loadLatestTopicAnalysis();
    return result;
  }

  /**
   * Récupère les données temporelles des topics (pour stream graph)
   */
  getTopicTimeline() {
    this.ensureStore();

    const result = this.vectorStore!.getTopicTimeline();
    return result;
  }

  /**
   * Purge toutes les données de la base vectorielle
   */
  purgeAllData() {
    this.ensureStore();

    console.log('🗑️ Purging all data from vector store...');
    this.vectorStore!.purgeAllData();
    console.log('✅ Vector store purged successfully');
  }

  /**
   * Nettoie les chunks orphelins (sans document parent)
   */
  cleanOrphanedChunks() {
    this.ensureStore();

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
      await this.drainInFlightIndexing();
      this.vectorStore.close();
      this.vectorStore = null;
    }

    // Libérer les ressources des registres typés (HTTP agents, native handles).
    if (this.registry || this.llmRegistry) {
      console.log('🔒 Disposing LLM provider registry...');
      const previous = [this.registry, this.llmRegistry];
      this.registry = null;
      this.llmRegistry = null;
      this.llm = null;
      this.embedding = null;
      await Promise.all(previous.map((r) => r?.dispose().catch(() => undefined)));
    }

    this.pdfIndexer = null;
    this.currentProjectPath = null;

    console.log('✅ PDF Service closed');
  }
}

export const pdfService = new PDFService();
