import { VectorStore, type IndexRebuildReason } from './VectorStore';
import { HNSWVectorStore } from './HNSWVectorStore';
import { BM25Index } from '../search/BM25Index';
import { HybridSearch } from '../search/HybridSearch';
import type { SearchResult, DocumentChunk } from '../../types/pdf-document';
import type { RebuildProgressEvent } from '../../types/rebuild-progress';

/**
 * Enhanced Vector Store with HNSW indexing and BM25 hybrid search
 *
 * This wrapper extends the existing VectorStore with:
 * 1. HNSW index for fast approximate nearest neighbor search
 * 2. BM25 index for keyword-based search
 * 3. Hybrid search combining both methods
 *
 * Performance improvements:
 * - Search time: 500ms → 30ms (16x faster)
 * - Precision@10: +15-20% (with hybrid search)
 *
 * Memory overhead: ~650 MB for 50k chunks
 */
export class EnhancedVectorStore {
  private vectorStore: VectorStore;
  private hnswStore: HNSWVectorStore;
  private bm25Index: BM25Index;
  private hybridSearch: HybridSearch;
  private useHNSW: boolean = true;
  private useHybrid: boolean = true;

  // Rebuild status tracking
  private isRebuilding: boolean = false;
  /**
   * Des documents ont quitté SQLite : HNSW et BM25 ne savent pas retirer un
   * vecteur, ils gardent ceux des extraits supprimés jusqu'à reconstruction.
   * Noté aussi dans `brain.db` (`markStale`) : une reconstruction abandonnée à la
   * fermeture du projet se propose à la réouverture (J8).
   */
  private indexesStale: boolean = false;
  /**
   * Une session précédente a laissé l'index à reconstruire (la marque de `brain.db`), et
   * l'ouverture ne l'a pas refait d'office : la reconstruction est proposée à l'historien,
   * jamais lancée sans lui. Tombe quand une reconstruction réussit.
   */
  private proposeRebuild: boolean = false;
  /**
   * La dernière reconstruction a échoué, et l'auteur l'a lu : le message lui promet
   * la prochaine ouverture. Rien ne repart avant, sauf s'il y a un nouveau motif :
   * `indexesStale`, parce que des documents ont quitté SQLite, ou que de nouveaux
   * extraits arrivent sur un index incomplet.
   */
  private rebuildFailureReported: boolean = false;
  /**
   * HNSW et BM25 en mémoire ne contiennent pas tout le corpus : une reconstruction les
   * a vidés et s'est arrêtée avant de les remplir. Cet état-là ne s'écrit jamais sur le
   * disque : la prochaine ouverture, trouvant un index non vide, ne reconstruirait rien,
   * et le reste du corpus sortirait de la recherche par le sens, sans un mot.
   */
  private indexesIncomplete: boolean = false;
  /** Ce store n'a plus de projet à l'écran : il n'a plus rien à reconstruire ni à publier. */
  private closed: boolean = false;
  private rebuildProgress: {
    current: number;
    total: number;
    status: string;
  } = { current: 0, total: 0, status: 'idle' };

  // Callback for progress updates
  private onRebuildProgress?: (progress: RebuildProgressEvent) => void;

  constructor(projectPath: string) {
    console.log('🚀 Initializing Enhanced Vector Store...');

    // Initialize base vector store (SQLite)
    this.vectorStore = new VectorStore(projectPath);

    // Detect embedding dimension from existing data
    const embeddingDimension = this.vectorStore.getEmbeddingDimension();
    const dimension = embeddingDimension || 768; // Default to 768 if no embeddings exist

    if (embeddingDimension) {
      console.log(`📏 Detected embedding dimension: ${dimension}`);
    } else {
      console.log(`📏 No existing embeddings found, using default dimension: ${dimension}`);
    }

    // Initialize HNSW index with detected dimension
    this.hnswStore = new HNSWVectorStore(projectPath, dimension);

    // Initialize BM25 index
    this.bm25Index = new BM25Index();

    // Initialize hybrid search
    this.hybridSearch = new HybridSearch();
    this.hybridSearch.setHNSWStore(this.hnswStore);
    this.hybridSearch.setBM25Index(this.bm25Index);

    console.log('✅ Enhanced Vector Store initialized');
  }

