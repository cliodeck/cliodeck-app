/**
 * TextometricsService - Analyse statistique du texte et textométrie
 *
 * Fournit des statistiques lexicales détaillées :
 * - Comptages de base (mots, vocabulaire, phrases)
 * - Fréquence des mots (hors stopwords)
 * - N-grammes fréquents (bigrammes, trigrammes)
 * - Richesse lexicale
 */
export interface TextStatistics {
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
    wordFrequencyDistribution: Map<number, number>;
}
export interface CorpusTextStatistics extends TextStatistics {
    totalDocuments: number;
    averageWordsPerDocument: number;
    averageVocabularyPerDocument: number;
}
export interface DocumentTextStatistics extends TextStatistics {
    documentId: string;
    characteristicWords: Array<{
        word: string;
        tfIdf: number;
    }>;
}
/**
 * Service d'analyse textométrique
 */
export declare class TextometricsService {
    private readonly stopwords;
    constructor();
    /**
     * Tokenize le texte en mots
     * @param text Texte brut
     * @returns Liste de mots (lowercase, nettoyés)
     */
    private tokenize;
    /**
     * Vérifie si un mot est un fragment d'URL ou de DOI
     */
    private isUrlOrDoiFragment;
    /**
     * Tokenize en gardant les stopwords (pour calcul du total avec stopwords)
     */
    private tokenizeWithStopwords;
    /**
     * Calcule la fréquence des mots
     */
    private calculateWordFrequency;
    /**
     * Extrait les n-grammes depuis une liste de mots
     * @param words Liste de mots
     * @param n Taille du n-gramme (2 = bigramme, 3 = trigramme)
     * @returns Fréquence des n-grammes
     */
    private extractNgrams;
    /**
     * Calcule la distribution de fréquence (combien de mots apparaissent 1 fois, 2 fois, etc.)
     */
    private calculateFrequencyDistribution;
    /**
     * Analyse un texte unique
     * @param text Texte à analyser
     * @param topN Nombre de mots/n-grammes les plus fréquents à retourner
     * @returns Statistiques textuelles
     */
    analyzeText(text: string, topN?: number): TextStatistics;
    /**
     * Analyse un corpus complet (plusieurs documents)
     * @param documents Liste de documents avec leur texte
     * @param topN Nombre de mots/n-grammes les plus fréquents à retourner
     * @returns Statistiques du corpus
     */
    analyzeCorpus(documents: Array<{
        id: string;
        text: string;
    }>, topN?: number): CorpusTextStatistics;
    /**
     * Analyse un document spécifique avec calcul de TF-IDF pour les mots caractéristiques
     * @param documentText Texte du document
     * @param corpusDocuments Tous les documents du corpus (pour TF-IDF)
     * @param topN Nombre de mots/n-grammes les plus fréquents
     * @returns Statistiques du document avec mots caractéristiques
     */
    analyzeDocument(documentId: string, documentText: string, corpusDocuments: Array<{
        id: string;
        text: string;
    }>, topN?: number): DocumentTextStatistics;
    /**
     * Calcule le TF-IDF pour trouver les mots caractéristiques d'un document
     * @param documentText Texte du document cible
     * @param corpusDocuments Tous les documents du corpus
     * @param topN Nombre de mots caractéristiques à retourner
     * @returns Liste des mots avec leur score TF-IDF
     */
    private calculateTfIdf;
    /**
     * Ajoute des stopwords personnalisés
     */
    addStopwords(words: string[]): void;
    /**
     * Supprime des stopwords
     */
    removeStopwords(words: string[]): void;
    /**
     * Retourne la liste des stopwords actuels
     */
    getStopwords(): string[];
}
