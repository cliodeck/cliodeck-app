import { VectorStore } from '../vector-store/VectorStore.js';
import { EnhancedVectorStore } from '../vector-store/EnhancedVectorStore.js';
import { OllamaClient } from '../llm/OllamaClient.js';
import { type SummarizerConfig } from '../analysis/DocumentSummarizer.js';
import type { PDFDocument } from '../../types/pdf-document.js';
import type { RAGConfig } from '../../types/config.js';
/**
 * Extended indexing options including all RAG optimization features
 */
export interface IndexingOptions {
    chunkingPreset?: 'cpuOptimized' | 'standard' | 'large';
    customChunkingEnabled?: boolean;
    customMaxChunkSize?: number;
    customMinChunkSize?: number;
    customOverlapSize?: number;
    useAdaptiveChunking?: boolean;
    enableQualityFiltering?: boolean;
    minChunkEntropy?: number;
    minUniqueWordRatio?: number;
    enablePreprocessing?: boolean;
    enableOCRCleanup?: boolean;
    enableHeaderFooterRemoval?: boolean;
    enableDeduplication?: boolean;
    enableSimilarityDedup?: boolean;
    dedupSimilarityThreshold?: number;
    useSemanticChunking?: boolean;
    semanticSimilarityThreshold?: number;
    semanticWindowSize?: number;
    summarizerConfig?: SummarizerConfig;
}
export interface IndexingProgress {
    stage: 'extracting' | 'analyzing' | 'citations' | 'summarizing' | 'chunking' | 'embedding' | 'similarities' | 'completed' | 'error';
    progress: number;
    message: string;
    currentPage?: number;
    totalPages?: number;
    currentChunk?: number;
    totalChunks?: number;
}
export declare class PDFIndexer {
    private pdfExtractor;
    private textPreprocessor;
    private chunker;
    private semanticChunker;
    private qualityScorer;
    private deduplicator;
    private embeddingCache;
    private vectorStore;
    private ollamaClient;
    private citationExtractor;
    private documentSummarizer;
    private summarizerConfig;
    private options;
    constructor(vectorStore: VectorStore | EnhancedVectorStore, ollamaClient: OllamaClient, chunkingConfig?: 'cpuOptimized' | 'standard' | 'large', summarizerConfig?: SummarizerConfig, useAdaptiveChunking?: boolean, ragConfig?: Partial<RAGConfig>);
    /**
     * Indexe un PDF complet
     * @param filePath Chemin vers le fichier PDF
     * @param bibtexKey Clé BibTeX optionnelle pour lier à la bibliographie
     * @param onProgress Callback pour la progression
     * @param bibliographyMetadata Métadonnées optionnelles provenant de la bibliographie (prioritaires sur l'extraction PDF)
     */
    indexPDF(filePath: string, bibtexKey?: string, onProgress?: (progress: IndexingProgress) => void, bibliographyMetadata?: {
        title?: string;
        author?: string;
        year?: string;
    }): Promise<PDFDocument>;
    /**
     * Indexe plusieurs PDFs en batch
     */
    indexMultiplePDFs(filePaths: string[], onProgress?: (fileIndex: number, progress: IndexingProgress) => void): Promise<PDFDocument[]>;
    /**
     * Ré-indexe un document existant
     */
    reindexPDF(documentId: string): Promise<void>;
    /**
     * Vérifie si Ollama est disponible
     */
    checkOllamaAvailability(): Promise<boolean>;
    /**
     * Liste les modèles disponibles
     */
    listAvailableModels(): Promise<import("../llm/OllamaClient.js").LLMModel[]>;
    /**
     * Obtient les statistiques de la base vectorielle
     */
    getStatistics(): any;
    /**
     * Nettoie les chunks orphelins
     */
    cleanOrphanedChunks(): void;
    /**
     * Vérifie l'intégrité de la base
     */
    verifyIntegrity(): any;
}