  /**
   * Initialize all indexes with automatic corruption recovery
   * NOTE: HNSW index loading is synchronous and may block for large indexes
   */
  async initialize(): Promise<void> {
    console.log('📥 Loading indexes (this may take a moment for large corpora)...');
    const startTime = Date.now();

    // Initialize HNSW (with corruption detection)
    const hnswResult = await this.hnswStore.initialize();

    if (hnswResult.corrupted) {
      console.warn('⚠️  HNSW index was corrupted, will rebuild from SQLite...');
    }

    // Load metadata if exists (with validation)
    const metadataLoaded = await this.hnswStore.loadMetadata();

    // Check if we need to rebuild
    const needsRebuild = hnswResult.corrupted ||
                         this.hnswStore.wasIndexCorrupted() ||
                         (!metadataLoaded && this.hnswStore.getSize() === 0);

    if (needsRebuild) {
      // Check if there's data in SQLite to rebuild from
      const chunks = this.vectorStore.getAllChunksWithEmbeddings();
      if (chunks.length > 0) {
        console.log(`🔄 Auto-rebuilding HNSW index from ${chunks.length} chunks in SQLite...`);
        try {
          await this.rebuildIndexes();
          console.log('✅ HNSW index rebuilt successfully from SQLite');
        } catch (rebuildError) {
          console.error('❌ Failed to rebuild indexes:', rebuildError.message);
          // Le projet s'ouvre quand même : la recherche lèvera tant que l'index restera vide,
          // sauf HNSW désactivé dans la configuration (recherche linéaire, cf. `search`).
        }
      }
    } else {
      // Rebuild BM25 from HNSW metadata if available
      if (this.hnswStore.getSize() > 0) {
        await this.rebuildBM25FromHNSW();
      }
    }

    // La marque d'une session précédente (J8). Un index refait d'office ci-dessus l'a effacée, et un
    // index vide se refait au préchauffage s'il y a des extraits (`needsRebuild`) : reste un index non
    // vide, que rien ne refait d'office. Il est proposé à l'historien, pas reconstruit sans lui.
    this.proposeRebuild = this.hnswStore.getSize() > 0 && this.rebuildMarked();

    const duration = Date.now() - startTime;
    console.log(`✅ Indexes loaded in ${duration}ms`);
    console.log(`HNSW indexing: ${this.useHNSW ? 'enabled' : 'disabled'}`);
    console.log(`Hybrid search: ${this.useHybrid ? 'enabled' : 'disabled'}`);
  }

  /**
   * Set progress callback for rebuild operations
   */
  setRebuildProgressCallback(callback: (progress: RebuildProgressEvent) => void): void {
    this.onRebuildProgress = callback;
  }

  /**
   * Check if indexes need to be rebuilt
   */
  needsRebuild(): boolean {
    if (this.closed) return false;
    if (this.indexesStale) return true;
    if (this.rebuildFailureReported) return false;
    const hnswSize = this.hnswStore.getSize();
    const chunks = this.vectorStore.getAllChunksWithEmbeddings();
    return hnswSize === 0 && chunks.length > 0;
  }

  /**
   * Get rebuild status
   */
  getRebuildStatus(): {
    isRebuilding: boolean;
    /** La reconstruction que la réouverture propose (J8) : ni en cours, ni échouée depuis. */
    rebuildDue: boolean;
    current: number;
    total: number;
    status: string;
    percentage: number;
  } {
    const percentage =
      this.rebuildProgress.total > 0
        ? Math.round((this.rebuildProgress.current / this.rebuildProgress.total) * 100)
        : 0;
    return {
      isRebuilding: this.isRebuilding,
      rebuildDue: this.rebuildProposed(),
      ...this.rebuildProgress,
      percentage,
    };
  }

  /**
   * Proposée tant qu'aucune reconstruction n'a réussi. Pas pendant l'une d'elles, ni après un échec :
   * son message promet déjà la prochaine ouverture, où la marque, restée, la proposera de nouveau.
   */
  private rebuildProposed(): boolean {
    return this.proposeRebuild && !this.closed && !this.isRebuilding && !this.rebuildFailureReported;
  }

