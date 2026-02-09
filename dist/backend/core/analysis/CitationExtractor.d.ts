import type { Citation, PDFDocument } from '../../types/pdf-document';
/**
 * CitationExtractor - Détecte et extrait les citations depuis le texte d'un document
 *
 * Fonctionnalités :
 * - Détection de patterns de citations (ex: "Papert, 1980", "(Papert 1980)", "Papert et al. (1980)")
 * - Extraction de bibliographies en fin de document
 * - Matching avec documents existants dans la base
 * - Support multilingue (français, anglais)
 */
export declare class CitationExtractor {
    /**
     * Patterns regex pour détecter les citations
     * Formats supportés :
     * - (Auteur, YYYY)
     * - (Auteur YYYY)
     * - Auteur (YYYY)
     * - Auteur, YYYY
     * - Auteur et al. (YYYY)
     * - Auteur et collaborateurs (YYYY)
     */
    private readonly citationPatterns;
    /**
     * Mots-clés pour détecter les sections de bibliographie
     */
    private readonly bibliographyKeywords;
    /**
     * Extrait toutes les citations d'un texte complet
     * @param fullText Texte complet du document
     * @param pages Tableau des pages avec leur texte (optionnel, pour contexte)
     * @returns Liste des citations détectées
     */
    extractCitations(fullText: string, pages?: Array<{
        pageNumber: number;
        text: string;
    }>): Citation[];
    /**
     * Extrait les citations directement depuis le corps du texte
     */
    private extractInTextCitations;
    /**
     * Extrait les citations depuis la section bibliographie
     */
    private extractBibliographyCitations;
    /**
     * Trouve la section bibliographie dans le texte
     */
    private findBibliographySection;
    /**
     * Parse les entrées individuelles de la bibliographie
     */
    private parseBibliographyEntries;
    /**
     * Extrait le nom de l'auteur depuis une entrée de bibliographie
     */
    private extractAuthorFromBibliography;
    /**
     * Extrait le contexte (paragraphe) autour d'une citation
     */
    private extractContext;
    /**
     * Trouve le numéro de page pour une position donnée dans le texte
     */
    private findPageNumber;
    /**
     * Fait correspondre les citations extraites avec les documents existants
     * @param citations Citations extraites
     * @param documents Documents existants dans la base
     * @returns Map de citation ID -> document ID correspondant
     */
    matchCitationsWithDocuments(citations: Citation[], documents: PDFDocument[]): Map<string, string>;
    /**
     * Trouve le document correspondant à une citation
     */
    private findMatchingDocument;
    /**
     * Nettoie un nom d'auteur extrait
     */
    private cleanAuthorName;
    /**
     * Normalise un nom d'auteur pour comparaison
     */
    private normalizeAuthorName;
    /**
     * Vérifie si deux noms d'auteurs sont similaires
     * Utilise la distance de Levenshtein simplifiée
     */
    private authorsAreSimilar;
    /**
     * Détecte la langue d'un texte (simple heuristique)
     */
    detectLanguage(text: string): string;
    /**
     * Vérifie si une année est valide (entre 1500 et 2100)
     */
    private isValidYear;
    /**
     * Retourne des statistiques sur les citations extraites
     */
    getCitationStatistics(citations: Citation[]): {
        totalCitations: number;
        uniqueAuthors: number;
        yearRange: {
            min?: string;
            max?: string;
        };
        citationsWithContext: number;
        citationsWithPage: number;
    };
}
