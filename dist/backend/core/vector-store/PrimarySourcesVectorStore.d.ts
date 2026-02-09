import type { PrimarySourceItem, PrimarySourcePhoto } from '../../integrations/tropy/TropyReader';
import type { Entity, EntityType, EntityMention, ExtractedEntity, EntityStatistics } from '../../types/entity';
export interface PrimarySourceDocument {
    id: string;
    tropyId: number;
    title: string;
    date?: string;
    creator?: string;
    archive?: string;
    collection?: string;
    type?: string;
    transcription?: string;
    transcriptionSource?: 'tesseract' | 'transkribus' | 'manual' | 'tropy-notes';
    language?: string;
    lastModified: string;
    indexedAt: string;
    metadata?: Record<string, string>;
}
export interface PrimarySourceChunk {
    id: string;
    sourceId: string;
    content: string;
    chunkIndex: number;
    startPosition: number;
    endPosition: number;
}
export interface PrimarySourceSearchResult {
    chunk: PrimarySourceChunk;
    source: PrimarySourceDocument;
    similarity: number;
    sourceType: 'primary';
}
export interface PrimarySourcesStatistics {
    sourceCount: number;
    chunkCount: number;
    photoCount: number;
    withTranscription: number;
    withoutTranscription: number;
    byArchive: Record<string, number>;
    byCollection: Record<string, number>;
    tags: string[];
}
/**
 * VectorStore dédié aux sources primaires (Tropy)
 * Base de données séparée de celle des PDFs (sources secondaires)
 */