  /**
   * L'historien a accepté la reconstruction proposée. Rend faux s'il n'y a rien à reconstruire ; sinon
   * l'index est périmé, et la reconstruction part par le chemin ordinaire (`needsRebuild`, puis
   * `rebuildIndexes`) : depuis les vecteurs de SQLite, sans aucun appel au fournisseur d'embeddings.
   */
  requestRebuild(): boolean {
    if (!this.rebuildProposed()) return false;
    this.indexesStale = true;
    return true;
  }

  /** La marque de `brain.db`, lue sans faire échouer l'ouverture : illisible, rien n'est proposé. */
  private rebuildMarked(): boolean {
    try {
      return this.vectorStore.getIndexRebuildDue() !== null;
    } catch (error: unknown) {
      console.warn('⚠️  Index rebuild mark unreadable:', error);
      return false;
    }
  }

  /**
   * L'index ne correspond plus à SQLite : à reconstruire, dans cette session et, si elle se ferme
   * avant, à la réouverture (J8). La marque est posée après l'écriture dans SQLite, jamais avant : un
   * index sain n'en porte pas. Une marque qui ne s'écrit pas ne fait pas échouer l'écriture faite.
   */
  private markStale(reason: IndexRebuildReason): void {
    this.indexesStale = true;
    try {
      this.vectorStore.markIndexRebuildDue(reason);
    } catch (error: unknown) {
      console.warn('⚠️  Index rebuild mark not written:', error);
    }
  }

  /**
   * Add a chunk with embedding to all indexes
   */
  async addChunk(chunk: DocumentChunk, embedding: Float32Array): Promise<void> {
    this.markStaleIfIncomplete();

    // Save to SQLite (original store)
    await this.vectorStore.saveChunk(chunk, embedding);

    // Add to HNSW index
    await this.hnswStore.addChunk(chunk, embedding);

    // Add to BM25 index
    this.bm25Index.addChunk(chunk);
  }

  /**
   * Ajoute à HNSW et BM25 des extraits déjà écrits dans SQLite, puis enregistre l'index.
   *
   * SQLite les reçoit avant, dans la transaction de l'indexation (`transaction`), avec leur
   * document : HNSW et BM25 ne savent pas s'y joindre. Si ces index ne les prennent pas tous, la
   * base les garde : ils sont marqués périmés, et la reconstruction que planifie toute indexation
   * les y mettra depuis SQLite. L'erreur est relancée ; `PDFIndexer` l'écrit au journal sans faire
   * échouer la passe, dont le document est déjà complet en base.
   */
  async addToSearchIndexes(
    chunks: Array<{ chunk: DocumentChunk; embedding: Float32Array }>
  ): Promise<void> {
    console.log(`📥 [ENHANCED] Adding ${chunks.length} chunks to HNSW and BM25...`);
    this.markStaleIfIncomplete();

    try {
      await this.hnswStore.addChunks(chunks);
      this.bm25Index.addChunks(chunks.map((c) => c.chunk));
      await this.save();
    } catch (error) {
      this.markStale('chunks-missing');
      throw error;
    }
    console.log(`📥 [ENHANCED] HNSW and BM25 updated, indexes saved`);
  }

  /**
   * De nouveaux extraits sur un index incomplet sont un nouveau motif : la reconstruction
   * que planifie toute indexation refera le corpus entier. Avant de les ajouter : même si
   * l'ajout échoue en route, SQLite les a déjà reçus.
   */
  private markStaleIfIncomplete(): void {
    if (this.indexesIncomplete) this.markStale('chunks-missing');
  }

