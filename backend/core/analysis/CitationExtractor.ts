import { randomUUID } from 'crypto';
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
export class CitationExtractor {
  // MARK: - Citation Patterns

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
  private readonly citationPatterns = [
    // Format: (Auteur, YYYY) ou (Auteur YYYY)
    /\(([A-ZÀÂÄÆÇÉÈÊËÏÎÔŒÙÛÜ][a-zàâäæçéèêëïîôœùûü]+(?:\s+(?:et\s+al\.|et\s+collaborateurs|&|and)\s+[A-ZÀÂÄÆÇÉÈÊËÏÎÔŒÙÛÜ][a-zàâäæçéèêëïîôœùûü]+)*),?\s+(\d{4}[a-z]?)\)/gi,

    // Format: Auteur (YYYY) ou Auteur, YYYY
    /\b([A-ZÀÂÄÆÇÉÈÊËÏÎÔŒÙÛÜ][a-zàâäæçéèêëïîôœùûü]+(?:\s+(?:et\s+al\.|et\s+collaborateurs|&|and)\s+[A-ZÀÂÄÆÇÉÈÊËÏÎÔŒÙÛÜ][a-zàâäæçéèêëïîôœùûü]+)*)\s*[,(]\s*(\d{4}[a-z]?)\s*\)?/g,

    // Format: Auteur et Auteur (YYYY)
    /\b([A-ZÀÂÄÆÇÉÈÊËÏÎÔŒÙÛÜ][a-zàâäæçéèêëïîôœùûü]+\s+(?:et|and|&)\s+[A-ZÀÂÄÆÇÉÈÊËÏÎÔŒÙÛÜ][a-zàâäæçéèêëïîôœùûü]+)\s*\(\s*(\d{4}[a-z]?)\s*\)/g,

    // Format: Auteur et al. (YYYY) ou Auteur et collaborateurs (YYYY)
    /\b([A-ZÀÂÄÆÇÉÈÊËÏÎÔŒÙÛÜ][a-zàâäæçéèêëïîôœùûü]+)\s+(?:et\s+al\.|et\s+collaborateurs)\s*\(\s*(\d{4}[a-z]?)\s*\)/gi,
  ];

  /**
   * Mots-clés pour détecter les sections de bibliographie
   */
  private readonly bibliographyKeywords = [
    'références',
    'bibliographie',
    'references',
    'bibliography',
    'works cited',
    'literatura citada',
  ];

  // MARK: - Main Extraction Method

  /**
   * Extrait toutes les citations d'un texte complet
   * @param fullText Texte complet du document
   * @param pages Tableau des pages avec leur texte (optionnel, pour contexte)
   * @returns Liste des citations détectées
   */
  extractCitations(
    fullText: string,
    pages?: Array<{ pageNumber: number; text: string }>
  ): Citation[] {
    const citations: Citation[] = [];
    const seenCitations = new Set<string>(); // Pour éviter les doublons

    // 1. Extraire citations depuis le corps du texte
    const bodyCitations = this.extractInTextCitations(fullText, pages);
    for (const citation of bodyCitations) {
      const key = `${citation.text}`;
      if (!seenCitations.has(key)) {
        citations.push(citation);
        seenCitations.add(key);
      }
    }

    // 2. Extraire citations depuis la bibliographie
    const bibliographyCitations = this.extractBibliographyCitations(fullText);
    for (const citation of bibliographyCitations) {
      const key = `${citation.text}`;
      if (!seenCitations.has(key)) {
        citations.push(citation);
        seenCitations.add(key);
      }
    }

    return citations;
  }

  // MARK: - In-Text Citations

