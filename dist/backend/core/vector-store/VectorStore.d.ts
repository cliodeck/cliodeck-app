import type { PDFDocument, DocumentChunk, ChunkWithEmbedding, SearchResult, VectorStoreStatistics } from '../../types/pdf-document';
import type { TopicAnalysisResult, TopicAnalysisOptions } from '../analysis/TopicModelingService';
export declare class VectorStore {
    private db;
    private dbPath;
    readonly projectPath: string;
    /**
     * Crée un VectorStore pour un projet spécifique
     * @param projectPath Chemin absolu vers le dossier du projet
     * @throws Error si projectPath n'est pas fourni
     */
    constructor(projectPath: string);
    private enableForeignKeys;
    private createTables;
    private migrateDatabase;
    saveDocument(document: PDFDocument): void;
    getDocument(id: string): PDFDocument | null;
    getAllDocuments(): PDFDocument[];
    deleteDocument(id: string): void;
    saveChunk(chunk: DocumentChunk, embedding: Float32Array, contentHash?: string): void;
    /**
     * Find chunks with the same content hash (for deduplication)
     */
    findChunksByHash(contentHash: string, excludeDocId?: string): string[];
    getChunksForDocument(documentId: string): ChunkWithEmbedding[];
    getAllChunksWithEmbeddings(): ChunkWithEmbedding[];
    /**
     * Get the dimension of embeddings stored in the database
     * @returns The embedding dimension, or null if no embeddings exist
     */
    getEmbeddingDimension(): number | null;
    search(queryEmbedding: Float32Array, limit?: number, documentIds?: string[]): SearchResult[];
    private cosineSimilarity;
    private parseDocument;
    private parseChunkWithEmbedding;
    getStatistics(): VectorStoreStatistics;
    purgeAllData(): void;
    verifyIntegrity(): {
        orphanedChunks: number;
        totalChunks: number;
    };
    cleanOrphanedChunks(): void;
    saveCitation(citation: {
        id: string;
        sourceDocId: string;
        targetCitation: string;
        targetDocId?: string;
        context?: string;
        pageNumber?: number;
    }): void;
    getCitationsForDocument(documentId: string): Array<{
        id: string;
        sourceDocId: string;
        targetCitation: string;
        targetDocId?: string;
        context?: string;
        pageNumber?: number;
    }>;
    /**
     * Compte le nombre de citations matchées (citations internes)
     */
    getMatchedCitationsCount(): number;
    /**
     * Compte le nombre total de citations (y compris non matchées)
     */
    getTotalCitationsCount(): number;
    getDocumentsCitedBy(documentId: string): string[];
    getDocumentsCiting(documentId: string): string[];
    deleteCitationsForDocument(documentId: string): void;
    saveSimilarity(docId1: string, docId2: string, similarity: number): void;
    getSimilarDocuments(documentId: string, threshold?: number, limit?: number): Array<{
        documentId: string;
        similarity: number;
    }>;
    deleteSimilaritiesForDocument(documentId: string): void;
    /**
     * Calcule et sauvegarde les similarités entre un document et tous les autres documents existants
     * @param documentId ID du document pour lequel calculer les similarités
     * @param threshold Seuil minimum de similarité pour sauvegarder (par défaut 0.5)
     * @returns Nombre de similarités sauvegardées
     */
    computeAndSaveSimilarities(documentId: string, threshold?: number): number;
    /**
     * Sauvegarde une analyse de topics dans la base de données
     * @param result Résultat de l'analyse BERTopic
     * @param options Options utilisées pour l'analyse
     * @returns ID de l'analyse sauvegardée
     */
    saveTopicAnalysis(result: TopicAnalysisResult, options?: TopicAnalysisOptions): string;
    /**
     * Charge la dernière analyse de topics sauvegardée
     * @returns Résultat de l'analyse ou null si aucune analyse n'existe
     */
    loadLatestTopicAnalysis(): (TopicAnalysisResult & {
        analysisDate: string;
        options: TopicAnalysisOptions;
    }) | null;
    /**
     * Récupère les données temporelles des topics (pour stream graph)
     * Retourne le nombre de documents par topic par année
     */
    getTopicTimeline(): Array<{
        year: number;
        [topicId: string]: number;
    }> | null;
    /**
     * Supprime toutes les analyses de topics
     */
    deleteAllTopicAnalyses(): void;
    /**
     * Sauvegarde plusieurs collections Zotero en batch
     */
    saveCollections(collections: Array<{
        key: string;
        name: string;
        parentKey?: string;
    }>): void;
    /**
     * Récupère toutes les collections Zotero
     */
    getAllCollections(): Array<{
        key: string;
        name: string;
        parentKey?: string;
    }>;
    /**
     * Lie un document à ses collections Zotero
     */
    setDocumentCollections(documentId: string, collectionKeys: string[]): void;
    /**
     * Récupère les clés de collections pour un document
     */
    getDocumentCollections(documentId: string): string[];
    /**
     * Récupère tous les IDs de documents appartenant aux collections spécifiées
     * @param collectionKeys Clés des collections à filtrer
     * @param recursive Si true, inclut aussi les sous-collections
     */
    getDocumentIdsInCollections(collectionKeys: string[], recursive?: boolean): string[];
    /**
     * Supprime toutes les collections (utile lors d'une re-synchronisation)
     */
    deleteAllCollections(): void;
    /**
     * Lie des documents à leurs collections Zotero en utilisant le bibtexKey
     * @param bibtexKeyToCollections Map de bibtexKey -> array de collection keys
     * @returns Nombre de documents liés avec succès
     */
    linkDocumentsToCollectionsByBibtexKey(bibtexKeyToCollections: Record<string, string[]>): number;
    close(): void;
}