  /**
   * Search using enhanced hybrid search
   */
  async search(
    query: string,
    queryEmbedding: Float32Array,
    k: number = 10,
    documentIds?: string[]
  ): Promise<SearchResult[]> {
    const startTime = Date.now();

    let results: SearchResult[];

    // HNSW désactivé dans la configuration (`rag.useHNSWIndex: false`) : recherche linéaire, exacte,
    // sur les extraits de SQLite, qui rend chacun avec son document. Elle levait à chaque question
    // (S01-1-8). Elle ne lit ni HNSW ni BM25 : une reconstruction en cours ne la retient pas. Pas de
    // fusion avec BM25 : la recherche hybride (`useHybridSearch`) est celle de HNSW et de BM25.
    if (!this.useHNSW) {
      results = this.vectorStore.search(queryEmbedding, k, documentIds);
      console.log(
        `🔍 Search completed: ${results.length} results in ${Date.now() - startTime}ms (mode: linear)`
      );
      return results;
    }

    // If rebuilding, throw error to avoid blocking
    if (this.isRebuilding) {
      const status = this.getRebuildStatus();
      throw new Error(
        `Search indexes are being rebuilt (${status.percentage}%). Please wait a moment and try again.`
      );
    }

    // Check if HNSW is ready
    const hnswSize = this.hnswStore.getSize();
    const hnswReady = hnswSize > 0;

    if (hnswReady) {
      // Use HNSW or hybrid search
      console.log(`🚀 Using HNSW search (${hnswSize} indexed chunks)`);
      results = await this.hybridSearch.search(
        query,
        queryEmbedding,
        k,
        documentIds,
        this.useHybrid
      );
    } else if (this.vectorStore.getStatistics().embeddingCount === 0) {
      // Aucun extrait embarqué dans SQLite : la bibliographie est vide (projet
      // neuf, sans PDF), il n'y a rien à trouver. Lever faisait rapporter le
      // corpus en échec, et le chat disait une panne à chaque question (P212-F).
      return [];
    } else {
      // Des extraits existent mais l'index ne les atteint pas : c'est une
      // panne, pas un corpus vide. Pas de recherche linéaire, trop lente.
      console.warn('⚠️  HNSW index empty - indexes may need to be rebuilt');
      throw new Error(
        'Search indexes are not available. Please wait for the project to finish loading.'
      );
    }

    // Populate document information. Un extrait dont le document a été
    // supprimé (index pas encore reconstruit) est écarté : sans document, il
    // ne peut ni être cité ni être affiché.
    const withDocument: SearchResult[] = [];
    for (const result of results) {
      const doc = await this.vectorStore.getDocument(result.chunk.documentId);
      if (!doc) continue;
      result.document = doc;
      withDocument.push(result);
    }
    results = withDocument;

    const duration = Date.now() - startTime;
    console.log(
      `🔍 Search completed: ${results.length} results in ${duration}ms (mode: ${this.useHybrid ? 'hybrid' : 'HNSW'})`
    );

    return results;
  }

  /**
   * Rebuild all indexes from SQLite with progress tracking
   */
  async rebuildIndexes(): Promise<void> {
    // Base fermée : l'échec irait s'afficher sur le projet suivant, et `clear()`
    // aurait déjà supprimé du disque l'index du projet quitté.
    if (this.closed) return;

    if (this.isRebuilding) {
      throw new Error('Rebuild already in progress');
    }

    this.isRebuilding = true;
    // Levé AVANT de lire SQLite : une suppression pendant la reconstruction
    // le remet, et la reconstruction suivante la prendra en compte.
    this.indexesStale = false;
    this.rebuildFailureReported = false;
    // Dès avant `clear()` : il vide la mémoire d'abord, et peut lever ensuite sur le disque.
    this.indexesIncomplete = true;
    console.log('🔨 Rebuilding all indexes from SQLite...');
    const startTime = Date.now();

    try {
      // Update progress: Starting
      this.rebuildProgress = { current: 0, total: 100, status: 'Initializing...' };
      this.notifyProgress('running');

      // Clear existing indexes
      await this.hnswStore.clear();
      this.bm25Index.clear();

      // Update progress: Loading chunks
      this.rebuildProgress = { current: 10, total: 100, status: 'Loading chunks from database...' };
      this.notifyProgress('running');

      // Get all chunks with embeddings from SQLite
      const chunks = await this.vectorStore.getAllChunksWithEmbeddings();

      if (chunks.length === 0) {
        console.log('⚠️  No chunks to index');
        this.indexesIncomplete = false;
        this.settleRebuildMark();
        this.rebuildProgress = { current: 100, total: 100, status: 'No chunks to index' };
        this.notifyProgress('done');
        return;
      }

      console.log(`📦 Found ${chunks.length} chunks to index`);

      // Update progress: Building HNSW
      this.rebuildProgress = {
        current: 20,
        total: 100,
        status: `Building HNSW index (${chunks.length} chunks)...`,
      };
      this.notifyProgress('running');

      // Add to HNSW (takes ~70% of time)
      await this.hnswStore.addChunks(chunks);

      // Update progress: Building BM25
      this.rebuildProgress = {
        current: 80,
        total: 100,
        status: `Building BM25 index (${chunks.length} chunks)...`,
      };
      this.notifyProgress('running');

      // Add to BM25
      this.bm25Index.addChunks(chunks.map((c) => c.chunk));
      this.indexesIncomplete = false;

      // Update progress: Saving
      this.rebuildProgress = { current: 90, total: 100, status: 'Saving indexes...' };
      this.notifyProgress('running');

      // Save indexes
      await this.save();
      this.settleRebuildMark();

      const duration = Date.now() - startTime;
      console.log(`✅ Indexes rebuilt in ${duration}ms`);

      // Update progress: Complete
      this.rebuildProgress = { current: 100, total: 100, status: 'Rebuild complete' };
      this.notifyProgress('done');
    } catch (error) {
      this.rebuildFailureReported = true;
      console.error('❌ Failed to rebuild indexes:', error);
      // Le `current` atteint reste : rabattu à 0, l'échec se lisait comme un début.
      this.rebuildProgress = { ...this.rebuildProgress, status: `Error: ${error.message}` };
      this.notifyProgress('failed', error.message);
      throw error;
    } finally {
      this.isRebuilding = false;
    }
  }