export declare class PrimarySourcesVectorStore {
    private db;
    private dbPath;
    readonly projectPath: string;
    private hnswIndex;
    private hnswIndexPath;
    private hnswDimension;
    private hnswMaxElements;
    private hnswLabelMap;
    private hnswCurrentSize;
    private hnswInitialized;
    private bm25Index;
    private bm25ChunkMap;
    private bm25IdfCache;
    private bm25AvgDocLength;
    private bm25IsDirty;
    private readonly bm25K1;
    private readonly bm25B;
    private readonly hnswM;
    private readonly hnswEfConstruction;
    private hnswEfSearch;
    private readonly rrfK;
    private denseWeight;
    private sparseWeight;
    constructor(projectPath: string);
    /**
     * Initialize HNSW and BM25 indexes from existing data
     */
    private initializeIndexes;
    /**
     * Initialize a new empty HNSW index
     */
    private initNewHNSWIndex;
    /**
     * Load HNSW index from disk
     */
    private loadHNSWIndex;
    /**
     * Save HNSW index to disk
     */
    saveHNSWIndex(): void;
    /**
     * Rebuild BM25 index from database
     */
    private rebuildBM25Index;
    /**
     * Preprocess text for BM25 indexing
     */
    private preprocessTextForBM25;
    /**
     * Update BM25 IDF cache
     */
    private updateBM25Cache;
    private enableForeignKeys;
    private createTables;
    /**
     * Creates entity tables for Graph RAG (NER)
     */
    private createEntityTables;
    /**
     * Sauvegarde une source primaire
     */
    saveSource(source: PrimarySourceItem): string;
    /**
     * Met à jour une source existante
     */
    updateSource(id: string, updates: Partial<PrimarySourceItem>): void;
    /**
     * Récupère une source par son ID
     */
    getSource(id: string): PrimarySourceDocument | null;
    /**
     * Récupère une source par son ID Tropy
     */
    getSourceByTropyId(tropyId: number): PrimarySourceDocument | null;
    /**
     * Liste toutes les sources
     */
    getAllSources(): PrimarySourceDocument[];
    /**
     * Supprime une source
     */
    deleteSource(id: string): void;
    /**
     * Vérifie si une source existe par son ID Tropy
     */
    sourceExistsByTropyId(tropyId: number): boolean;
    private saveSourcePhotos;
    /**
     * Récupère les photos d'une source
     */
    getSourcePhotos(sourceId: string): PrimarySourcePhoto[];
    /**
     * Met à jour la transcription d'une photo
     */
    updatePhotoTranscription(photoId: number, transcription: string): void;
    private saveSourceTags;
    /**
     * Récupère les tags d'une source
     */
    getSourceTags(sourceId: string): string[];
    /**
     * Liste tous les tags uniques
     */
    getAllTags(): string[];
    /**
     * Sauvegarde un chunk avec son embedding
     */
    saveChunk(chunk: PrimarySourceChunk, embedding: Float32Array): void;
    /**
     * Add a chunk to HNSW index
     */
    private addToHNSWIndex;
    /**
     * Add a chunk to BM25 index
     */
    private addToBM25Index;
    /**
     * Sauvegarde plusieurs chunks
     */
    saveChunks(chunks: Array<{
        chunk: PrimarySourceChunk;
        embedding: Float32Array;
    }>): void;
    /**
     * Récupère tous les chunks d'une source
     */
    getChunks(sourceId: string): PrimarySourceChunk[];
    /**
     * Récupère tous les chunks avec leurs embeddings
     */
    getAllChunksWithEmbeddings(): Array<{
        chunk: PrimarySourceChunk;
        embedding: Float32Array;
    }>;
    /**
     * Supprime les chunks d'une source
     */
    deleteChunks(sourceId: string): void;
    /**
     * Hybrid search combining HNSW (dense) and BM25 (sparse) retrieval
     * Uses Reciprocal Rank Fusion for result combination
     */
    search(queryEmbedding: Float32Array, topK?: number, query?: string): PrimarySourceSearchResult[];
    /**
     * Search using HNSW index (fast approximate nearest neighbor)
     */
    private searchHNSW;
    /**
     * Search using BM25 index (keyword-based)
     */
    private searchBM25;
    /**
     * Reciprocal Rank Fusion to combine dense and sparse results
     * With exact match boosting for proper nouns and keywords
     */
    private reciprocalRankFusion;
    /**
     * Rebuild all indexes from database
     */
    rebuildAllIndexes(): void;
    private cosineSimilarity;
    /**
     * Retourne les statistiques du store
     */
    getStatistics(): PrimarySourcesStatistics;
    /**
     * Enregistre un projet Tropy lié
     */
    saveTropyProject(tpyPath: string, name: string, autoSync?: boolean): string;
    /**
     * Met à jour la date de dernière sync
     */
    updateLastSync(tpyPath: string): void;
    /**
     * Récupère le projet Tropy enregistré
     */
    getTropyProject(): {
        id: string;
        tpyPath: string;
        name: string;
        lastSync: string;
        autoSync: boolean;
    } | null;
    /**
     * Saves an entity, returns existing ID if already exists
     */
    saveEntity(entity: Omit<Entity, 'id' | 'createdAt'>): string;
    /**
     * Saves an entity mention
     */
    saveEntityMention(mention: Omit<EntityMention, 'id'>): void;
    /**
     * Updates or creates a relation between two entities
     */
    updateEntityRelation(entity1Id: string, entity2Id: string, sourceId: string): void;
    /**
     * Saves entities extracted from a source and creates relations
     */
    saveEntitiesForSource(sourceId: string, entities: ExtractedEntity[], chunkId?: string): void;
    /**
     * Gets entities by name (fuzzy search)
     */
    getEntitiesByName(name: string, type?: EntityType): Entity[];
    /**
     * Gets all chunk IDs containing a specific entity
     */
    getChunkIdsWithEntity(entityId: string): string[];
    /**
     * Gets related entities (by co-occurrence)
     */
    getRelatedEntities(entityId: string, limit?: number): Array<{
        entity: Entity;
        weight: number;
    }>;
    /**
     * Deletes all entities for a source
     */
    deleteEntitiesForSource(sourceId: string): void;
    /**
     * Gets entity statistics
     */
    getEntityStatistics(): EntityStatistics;
    /**
     * Entity type weights for search scoring
     */
    private readonly entityTypeWeights;
    /**
     * Search with entity boosting
     * Combines hybrid search with entity matching for improved relevance
     */
    searchWithEntityBoost(queryEmbedding: Float32Array, queryEntities: ExtractedEntity[], topK?: number, query?: string, hybridWeight?: number, entityWeight?: number): PrimarySourceSearchResult[];
    private rowToDocument;
    /**
     * Retourne le chemin de la base de données
     */
    getDatabasePath(): string;
    /**
     * Détecte la dimension des embeddings
     */
    getEmbeddingDimension(): number | null;
    /**
     * Ferme la connexion à la base de données
     */
    close(): void;
    /**
     * Clear HNSW index files (used when purging)
     */
    clearHNSWIndex(): void;
    /**
     * Get index statistics
     */
    getIndexStats(): {
        hnswSize: number;
        bm25Size: number;
        hnswDimension: number;
    };
}
