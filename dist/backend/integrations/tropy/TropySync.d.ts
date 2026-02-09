import { PrimarySourcesVectorStore } from '../../core/vector-store/PrimarySourcesVectorStore';
import type { OllamaClient } from '../../core/llm/OllamaClient';
export interface TropySyncOptions {
    performOCR: boolean;
    ocrLanguage: string;
    transcriptionDirectory?: string;
    forceReindex?: boolean;
    extractEntities?: boolean;
    ollamaClient?: OllamaClient;
}
export interface TropySyncResult {
    success: boolean;
    projectName: string;
    totalItems: number;
    newItems: number;
    updatedItems: number;
    skippedItems: number;
    ocrPerformed: number;
    transcriptionsImported: number;
    errors: string[];
}
export interface TropySyncProgress {
    phase: 'reading' | 'processing' | 'extracting-entities' | 'indexing' | 'done';
    current: number;
    total: number;
    currentItem?: string;
}
export type TropySyncProgressCallback = (progress: TropySyncProgress) => void;
/**
 * Synchronisation entre Tropy et ClioDeck
 * Lit les données du fichier .tpy (sans le modifier) et les indexe
 */
export declare class TropySync {
    private reader;
    private ocrPipeline;
    private nerService;
    constructor();
    /**
     * Initializes the NER service with an Ollama client
     */
    initNERService(ollamaClient: OllamaClient): void;
    /**
     * Synchronise un projet Tropy vers le VectorStore
     */
    sync(tpyPath: string, vectorStore: PrimarySourcesVectorStore, options: TropySyncOptions, onProgress?: TropySyncProgressCallback): Promise<TropySyncResult>;
    /**
     * Traite un item Tropy individuel
     */
    private processItem;
    /**
     * Cherche une transcription externe pour un item
     */
    private findExternalTranscription;
    /**
     * Effectue l'OCR sur toutes les photos d'un item
     * Note: Tropy creates one "photo" entry per page for PDFs, so we deduplicate
     * to avoid OCR'ing the same file multiple times
     */
    private performOCROnItem;
    /**
     * Convertit les photos Tropy en format PrimarySourcePhoto
     */
    private convertPhotos;
    /**
     * Extrait les métadonnées supplémentaires d'un item
     */
    private extractMetadata;
    /**
     * Extracts named entities from all sources with transcriptions
     */
    private extractEntitiesForSources;
    /**
     * Vérifie si une synchronisation est nécessaire
     * Compare la date de modification du fichier .tpy avec la dernière sync
     * Supports both .tropy packages and .tpy files
     */
    checkSyncNeeded(projectPath: string, vectorStore: PrimarySourcesVectorStore): boolean;
    /**
     * Libère les ressources
     */
    dispose(): Promise<void>;
}
export declare function createTropySync(): TropySync;