  /**
   * La reconstruction a fini sans erreur, index écrit : plus rien n'est proposé, et la marque de
   * `brain.db` tombe, sauf si un nouveau motif est arrivé pendant elle (`indexesStale`, remis par une
   * suppression). Seule cette sortie l'efface : un échec la laisse pour la réouverture.
   */
  private settleRebuildMark(): void {
    this.proposeRebuild = false;
    if (this.indexesStale) return;
    try {
      this.vectorStore.clearIndexRebuildDue();
    } catch (error: unknown) {
      console.warn('⚠️  Index rebuild mark not cleared:', error);
    }
  }

  /**
   * Notify progress callback
   */
  private notifyProgress(phase: RebuildProgressEvent['phase'], error?: string): void {
    if (this.onRebuildProgress) {
      const percentage =
        this.rebuildProgress.total > 0
          ? Math.round((this.rebuildProgress.current / this.rebuildProgress.total) * 100)
          : 0;
      this.onRebuildProgress({
        ...this.rebuildProgress,
        percentage,
        phase,
        error,
      });
    }
  }

  /**
   * Rebuild BM25 from HNSW metadata (faster than from SQLite)
   */
  private async rebuildBM25FromHNSW(): Promise<void> {
    console.log('🔨 Rebuilding BM25 from HNSW metadata...');

    // Get all chunks from HNSW
    const chunks: DocumentChunk[] = [];
    const hnswStats = this.hnswStore.getStats();

    // Note: This is a simplified version. In production, you'd want to
    // iterate through the chunk data map in HNSWVectorStore
    // For now, rebuild from SQLite if needed
    const allChunks = await this.vectorStore.getAllChunksWithEmbeddings();
    this.bm25Index.addChunks(allChunks.map((c) => c.chunk));

    console.log(`✅ BM25 rebuilt with ${allChunks.length} chunks`);
  }

  /**
   * Save all indexes to disk
   */
  async save(): Promise<void> {
    if (this.indexesIncomplete) {
      console.warn('⚠️  Indexes incomplete after a failed rebuild: not written to disk');
      return;
    }
    await this.hnswStore.save();
    // BM25 is rebuilt on load, no need to save
  }

