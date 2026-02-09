import type { OllamaClient } from '../llm/OllamaClient';
import type { PDFMetadata } from '../../types/pdf-document';
export interface SummarizerConfig {
    enabled: boolean;
    method: 'extractive' | 'abstractive';
    maxLength: number;
    llmModel?: string;
}
/**
 * DocumentSummarizer génère des résumés de documents PDF
 * - Extractif : sélection de phrases importantes (sans dépendance externe)
 * - Abstractif : génération via LLM (Ollama)
 */
export declare class DocumentSummarizer {
    private config;
    private ollamaClient?;
    private readonly academicKeywords;
    private readonly stopWords;
    constructor(config: SummarizerConfig, ollamaClient?: OllamaClient);
    /**
     * Génère un résumé du document
     * @param fullText Texte complet du document
     * @param metadata Métadonnées du document (optionnel)
     * @returns Résumé généré
     */
    generateSummary(fullText: string, metadata?: PDFMetadata): Promise<string>;
    /**
     * Génère un embedding pour le résumé
     * @param summary Résumé à encoder
     * @returns Embedding du résumé
     */
    generateSummaryEmbedding(summary: string): Promise<Float32Array>;
    /**
     * Résumé extractif : sélection de phrases importantes
     * Algorithme simplifié basé sur :
     * - Fréquence des termes (TF-IDF simplifié)
     * - Position dans le document
     * - Présence de mots-clés académiques
     * - Longueur des phrases
     */
    private generateExtractiveSummary;
    /**
     * Découpe le texte en phrases
     */
    private splitIntoSentences;
    /**
     * Calcule la fréquence des termes dans le texte (TF)
     */
    private calculateTermFrequencies;
    /**
     * Score une phrase selon plusieurs critères
     */
    private scoreSentence;
    /**
     * Compte le nombre de mots dans une chaîne
     */
    private countWords;
    /**
     * Résumé abstractif : génération via LLM
     */
    private generateAbstractiveSummary;
    /**
     * Construit le prompt pour résumé abstractif
     */
    private buildAbstractiveSummaryPrompt;
}
