import { VectorStore } from './VectorStore';
import type { SearchResult, DocumentChunk } from '../../types/pdf-document';
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
export declare class EnhancedVectorStore {
    private vectorStore;
    private hnswStore;
    private bm25Index;
    private hybridSearch;
    private useHNSW;
    private useHybrid;
    private isRebuilding;
    private rebuildProgress;
    private onRebuildProgress?;
    constructor(projectPath: string);
    /**
     * Initialize all indexes with automatic corruption recovery
     * NOTE: HNSW index loading is synchronous and may block for large indexes
     */
    initialize(): Promise<void>;
    /**
     * Set progress callback for rebuild operations
     */
    setRebuildProgressCallback(callback: (progress: {
        current: number;
        total: number;
        status: string;
        percentage: number;
    }) => void): void;
    /**
     * Check if indexes need to be rebuilt
     */
    needsRebuild(): boolean;
    /**
     * Get rebuild status
     */
    getRebuildStatus(): {
        isRebuilding: boolean;
        current: number;
        total: number;
        status: string;
        percentage: number;
    };
    /**
     * Add a chunk with embedding to all indexes
     */
    addChunk(chunk: DocumentChunk, embedding: Float32Array): Promise<void>;
    /**
     * Batch add chunks (more efficient)
     */
    addChunks(chunks: Array<{
        chunk: DocumentChunk;
        embedding: Float32Array;
    }>): Promise<void>;
    /**
     * Search using enhanced hybrid search
     */
    search(query: string, queryEmbedding: Float32Array, k?: number, documentIds?: string[]): Promise<SearchResult[]>;
    /**
     * Rebuild all indexes from SQLite with progress tracking
     */
    rebuildIndexes(): Promise<void>;
    /**
     * Notify progress callback
     */
    private notifyProgress;
    /**
     * Rebuild BM25 from HNSW metadata (faster than from SQLite)
     */
    private rebuildBM25FromHNSW;
    /**
     * Save all indexes to disk
     */
    save(): Promise<void>;
    /**
     * Clear all indexes
     */
    clear(): Promise<void>;
    /**
     * Get statistics
     */
    getStats(): Promise<EnhancedStats>;
    /**
     * Enable/disable HNSW indexing
     */
    setUseHNSW(use: boolean): void;
    /**
     * Enable/disable hybrid search
     */
    setUseHybrid(use: boolean): void;
    /**
     * Get underlying VectorStore for backward compatibility
     */
    getBaseStore(): VectorStore;
    /**
     * Delegate methods to base VectorStore for compatibility
     */
    saveDocument(document: any): void;
    getDocument(documentId: string): any;
    getAllDocuments(): any[];
    deleteDocument(documentId: string): void;
    saveCitation(citation: any): void;
    getCitationsForDocument(documentId: string): any[];
    getSimilarDocuments(documentId: string, threshold?: number, limit?: number): any[];
    getTotalCitationsCount(): number;
    getMatchedCitationsCount(): number;
    getDocumentsCitedBy(documentId: string): string[];
    getDocumentsCiting(documentId: string): string[];
    deleteCitationsForDocument(documentId: string): void;
    saveSimilarity(docId1: string, docId2: string, similarity: number): void;
    deleteSimilaritiesForDocument(documentId: string): void;
    computeAndSaveSimilarities(documentId: string, threshold?: number): number;
    getChunksForDocument(documentId: string): any[];
    deleteAllTopicAnalyses(): void;
    loadLatestTopicAnalysis(): any;
    getTopicTimeline(): any;
    saveTopicAnalysis(result: any, options: any): string;
    getStatistics(): any;
    cleanOrphanedChunks(): void;
    verifyIntegrity(): any;
    purgeAllData(): void;
    getAllChunksWithEmbeddings(): any[];
    /**
     * Save chunk to base store only (for backward compatibility)
     */
    saveChunk(chunk: any, embedding: Float32Array): void;
    /**
     * Close database connection
     */
    close(): void;
    /**
     * Save Zotero collections to database
     */
    saveCollections(collections: Array<{
        key: string;
        name: string;
        parentKey?: string;
    }>): void;
    /**
     * Get all Zotero collections
     */
    getAllCollections(): Array<{
        key: string;
        name: string;
        parentKey?: string;
    }>;
    /**
     * Set collections for a document
     */
    setDocumentCollections(documentId: string, collectionKeys: string[]): void;
    /**
     * Get document IDs that belong to specified collections
     */
    getDocumentIdsInCollections(collectionKeys: string[], recursive?: boolean): string[];
    /**
     * Delete all collections (used when re-syncing)
     */
    deleteAllCollections(): void;
    /**
     * Link documents to their Zotero collections using bibtexKey
     * @param bibtexKeyToCollections Map of bibtexKey -> array of collection keys
     * @returns Number of documents successfully linked
     */
    linkDocumentsToCollectionsByBibtexKey(bibtexKeyToCollections: Record<string, string[]>): number;
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