  /**
   * Clear all indexes
   */
  async clear(): Promise<void> {
    await this.hnswStore.clear();
    this.bm25Index.clear();
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<EnhancedStats> {
    const vectorStats = await this.vectorStore.getStatistics();
    const hnswStats = this.hnswStore.getStats();
    const bm25Stats = this.bm25Index.getStats();
    const hybridConfig = this.hybridSearch.getConfig();

    return {
      vector: vectorStats,
      hnsw: hnswStats,
      bm25: bm25Stats,
      hybrid: hybridConfig,
      mode: {
        useHNSW: this.useHNSW,
        useHybrid: this.useHybrid,
      },
    };
  }

  /**
   * Enable/disable HNSW indexing
   */
  setUseHNSW(use: boolean): void {
    this.useHNSW = use;
    console.log(`HNSW indexing: ${use ? 'enabled' : 'disabled'}`);
  }

  /**
   * Enable/disable hybrid search
   */
  setUseHybrid(use: boolean): void {
    this.useHybrid = use;
    console.log(`Hybrid search: ${use ? 'enabled' : 'disabled'}`);
  }

  /**
   * Get underlying VectorStore for backward compatibility
   */
  getBaseStore(): VectorStore {
    return this.vectorStore;
  }

  /** Une transaction sur la base, pour les écritures déléguées ci-dessous (cf. `VectorStore.transaction`). */
  transaction<T>(fn: () => T): T {
    return this.vectorStore.transaction(fn);
  }

  /**
   * Delegate methods to base VectorStore for compatibility
   */
  saveDocument(document: any): void {
    return this.vectorStore.saveDocument(document);
  }

  getDocument(documentId: string): any {
    return this.vectorStore.getDocument(documentId);
  }

  getDocumentById(documentId: string): any {
    return this.vectorStore.getDocumentById(documentId);
  }

  getAllDocuments(): any[] {
    return this.vectorStore.getAllDocuments();
  }

  deleteDocument(documentId: string): void {
    this.vectorStore.deleteDocument(documentId);
    this.markStale('documents-removed');
  }

  getDocumentIdsByFilePath(filePath: string): string[] {
    return this.vectorStore.getDocumentIdsByFilePath(filePath);
  }

  getMovedCopyIds(bibtexKey: string, filePath: string): string[] {
    return this.vectorStore.getMovedCopyIds(bibtexKey, filePath);
  }

  mergeDocumentsInto(keepId: string, replacedIds: string[]): void {
    this.vectorStore.mergeDocumentsInto(keepId, replacedIds);
    if (replacedIds.some((id) => id !== keepId)) this.markStale('documents-removed');
  }

  removeDuplicateDocuments(): { files: number; removed: number } {
    const result = this.vectorStore.removeDuplicateDocuments();
    if (result.removed > 0) this.markStale('documents-removed');
    return result;
  }

  countDuplicateDocuments(): number {
    return this.vectorStore.countDuplicateDocuments();
  }

  backupTo(destination: string): Promise<unknown> {
    return this.vectorStore.backupTo(destination);
  }

  saveCitation(citation: any): void {
    this.vectorStore.saveCitation(citation);
  }

  getCitationsForDocument(documentId: string): any[] {
    return this.vectorStore.getCitationsForDocument(documentId);
  }

  getSimilarDocuments(documentId: string, threshold?: number, limit?: number): any[] {
    return this.vectorStore.getSimilarDocuments(documentId, threshold, limit);
  }

  getTotalCitationsCount(): number {
    return this.vectorStore.getTotalCitationsCount();
  }

  getMatchedCitationsCount(): number {
    return this.vectorStore.getMatchedCitationsCount();
  }

  getDocumentsCitedBy(documentId: string): string[] {
    return this.vectorStore.getDocumentsCitedBy(documentId);
  }

  getDocumentsCiting(documentId: string): string[] {
    return this.vectorStore.getDocumentsCiting(documentId);
  }

  deleteCitationsForDocument(documentId: string): void {
    this.vectorStore.deleteCitationsForDocument(documentId);
  }

  saveSimilarity(docId1: string, docId2: string, similarity: number): void {
    this.vectorStore.saveSimilarity(docId1, docId2, similarity);
  }

  deleteSimilaritiesForDocument(documentId: string): void {
    this.vectorStore.deleteSimilaritiesForDocument(documentId);
  }

  computeAndSaveSimilarities(documentId: string, threshold?: number): number {
    return this.vectorStore.computeAndSaveSimilarities(documentId, threshold);
  }

  getChunksForDocument(documentId: string): any[] {
    return this.vectorStore.getChunksForDocument(documentId);
  }

  deleteAllTopicAnalyses(): void {
    this.vectorStore.deleteAllTopicAnalyses();
  }

  loadLatestTopicAnalysis(): any {
    return this.vectorStore.loadLatestTopicAnalysis();
  }

  getTopicTimeline(): any {
    return this.vectorStore.getTopicTimeline();
  }

  saveTopicAnalysis(result: any, options: any): string {
    return this.vectorStore.saveTopicAnalysis(result, options);
  }

  getStatistics(): any {
    return this.vectorStore.getStatistics();
  }

  cleanOrphanedChunks(): void {
    this.vectorStore.cleanOrphanedChunks();
  }

  verifyIntegrity(): any {
    return this.vectorStore.verifyIntegrity();
  }

  purgeAllData(): void {
    // Purge HNSW index (reinitialize with empty index)
    this.hnswStore.clear();
    console.log('✅ HNSW index purged');

    // Purge BM25 index (reinitialize)
    this.bm25Index = new BM25Index();
    this.hybridSearch.setBM25Index(this.bm25Index);
    console.log('✅ BM25 index purged');

    // Purge base vector store (SQLite)
    this.vectorStore.purgeAllData();
    console.log('✅ Vector store purged');

    // L'index et la base sont vides tous les deux : rien n'est périmé, et la reconstruction que
    // proposait la réouverture (J8) n'a plus d'objet. `VectorStore.purgeAllData` a effacé la marque.
    this.indexesStale = false;
    this.proposeRebuild = false;
  }

  getAllChunksWithEmbeddings(): any[] {
    return this.vectorStore.getAllChunksWithEmbeddings();
  }

  /**
   * Save chunk to base store only (for backward compatibility)
   */
  saveChunk(chunk: any, embedding: Float32Array): void {
    this.vectorStore.saveChunk(chunk, embedding);
  }

  /**
   * Close database connection
   *
   * Une reconstruction ne peut pas être en cours ici : aucune de ses étapes ne rend la
   * main au fil principal, et une demande de fermeture attend donc qu'elle se termine.
   * Seule une reconstruction encore à venir (préchauffage, minuteur) est à arrêter.
   */
  close(): void {
    this.closed = true;
    this.vectorStore.close();
  }

  // ============================================
  // Zotero Collections Methods (delegated)
  // ============================================

  /**
   * Save Zotero collections to database
   */
  saveCollections(collections: Array<{ key: string; name: string; parentKey?: string }>): void {
    this.vectorStore.saveCollections(collections);
  }

  /** Fait de `collections` l'ensemble exact des collections connues. */
  replaceCollections(collections: Array<{ key: string; name: string; parentKey?: string }>): void {
    this.vectorStore.replaceCollections(collections);
  }

  /** Appartenance des références à leurs collections, lue à la synchronisation. */
  replaceCollectionMemberships(bibtexKeyToCollections: Record<string, string[]>): void {
    this.vectorStore.replaceCollectionMemberships(bibtexKeyToCollections);
  }

  /** Rattache un document aux collections de sa référence. */
  linkDocumentFromMemberships(documentId: string, bibtexKey: string | undefined): number {
    return this.vectorStore.linkDocumentFromMemberships(documentId, bibtexKey);
  }

  /**
   * Get all Zotero collections
   */
  getAllCollections(): Array<{ key: string; name: string; parentKey?: string }> {
    return this.vectorStore.getAllCollections();
  }

  /**
   * Set collections for a document
   */
  setDocumentCollections(documentId: string, collectionKeys: string[]): void {
    this.vectorStore.setDocumentCollections(documentId, collectionKeys);
  }

  /**
   * Get document IDs that belong to specified collections
   */
  getDocumentIdsInCollections(collectionKeys: string[], recursive: boolean = true): string[] {
    return this.vectorStore.getDocumentIdsInCollections(collectionKeys, recursive);
  }

  /**
   * Delete all collections (used when re-syncing)
   */
  deleteAllCollections(): void {
    this.vectorStore.deleteAllCollections();
  }

  /**
   * Link documents to their Zotero collections using bibtexKey
   * @param bibtexKeyToCollections Map of bibtexKey -> array of collection keys
   * @returns Number of documents successfully linked
   */
  linkDocumentsToCollectionsByBibtexKey(bibtexKeyToCollections: Record<string, string[]>): number {
    return this.vectorStore.linkDocumentsToCollectionsByBibtexKey(bibtexKeyToCollections);
  }
}

export interface EnhancedStats {
  vector: {
    documentCount: number;
    chunkCount: number;
    embeddingCount: number;
    databasePath: string;
  };
  hnsw: {
    dimension: number;
    currentSize: number;
    maxElements: number;
    M: number;
    efConstruction: number;
    efSearch: number;
  };
  bm25: {
    totalChunks: number;
    vocabularySize: number;
    averageDocLength: number;
  };
  hybrid: {
    K: number;
    denseWeight: number;
    sparseWeight: number;
  };
  mode: {
    useHNSW: boolean;
    useHybrid: boolean;
  };
}
