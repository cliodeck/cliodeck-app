import { VectorStore } from '../../../backend/core/vector-store/VectorStore.js';
import { EnhancedVectorStore } from '../../../backend/core/vector-store/EnhancedVectorStore.js';
import { OllamaClient } from '../../../backend/core/llm/OllamaClient.js';
import { LLMProviderManager } from '../../../backend/core/llm/LLMProviderManager.js';
export type SourceType = 'secondary' | 'primary' | 'both';
declare class PDFService {
    private pdfIndexer;
    private vectorStore;
    private ollamaClient;
    private llmProviderManager;
    private currentProjectPath;
    private queryEmbeddingCache;
    /**
     * Initialise le PDF Service pour un projet spécifique
     * @param projectPath Chemin absolu vers le dossier du projet
     * @param onRebuildProgress Callback optionnel pour la progression du rebuild
     * @throws Error si projectPath n'est pas fourni
     */
    init(projectPath: string, onRebuildProgress?: (progress: {
        current: number;
        total: number;
        status: string;
        percentage: number;
    }) => void): Promise<void>;
    /**
     * Warmup embedding model to reduce first-query latency
     */
    private warmupEmbeddingModel;
    /**
     * Get query embedding with caching
     * Returns cached embedding if available, otherwise generates and caches
     */
    private getQueryEmbedding;
    /**
     * Vérifie si le service est initialisé
     */
    private ensureInitialized;
    extractPDFMetadata(filePath: string): Promise<{
        title: any;
        author: any;
        pageCount: any;
    } | {
        title: string;
        pageCount: number;
        author?: undefined;
    }>;
    indexPDF(filePath: string, bibtexKey?: string, onProgress?: any, bibliographyMetadata?: {
        title?: string;
        author?: string;
        year?: string;
    }, collectionKeys?: string[]): Promise<import("../../../backend/types/pdf-document.js").PDFDocument>;
    search(query: string, options?: {
        topK?: number;
        threshold?: number;
        documentIds?: string[];
        collectionKeys?: string[];
        sourceType?: SourceType;
    }): Promise<any[]>;
    /**
     * Search in secondary sources (bibliography/PDFs)
     * This is the original search logic, refactored into a separate method
     */
    private searchSecondary;
    getAllDocuments(): Promise<any[]>;
    /**
     * Get a specific document by its ID
     */
    getDocument(documentId: string): Promise<any>;
    deleteDocument(documentId: string): Promise<void>;
    getStatistics(): Promise<any>;
    /**
     * Retourne le chemin du projet actuel
     */
    getCurrentProjectPath(): string | null;
    getOllamaClient(): OllamaClient;
    /**
     * Retourne le LLM Provider Manager pour la génération de texte
     * Gère automatiquement le fallback entre Ollama et le modèle embarqué
     */
    getLLMProviderManager(): LLMProviderManager;
    /**
     * Met à jour le modèle embarqué dans le LLMProviderManager
     * Appelé après le téléchargement d'un nouveau modèle
     */
    updateEmbeddedModel(modelPath: string, modelId?: string): Promise<boolean>;
    /**
     * Désactive le modèle embarqué dans le LLMProviderManager
     * Appelé après la suppression d'un modèle
     */
    disableEmbeddedModel(): Promise<void>;
    getVectorStore(): VectorStore | EnhancedVectorStore;
    /**
     * Lit le contexte du projet depuis context.md
     */
    getProjectContext(): string | null;
    /**
     * Construit et retourne le graphe de connaissances
     */
    buildKnowledgeGraph(options?: any): Promise<{
        nodes: import("../../../backend/core/analysis/KnowledgeGraphBuilder.js").GraphNode[];
        edges: import("../../../backend/core/analysis/KnowledgeGraphBuilder.js").GraphEdge[];
    }>;
    /**
     * Retourne les statistiques du corpus
     */
    getCorpusStatistics(): Promise<{
        documentCount: any;
        chunkCount: any;
        citationCount: number;
        totalCitationsExtracted: number;
        languageCount: number;
        languages: string[];
        yearRange: {
            min: number;
            max: number;
        };
        authorCount: number;
    }>;
    /**
     * Analyse textométrique du corpus
     */
    getTextStatistics(options?: {
        topN?: number;
    }): Promise<{
        wordFrequencyDistribution: Record<number, number>;
        totalDocuments: number;
        averageWordsPerDocument: number;
        averageVocabularyPerDocument: number;
        totalWords: number;
        uniqueWords: number;
        totalWordsWithStopwords: number;
        vocabularySize: number;
        lexicalRichness: number;
        topWords: Array<{
            word: string;
            count: number;
            frequency: number;
        }>;
        topBigrams: Array<{
            ngram: string;
            count: number;
        }>;
        topTrigrams: Array<{
            ngram: string;
            count: number;
        }>;
    }>;
    /**
     * Analyse les topics du corpus avec BERTopic
     */
    analyzeTopics(options?: any): Promise<import("../../../backend/core/analysis/TopicModelingService.js").TopicAnalysisResult>;
    /**
     * Charge la dernière analyse de topics sauvegardée
     */
    loadTopicAnalysis(): any;
    /**
     * Récupère les données temporelles des topics (pour stream graph)
     */
    getTopicTimeline(): any;
    /**
     * Purge toutes les données de la base vectorielle
     */
    purgeAllData(): void;
    /**
     * Nettoie les chunks orphelins (sans document parent)
     */
    cleanOrphanedChunks(): void;
    /**
     * Ferme le PDF Service et libère les ressources
     */
    close(): Promise<void>;
}
export declare const pdfService: PDFService;
export {};
