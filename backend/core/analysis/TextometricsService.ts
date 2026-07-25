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
  // Comptages de base
  totalWords: number;
  uniqueWords: number;
  totalWordsWithStopwords: number;
  vocabularySize: number;
  lexicalRichness: number; // ratio uniqueWords / totalWords

  // Fréquences
  topWords: Array<{ word: string; count: number; frequency: number }>;
  topBigrams: Array<{ ngram: string; count: number }>;
  topTrigrams: Array<{ ngram: string; count: number }>;

  // Distribution
  wordFrequencyDistribution: Map<number, number>; // fréquence -> nb de mots avec cette fréquence
}

export interface CorpusTextStatistics extends TextStatistics {
  totalDocuments: number;
  averageWordsPerDocument: number;
  averageVocabularyPerDocument: number;
}

export interface DocumentTextStatistics extends TextStatistics {
  documentId: string;
  characteristicWords: Array<{ word: string; tfIdf: number }>; // Mots caractéristiques (TF-IDF)
}

interface WordFrequency {
  [word: string]: number;
}

/**
 * Service d'analyse textométrique
 */
export class TextometricsService {
  // Stopwords français et anglais
  private readonly stopwords: Set<string>;

  constructor() {
    this.stopwords = new Set([
      // Stopwords français
      'le',
      'la',
      'les',
      'un',
      'une',
      'des',
      'de',
      'du',
      'd',
      'et',
      'ou',
      'mais',
      'donc',
      'car',
      'pour',
      'dans',
      'sur',
      'à',
      'au',
      'aux',
      'avec',
      'par',
      'ce',
      'qui',
      'que',
      'quoi',
      'dont',
      'il',
      'elle',
      'on',
      'nous',
      'vous',
      'ils',
      'elles',
      'cette',
      'ces',
      'son',
      'sa',
      'ses',
      'leur',
      'leurs',
      'mon',
      'ma',
      'mes',
      'ton',
      'ta',
      'tes',
      'notre',
      'votre',
      'se',
      's',
      'si',
      'ne',
      'ni',
      'pas',
      'plus',
      'sans',
      'y',
      'en',
      'être',
      'avoir',
      'faire',
      'dit',
      'peut',
      'sont',
      'été',
      'était',
      'est',
      'ai',
      'as',
      'avons',
      'avez',
      'ont',
      'suis',
      'es',
      'sommes',
      'êtes',
      // Stopwords anglais
      'the',
      'a',
      'an',
      'and',
      'or',
      'but',
      'in',
      'on',
      'at',
      'to',
      'for',
      'of',
      'with',
      'by',
      'from',
      'as',
      'is',
      'was',
      'are',
      'were',
      'been',
      'be',
      'have',
      'has',
      'had',
      'do',
      'does',
      'did',
      'will',
      'would',
      'could',
      'should',
      'may',
      'might',
      'can',
      'this',
      'that',
      'these',
      'those',
      'it',
      'its',
      'he',
      'she',
      'they',
      'we',
      'you',
      'i',
      'me',
      'my',
      'your',
      'his',
      'her',
      'their',
      'our',
      'which',
      'who',
      'whom',
      'whose',
      'what',
      'where',
      'when',
      'why',
      'how',
      'not',
      'no',
      'nor',
      'so',
      'than',
      'too',
      'very',
      'also',
      'only',
      'just',
    ]);
  }

  /**
   * Tokenize le texte en mots
   * @param text Texte brut
   * @returns Liste de mots (lowercase, nettoyés)
   */
  private tokenize(text: string): string[] {
    // Supprimer les URLs et DOIs avant la tokenisation
    const cleanedText = text
      // Supprimer les URLs (http, https, ftp)
      .replace(/(?:https?|ftp):\/\/[^\s]+/gi, ' ')
      // Supprimer les DOIs (format doi:10.xxxx ou https://doi.org/10.xxxx)
      .replace(/\b(?:doi[:\s]*)?10\.\d{4,}(?:\.\d+)*\/[^\s]+/gi, ' ')
      // Supprimer les emails
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, ' ');