  /**
   * Extrait les citations directement depuis le corps du texte
   */
  private extractInTextCitations(
    fullText: string,
    pages?: Array<{ pageNumber: number; text: string }>
  ): Citation[] {
    const citations: Citation[] = [];

    for (const pattern of this.citationPatterns) {
      let match: RegExpExecArray | null;

      // Reset regex state
      pattern.lastIndex = 0;

      while ((match = pattern.exec(fullText)) !== null) {
        const author = this.cleanAuthorName(match[1]);
        const year = match[2];
        const citationText = match[0];

        // Extraire le contexte (paragraphe contenant la citation)
        const context = this.extractContext(fullText, match.index);

        // Trouver le numéro de page si disponible
        const pageNumber = pages
          ? this.findPageNumber(match.index, fullText, pages)
          : undefined;

        citations.push({
          id: randomUUID(),
          text: citationText,
          author,
          year,
          context,
          pageNumber,
        });
      }
    }

    return citations;
  }

  // MARK: - Bibliography Extraction

  /**
   * Extrait les citations depuis la section bibliographie
   */
  private extractBibliographyCitations(fullText: string): Citation[] {
    const citations: Citation[] = [];

    // Trouver la section bibliographie
    const bibliographySection = this.findBibliographySection(fullText);
    if (!bibliographySection) {
      return citations;
    }

    // Parser les entrées de bibliographie
    const entries = this.parseBibliographyEntries(bibliographySection);

    for (const entry of entries) {
      const authorMatch = this.extractAuthorFromBibliography(entry);
      const yearMatch = entry.match(/\((\d{4}[a-z]?)\)|,\s*(\d{4}[a-z]?)[,.\s]/);

      if (authorMatch && yearMatch) {
        const author = this.cleanAuthorName(authorMatch);
        const year = yearMatch[1] || yearMatch[2];

        citations.push({
          id: randomUUID(),
          text: `${author} (${year})`,
          author,
          year,
          context: entry.substring(0, 200), // Premiers 200 caractères de l'entrée
        });
      }
    }

    return citations;
  }

  /**
   * Trouve la section bibliographie dans le texte
   */
  private findBibliographySection(fullText: string): string | null {
    for (const keyword of this.bibliographyKeywords) {
      // Recherche insensible à la casse
      const regex = new RegExp(`^\\s*${keyword}\\s*$`, 'gim');
      const match = regex.exec(fullText);

      if (match) {
        // Extraire depuis ce point jusqu'à la fin (ou prochain titre majeur)
        const startIndex = match.index;
        // Limite : soit fin du document, soit ~50 pages après (environ 150000 caractères)
        const endIndex = Math.min(fullText.length, startIndex + 150000);
        return fullText.substring(startIndex, endIndex);
      }
    }

    return null;
  }

  /**
   * Parse les entrées individuelles de la bibliographie
   */
  private parseBibliographyEntries(bibliographyText: string): string[] {
    const entries: string[] = [];

    // Séparer par lignes vides ou par pattern de nouvelle entrée
    // Pattern : Ligne commençant par Nom en majuscule ou par numéro/bullet
    const lines = bibliographyText.split('\n');

    let currentEntry = '';

    for (const line of lines) {
      const trimmedLine = line.trim();

      // Détecter nouvelle entrée : commence par majuscule ou chiffre
      const isNewEntry = /^(?:[A-ZÀÂÄÆÇÉÈÊËÏÎÔŒÙÛÜ]|[\d]+\.|\[[\d]+\]|\•)/.test(
        trimmedLine
      );

      if (isNewEntry && currentEntry.length > 20) {
        // Sauver l'entrée précédente
        entries.push(currentEntry.trim());
        currentEntry = trimmedLine;
      } else if (trimmedLine.length > 0) {
        // Continuer l'entrée courante
        currentEntry += ' ' + trimmedLine;
      }
    }

    // Ajouter la dernière entrée
    if (currentEntry.length > 20) {
      entries.push(currentEntry.trim());
    }

    return entries;
  }

