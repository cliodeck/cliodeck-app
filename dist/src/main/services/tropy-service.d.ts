import { TropySyncOptions, TropySyncResult } from '../../../backend/integrations/tropy/TropySync.js';
import { TranscriptionFormat } from '../../../backend/integrations/tropy/TropyOCRPipeline.js';
import { PrimarySourceDocument, PrimarySourceSearchResult, PrimarySourcesStatistics } from '../../../backend/core/vector-store/PrimarySourcesVectorStore.js';
import type { EntityStatistics } from '../../../backend/types/entity.js';
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
declare class TropyService {
    private vectorStore;
    private tropySync;
    private watcher;
    private ocrPipeline;
    private nerService;
    private currentTPYPath;
    private projectPath;
    private chunker;
    private qualityScorer;
    private deduplicator;
    /**
     * Initialise le service Tropy pour un projet
     */
    init(projectPath: string): Promise<void>;
    /**
     * Ferme le service et libère les ressources
     */
    close(): Promise<void>;
    /**
     * Vérifie si le service est initialisé
     */
    isInitialized(): boolean;
    /**
     * Ouvre un projet Tropy (.tpy) en lecture seule
     */
    openProject(tpyPath: string): Promise<TropyOpenResult>;
    /**
     * Retourne les informations du projet Tropy actuel
     */
    getProjectInfo(): TropyProjectInfo | null;
    /**
     * Synchronise le projet Tropy avec ClioDeck
     * Inclut la génération des embeddings pour la recherche vectorielle
     */
    sync(options: TropySyncOptions): Promise<TropySyncResult>;
    /**
     * Génère les embeddings pour toutes les sources qui n'en ont pas encore
     */
    private generateEmbeddingsForSources;
    /**
     * Découpe un texte en chunks pour l'indexation
     * Utilise DocumentChunker pour un chunking optimisé avec:
     * - Respect des limites de phrases
     * - Overlap configurable
     * - Contexte document ajouté aux chunks
     */
    private chunkText;
    /**
     * Retourne les chunks bruts du DocumentChunker (pour optimisation)
     * Ces chunks ont le format DocumentChunk avec documentId et pageNumber
     * Compatible avec ChunkQualityScorer et ChunkDeduplicator
     */
    private getRawChunks;
    /**
     * Vérifie si une synchronisation est nécessaire
     */
    checkSyncNeeded(): boolean;
    /**
     * Démarre la surveillance du fichier .tpy
     */
    startWatching(tpyPath?: string): {
        success: boolean;
        error?: string;
    };
    /**
     * Arrête la surveillance
     */
    stopWatching(): void;
    /**
     * Vérifie si le watcher est actif
     */
    isWatching(): boolean;
    /**
     * Effectue l'OCR sur une image
     */
    performOCR(imagePath: string, language: string): Promise<{
        success: boolean;
        text?: string;
        confidence?: number;
        error?: string;
    }>;
    /**
     * Effectue l'OCR sur plusieurs images
     */
    performBatchOCR(imagePaths: string[], language: string): Promise<{
        success: boolean;
        text?: string;
        confidence?: number;
        error?: string;
    }>;
    /**
     * Retourne les langues OCR supportées
     */
    getSupportedOCRLanguages(): Array<{
        code: string;
        name: string;
    }>;
    /**
     * Importe une transcription externe
     */
    importTranscription(filePath: string, type?: TranscriptionFormat): Promise<{
        success: boolean;
        text?: string;
        format?: TranscriptionFormat;
        error?: string;
    }>;
    /**
     * Recherche dans les sources primaires
     * Accepte une query text et des options, génère l'embedding via OllamaClient
     * Utilise la recherche hybride (HNSW + BM25) pour de meilleurs résultats
     */
    search(query: string, options?: {
        topK?: number;
        threshold?: number;
    }): Promise<Array<PrimarySourceSearchResult & {
        source?: any;
    }>>;
    /**
     * Expand query with multilingual terms (FR/EN)
     * This helps find relevant results across languages
     */
    private expandQueryMultilingual;
    /**
     * Search with entity boosting (Graph RAG)
     * Uses NER to extract entities from query and boost matching results
     */
    searchWithEntities(query: string, options?: {
        topK?: number;
        threshold?: number;
        useEntities?: boolean;
    }): Promise<PrimarySourceSearchResult[]>;
    /**
     * Recherche avec un embedding pré-calculé
     */
    searchWithEmbedding(queryEmbedding: Float32Array, topK?: number): PrimarySourceSearchResult[];
    /**
     * Récupère toutes les sources primaires
     */
    getAllSources(): PrimarySourceDocument[];
    /**
     * Récupère une source par son ID
     */
    getSource(id: string): PrimarySourceDocument | null;
    /**
     * Retourne les statistiques des sources primaires
     */
    getStatistics(): PrimarySourcesStatistics | null;
    /**
     * Retourne tous les tags
     */
    getAllTags(): string[];
    /**
     * Retourne les statistiques des entités (Graph RAG)
     */
    getEntityStatistics(): EntityStatistics | null;
    /**
     * Met à jour la transcription d'une source
     */
    updateSourceTranscription(sourceId: string, transcription: string, source: 'tesseract' | 'transkribus' | 'manual'): Promise<{
        success: boolean;
        error?: string;
    }>;
    /**
     * Supprime les chunks existants et réindexe une source
     */
    reindexSource(sourceId: string): Promise<{
        success: boolean;
        error?: string;
    }>;
    /**
     * Purge la base de données des sources primaires
     * Supprime toutes les sources, chunks, photos et tags
     */
    purge(): Promise<{
        success: boolean;
        error?: string;
    }>;
    /**
     * Retourne le chemin de la base de données
     */
    getDatabasePath(): string | null;
}
export declare const tropyService: TropyService;
export {};