    // Nettoyer et normaliser le texte
    const normalized = cleanedText
      .toLowerCase()
      // Remplacer les apostrophes typographiques par des apostrophes simples
      .replace(/['']/g, "'")
      // Garder uniquement les lettres, chiffres, espaces, apostrophes et traits d'union
      .replace(/[^a-zàâäæçéèêëïîôœùûü0-9\s'\-]/g, ' ')
      // Normaliser les espaces multiples
      .replace(/\s+/g, ' ')
      .trim();

    // Séparer en mots
    const words = normalized.split(/\s+/).filter((word) => {
      // Filtrer les mots vides et trop courts
      if (word.length < 2 || this.stopwords.has(word)) {
        return false;
      }
      // Filtrer les fragments d'URLs/DOIs qui pourraient rester
      if (this.isUrlOrDoiFragment(word)) {
        return false;
      }
      return true;
    });

    return words;
  }

  /**
   * Vérifie si un mot est un fragment d'URL ou de DOI
   */
  private isUrlOrDoiFragment(word: string): boolean {
    // Mots typiques des URLs et DOIs à filtrer
    const urlDoiPatterns = [
      /^https?$/,
      /^www$/,
      /^ftp$/,
      /^doi$/,
      /^org$/,
      /^com$/,
      /^net$/,
      /^edu$/,
      /^gov$/,
      /^io$/,
      /^fr$/,
      /^de$/,
      /^uk$/,
      /^pdf$/,
      /^html$/,
      /^htm$/,
      /^php$/,
      /^aspx?$/,
      /^jsp$/,
      /^\d{4,}$/, // Séquences de chiffres (typiques des DOIs)
      /^[a-z]\d+$/, // Lettres suivies de chiffres (ex: s12345)
      /^\d+[a-z]+$/, // Chiffres suivis de lettres
    ];

    return urlDoiPatterns.some(pattern => pattern.test(word));
  }

  /**
   * Tokenize en gardant les stopwords (pour calcul du total avec stopwords)
   */
  private tokenizeWithStopwords(text: string): string[] {
    const normalized = text
      .toLowerCase()
      .replace(/['']/g, "'")
      .replace(/[^a-zàâäæçéèêëïîôœùûü0-9\s'\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return normalized.split(/\s+/).filter((word) => word.length >= 1);
  }

  /**
   * Calcule la fréquence des mots
   */
  private calculateWordFrequency(words: string[]): WordFrequency {
    const frequency: WordFrequency = {};

    for (const word of words) {
      frequency[word] = (frequency[word] || 0) + 1;
    }

    return frequency;
  }

  /**
   * Extrait les n-grammes depuis une liste de mots
   * @param words Liste de mots
   * @param n Taille du n-gramme (2 = bigramme, 3 = trigramme)
   * @returns Fréquence des n-grammes
   */
  private extractNgrams(words: string[], n: number): WordFrequency {
    const ngrams: WordFrequency = {};

    for (let i = 0; i <= words.length - n; i++) {
      const ngram = words.slice(i, i + n).join(' ');
      ngrams[ngram] = (ngrams[ngram] || 0) + 1;
    }

    return ngrams;
  }

  /**
   * Calcule la distribution de fréquence (combien de mots apparaissent 1 fois, 2 fois, etc.)
   */
  private calculateFrequencyDistribution(frequency: WordFrequency): Map<number, number> {
    const distribution = new Map<number, number>();

    for (const count of Object.values(frequency)) {
      distribution.set(count, (distribution.get(count) || 0) + 1);
    }

    return distribution;
  }

  /**
   * Analyse un texte unique
   * @param text Texte à analyser
   * @param topN Nombre de mots/n-grammes les plus fréquents à retourner
   * @returns Statistiques textuelles
   */
  analyzeText(text: string, topN: number = 50): TextStatistics {
    console.log(`📊 [TextometricsService] analyzeText - input text length: ${text.length} characters`);

    // Tokenize
    const words = this.tokenize(text);
    const wordsWithStopwords = this.tokenizeWithStopwords(text);

    console.log(`📊 [TextometricsService] Tokenized: ${words.length} words (without stopwords), ${wordsWithStopwords.length} words (with stopwords)`);

    // Fréquence des mots
    const wordFrequency = this.calculateWordFrequency(words);

    // Trier par fréquence décroissante
    const sortedWords = Object.entries(wordFrequency)
      .sort(([, countA], [, countB]) => countB - countA)
      .slice(0, topN);

    const totalWords = words.length;
    const topWords = sortedWords.map(([word, count]) => ({
      word,
      count,
      frequency: count / totalWords,
    }));

    // N-grammes
    const bigramFrequency = this.extractNgrams(words, 2);
    const trigramFrequency = this.extractNgrams(words, 3);

    const topBigrams = Object.entries(bigramFrequency)
      .sort(([, countA], [, countB]) => countB - countA)
      .slice(0, topN)
      .map(([ngram, count]) => ({ ngram, count }));

    const topTrigrams = Object.entries(trigramFrequency)
      .sort(([, countA], [, countB]) => countB - countA)
      .slice(0, topN)
      .map(([ngram, count]) => ({ ngram, count }));

    // Distribution de fréquence
    const wordFrequencyDistribution = this.calculateFrequencyDistribution(wordFrequency);

    return {
      totalWords,
      uniqueWords: Object.keys(wordFrequency).length,
      totalWordsWithStopwords: wordsWithStopwords.length,
      vocabularySize: Object.keys(wordFrequency).length,
      lexicalRichness: Object.keys(wordFrequency).length / totalWords || 0,
      topWords,
      topBigrams,
      topTrigrams,
      wordFrequencyDistribution,
    };
  }

  /**
   * Analyse un corpus complet (plusieurs documents)
   * @param documents Liste de documents avec leur texte
   * @param topN Nombre de mots/n-grammes les plus fréquents à retourner
   * @returns Statistiques du corpus
   */
  analyzeCorpus(
    documents: Array<{ id: string; text: string }>,
    topN: number = 50
  ): CorpusTextStatistics {
    console.log(`📊 [TextometricsService] Analyzing corpus with ${documents.length} documents`);

    // Concaténer tous les textes
    const fullCorpusText = documents.map((doc) => doc.text).join(' ');
    console.log(`📊 [TextometricsService] Full corpus text length: ${fullCorpusText.length} characters`);

    // Analyser le corpus complet
    const corpusStats = this.analyzeText(fullCorpusText, topN);

    // Calculer les moyennes par document
    let totalWordsAllDocs = 0;
    let totalVocabularyAllDocs = 0;

    for (const doc of documents) {
      const docStats = this.analyzeText(doc.text, topN);
      totalWordsAllDocs += docStats.totalWords;
      totalVocabularyAllDocs += docStats.vocabularySize;
    }

    return {
      ...corpusStats,
      totalDocuments: documents.length,
      averageWordsPerDocument: totalWordsAllDocs / documents.length || 0,
      averageVocabularyPerDocument: totalVocabularyAllDocs / documents.length || 0,
    };
  }

  /**
   * Analyse un document spécifique avec calcul de TF-IDF pour les mots caractéristiques
   * @param documentText Texte du document
   * @param corpusDocuments Tous les documents du corpus (pour TF-IDF)
   * @param topN Nombre de mots/n-grammes les plus fréquents
   * @returns Statistiques du document avec mots caractéristiques
   */
  analyzeDocument(
    documentId: string,
    documentText: string,
    corpusDocuments: Array<{ id: string; text: string }>,
    topN: number = 50
  ): DocumentTextStatistics {
    // Analyser le document
    const docStats = this.analyzeText(documentText, topN);

    // Calculer TF-IDF pour les mots caractéristiques
    const characteristicWords = this.calculateTfIdf(documentText, corpusDocuments, topN);

    return {
      ...docStats,
      documentId,
      characteristicWords,
    };
  }

  /**
   * Calcule le TF-IDF pour trouver les mots caractéristiques d'un document
   * @param documentText Texte du document cible
   * @param corpusDocuments Tous les documents du corpus
   * @param topN Nombre de mots caractéristiques à retourner
   * @returns Liste des mots avec leur score TF-IDF
   */
  private calculateTfIdf(
    documentText: string,
    corpusDocuments: Array<{ id: string; text: string }>,
    topN: number
  ): Array<{ word: string; tfIdf: number }> {
    const docWords = this.tokenize(documentText);
    const docWordFreq = this.calculateWordFrequency(docWords);
    const docWordCount = docWords.length;

    // Calculer IDF pour chaque mot
    const idfScores: { [word: string]: number } = {};
    const totalDocs = corpusDocuments.length;

    for (const word of Object.keys(docWordFreq)) {
      // Compter dans combien de documents ce mot apparaît
      let docsWithWord = 0;
      for (const doc of corpusDocuments) {
        const words = this.tokenize(doc.text);
        if (words.includes(word)) {
          docsWithWord++;
        }
      }

      // IDF = log(N / df)
      idfScores[word] = Math.log(totalDocs / (docsWithWord || 1));
    }

    // Calculer TF-IDF
    const tfIdfScores = Object.entries(docWordFreq).map(([word, count]) => {
      const tf = count / docWordCount;
      const idf = idfScores[word];
      const tfIdf = tf * idf;

      return { word, tfIdf };
    });

    // Trier par score TF-IDF décroissant
    tfIdfScores.sort((a, b) => b.tfIdf - a.tfIdf);

    return tfIdfScores.slice(0, topN);
  }

  /**
   * Ajoute des stopwords personnalisés
   */
  addStopwords(words: string[]): void {
    for (const word of words) {
      this.stopwords.add(word.toLowerCase());
    }
  }

  /**
   * Supprime des stopwords
   */
  removeStopwords(words: string[]): void {
    for (const word of words) {
      this.stopwords.delete(word.toLowerCase());
    }
  }

  /**
   * Retourne la liste des stopwords actuels
   */
  getStopwords(): string[] {
    return Array.from(this.stopwords).sort();
  }
}