  /**
   * Extrait le nom de l'auteur depuis une entrée de bibliographie
   */
  private extractAuthorFromBibliography(entry: string): string | null {
    // Pattern : Nom, P. ou Nom P. ou Nom, Prénom au début
    const patterns = [
      /^([A-ZÀÂÄÆÇÉÈÊËÏÎÔŒÙÛÜ][a-zàâäæçéèêëïîôœùûü]+(?:\s+[A-ZÀÂÄÆÇÉÈÊËÏÎÔŒÙÛÜ][a-zàâäæçéèêëïîôœùûü]+)*),\s+[A-Z]\./,
      /^([A-ZÀÂÄÆÇÉÈÊËÏÎÔŒÙÛÜ][a-zàâäæçéèêëïîôœùûü]+(?:\s+[A-ZÀÂÄÆÇÉÈÊËÏÎÔŒÙÛÜ][a-zàâäæçéèêëïîôœùûü]+)*)\s+[A-Z]\./,
      /^([A-ZÀÂÄÆÇÉÈÊËÏÎÔŒÙÛÜ][a-zàâäæçéèêëïîôœùûü]+)/,
    ];

    for (const pattern of patterns) {
      const match = entry.match(pattern);
      if (match) {
        return match[1];
      }
    }

    return null;
  }

  // MARK: - Context Extraction

  /**
   * Extrait le contexte (paragraphe) autour d'une citation
   */
  private extractContext(fullText: string, citationIndex: number): string {
    // Chercher le début et la fin du paragraphe
    const beforeText = fullText.substring(0, citationIndex);
    const afterText = fullText.substring(citationIndex);

    // Trouver le début du paragraphe (dernier \n\n ou début du texte)
    const paragraphStart = Math.max(0, beforeText.lastIndexOf('\n\n'));

    // Trouver la fin du paragraphe (prochain \n\n ou fin du texte)
    let paragraphEnd = afterText.indexOf('\n\n');
    if (paragraphEnd === -1) {
      paragraphEnd = Math.min(afterText.length, 500); // Limite à 500 chars
    }

    const context = fullText
      .substring(paragraphStart, citationIndex + paragraphEnd)
      .trim();

    // Limiter la longueur du contexte à ~300 caractères
    if (context.length > 300) {
      return context.substring(0, 297) + '...';
    }

    return context;
  }

  /**
   * Trouve le numéro de page pour une position donnée dans le texte
   */
  private findPageNumber(
    position: number,
    fullText: string,
    pages: Array<{ pageNumber: number; text: string }>
  ): number | undefined {
    let currentPosition = 0;

    for (const page of pages) {
      currentPosition += page.text.length;
      if (position <= currentPosition) {
        return page.pageNumber;
      }
    }

    return undefined;
  }

  // MARK: - Matching with Existing Documents

  /**
   * Fait correspondre les citations extraites avec les documents existants
   * @param citations Citations extraites
   * @param documents Documents existants dans la base
   * @returns Map de citation ID -> document ID correspondant
   */
  matchCitationsWithDocuments(
    citations: Citation[],
    documents: PDFDocument[]
  ): Map<string, string> {
    const matches = new Map<string, string>();

    for (const citation of citations) {
      if (!citation.author || !citation.year) {
        continue;
      }

      // Chercher un document correspondant
      const matchedDoc = this.findMatchingDocument(citation, documents);

      if (matchedDoc) {
        matches.set(citation.id, matchedDoc.id);
      }
    }

    return matches;
  }

  /**
   * Trouve le document correspondant à une citation
   */
  private findMatchingDocument(citation: Citation, documents: PDFDocument[]): PDFDocument | null {
    const citationAuthor = this.normalizeAuthorName(citation.author!);
    const citationYear = citation.year!.replace(/[a-z]/g, ''); // Retirer les suffixes comme "2020a"

    for (const doc of documents) {
      if (!doc.author || !doc.year) {
        continue;
      }

      const docAuthor = this.normalizeAuthorName(doc.author);
      const docYear = doc.year;

      // Match si :
      // 1. Années identiques
      // 2. Auteur dans citation contenu dans auteur du doc (ou vice versa)
      if (docYear === citationYear) {
        if (
          docAuthor.includes(citationAuthor) ||
          citationAuthor.includes(docAuthor) ||
          this.authorsAreSimilar(citationAuthor, docAuthor)
        ) {
          return doc;
        }
      }
    }

    return null;
  }

  // MARK: - Helper Methods

  /**
   * Nettoie un nom d'auteur extrait
   */
  private cleanAuthorName(author: string): string {
    return author
      .replace(/\s+et\s+al\.?$/i, '')
      .replace(/\s+et\s+collaborateurs$/i, '')
      .replace(/\s+&\s+.+$/, '') // Supprimer "& Autre"
      .replace(/\s+and\s+.+$/, '') // Supprimer "and Other"
      .trim();
  }

  /**
   * Normalise un nom d'auteur pour comparaison
   */
  private normalizeAuthorName(author: string): string {
    return author
      .toLowerCase()
      .normalize('NFD') // Décomposer les accents
      .replace(/[\u0300-\u036f]/g, '') // Retirer les accents
      .replace(/[^a-z\s]/g, '') // Garder uniquement lettres et espaces
      .trim();
  }

  /**
   * Vérifie si deux noms d'auteurs sont similaires
   * Utilise la distance de Levenshtein simplifiée
   */
  private authorsAreSimilar(author1: string, author2: string): boolean {
    // Si un auteur est contenu dans l'autre, c'est similaire
    if (author1.includes(author2) || author2.includes(author1)) {
      return true;
    }

    // Vérifier si les premiers mots correspondent (nom de famille)
    const words1 = author1.split(/\s+/);
    const words2 = author2.split(/\s+/);

    if (words1[0] === words2[0]) {
      return true;
    }

    return false;
  }

  /**
   * Détecte la langue d'un texte (simple heuristique)
   */
  detectLanguage(text: string): string {
    const sampleText = text.substring(0, 5000).toLowerCase();

    // Mots français communs
    const frenchWords = [
      'le',
      'la',
      'les',
      'de',
      'des',
      'un',
      'une',
      'et',
      'est',
      'dans',
      'pour',
      'par',
      'sur',
      'avec',
      'cette',
      'sont',
    ];

    // Mots anglais communs
    const englishWords = [
      'the',
      'of',
      'and',
      'to',
      'in',
      'is',
      'that',
      'for',
      'it',
      'with',
      'as',
      'was',
      'are',
      'this',
      'from',
    ];

    let frenchScore = 0;
    let englishScore = 0;

    for (const word of frenchWords) {
      const regex = new RegExp(`\\b${word}\\b`, 'g');
      const matches = sampleText.match(regex);
      frenchScore += matches ? matches.length : 0;
    }

    for (const word of englishWords) {
      const regex = new RegExp(`\\b${word}\\b`, 'g');
      const matches = sampleText.match(regex);
      englishScore += matches ? matches.length : 0;
    }

    if (frenchScore > englishScore * 1.2) {
      return 'fr';
    } else if (englishScore > frenchScore * 1.2) {
      return 'en';
    } else {
      return 'unknown';
    }
  }

  // MARK: - Statistics

  /**
   * Vérifie si une année est valide (entre 1500 et 2100)
   */
  private isValidYear(year: string): boolean {
    const yearNum = parseInt(year.replace(/[a-z]/g, ''));
    return yearNum >= 1500 && yearNum <= 2100;
  }

  /**
   * Retourne des statistiques sur les citations extraites
   */
  getCitationStatistics(citations: Citation[]): {
    totalCitations: number;
    uniqueAuthors: number;
    yearRange: { min?: string; max?: string };
    citationsWithContext: number;
    citationsWithPage: number;
  } {
    const uniqueAuthors = new Set(citations.map((c) => c.author).filter(Boolean));
    const allYears = citations.map((c) => c.year).filter(Boolean) as string[];

    // Filtrer pour ne garder que les années valides
    const validYears = allYears.filter((y) => this.isValidYear(y));

    return {
      totalCitations: citations.length,
      uniqueAuthors: uniqueAuthors.size,
      yearRange: {
        min: validYears.length > 0 ? Math.min(...validYears.map((y) => parseInt(y))).toString() : undefined,
        max: validYears.length > 0 ? Math.max(...validYears.map((y) => parseInt(y))).toString() : undefined,
      },
      citationsWithContext: citations.filter((c) => c.context).length,
      citationsWithPage: citations.filter((c) => c.pageNumber).length,
    };
  }
}
