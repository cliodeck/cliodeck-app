import type { OllamaClient } from '../llm/OllamaClient';
import type { PDFMetadata } from '../../types/pdf-document';

export interface SummarizerConfig {
  enabled: boolean;
  method: 'extractive' | 'abstractive';
  maxLength: number; // En nombre de mots
  llmModel?: string; // Pour abstractif uniquement
}

interface Sentence {
  text: string;
  score: number;
  position: number;
}

/**
 * DocumentSummarizer génère des résumés de documents PDF
 * - Extractif : sélection de phrases importantes (sans dépendance externe)
 * - Abstractif : génération via LLM (Ollama)
 */
export class DocumentSummarizer {
  private config: SummarizerConfig;
  private ollamaClient?: OllamaClient;

  // Mots-clés académiques importants (FR + EN)
  private readonly academicKeywords = [
    // Français
    'recherche',
    'méthodologie',
    'résultats',
    'conclusion',
    'hypothèse',
    'analyse',
    'étude',
    'données',
    'démontrer',
    'proposer',
    'objectif',
    'contribution',
    // Anglais
    'research',
    'methodology',
    'results',
    'conclusion',
    'hypothesis',
    'analysis',
    'study',
    'data',
    'demonstrate',
    'propose',
    'objective',
    'contribution',
    'findings',
    'evidence',
    'approach',
    'framework',
  ];

  // Mots de transition à ignorer pour le scoring
  private readonly stopWords = new Set([
    // Français
    'le',
    'la',
    'les',
    'un',
    'une',
    'des',
    'de',
    'du',
    'et',
    'ou',
    'mais',
    'donc',
    'car',
    'pour',
    'dans',
    'sur',
    'à',
    'avec',
    'par',
    'ce',
    'qui',
    'que',
    'il',
    'elle',
    'on',
    'nous',
    'vous',
    'ils',
    'elles',
    // Anglais
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
  ]);

  constructor(config: SummarizerConfig, ollamaClient?: OllamaClient) {
    this.config = config;
    this.ollamaClient = ollamaClient;

    if (config.method === 'abstractive' && !ollamaClient) {
      throw new Error('OllamaClient required for abstractive summarization');
    }
  }

  /**
   * Génère un résumé du document
   * @param fullText Texte complet du document
   * @param metadata Métadonnées du document (optionnel)
   * @returns Résumé généré
   */
  async generateSummary(fullText: string, metadata?: PDFMetadata): Promise<string> {
    if (!this.config.enabled) {
      return '';
    }

    if (this.config.method === 'extractive') {
      return this.generateExtractiveSummary(fullText);
    } else {
      return this.generateAbstractiveSummary(fullText, metadata);
    }
  }

  /**
   * Génère un embedding pour le résumé
   * @param summary Résumé à encoder
   * @returns Embedding du résumé
   */
  async generateSummaryEmbedding(summary: string): Promise<Float32Array> {
    if (!this.ollamaClient) {
      throw new Error('OllamaClient required for embedding generation');
    }

    return this.ollamaClient.generateEmbedding(summary);
  }

  // MARK: - Extractive Summarization

  /**
   * Résumé extractif : sélection de phrases importantes
   * Algorithme simplifié basé sur :
   * - Fréquence des termes (TF-IDF simplifié)
   * - Position dans le document
   * - Présence de mots-clés académiques
   * - Longueur des phrases
   */
  private generateExtractiveSummary(fullText: string): string {
    // 1. Découper en phrases
    const sentences = this.splitIntoSentences(fullText);

    if (sentences.length === 0) {
      return '';
    }

    // 2. Calculer TF (fréquence des termes) pour tout le document
    const termFrequencies = this.calculateTermFrequencies(fullText);

    // 3. Scorer chaque phrase
    const scoredSentences: Sentence[] = sentences.map((sentence, index) => ({
      text: sentence,
      score: this.scoreSentence(sentence, index, sentences.length, termFrequencies),
      position: index,
    }));

    // 4. Trier par score décroissant
    scoredSentences.sort((a, b) => b.score - a.score);

    // 5. Sélectionner les meilleures phrases jusqu'à atteindre maxLength
    const selectedSentences: Sentence[] = [];
    let currentWordCount = 0;

    for (const sentence of scoredSentences) {
      const wordCount = this.countWords(sentence.text);

      if (currentWordCount + wordCount <= this.config.maxLength) {
        selectedSentences.push(sentence);
        currentWordCount += wordCount;
      }

      // Arrêter si on a assez de phrases
      if (currentWordCount >= this.config.maxLength * 0.9) {
        break;
      }
    }

    // 6. Retrier par position originale pour cohérence narrative
    selectedSentences.sort((a, b) => a.position - b.position);

    // 7. Joindre les phrases
    return selectedSentences.map((s) => s.text).join(' ');
  }

  /**
   * Découpe le texte en phrases
   */
  private splitIntoSentences(text: string): string[] {
    // Regex pour détecter fin de phrase (. ! ?) suivi d'espace et majuscule
    // Gère les abréviations courantes (Dr., Mr., etc.)
    const sentences = text
      .replace(/([.!?])\s+(?=[A-ZÀ-Ü])/g, '$1|SPLIT|')
      .split('|SPLIT|')
      .map((s) => s.trim())
      .filter((s) => s.length > 20); // Ignorer phrases trop courtes

    return sentences;
  }

  /**
   * Calcule la fréquence des termes dans le texte (TF)
   */
  private calculateTermFrequencies(text: string): Map<string, number> {
    const frequencies = new Map<string, number>();

    // Normaliser et extraire les mots
    const words = text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Supprimer accents
      .match(/\b[a-z]{3,}\b/g) || []; // Mots de 3+ lettres

    for (const word of words) {
      if (!this.stopWords.has(word)) {
        frequencies.set(word, (frequencies.get(word) || 0) + 1);
      }
    }

    return frequencies;
  }

  /**
   * Score une phrase selon plusieurs critères
   */
  private scoreSentence(
    sentence: string,
    position: number,
    totalSentences: number,
    termFrequencies: Map<string, number>
  ): number {
    let score = 0;

    // 1. Score basé sur la fréquence des termes (TF)
    const words: string[] = sentence
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .match(/\b[a-z]{3,}\b/g) || [];

    const tfScore = words.reduce((sum, word) => {
      return sum + (termFrequencies.get(word) || 0);
    }, 0);

    score += words.length > 0 ? tfScore / words.length : 0; // Moyenne TF

    // 2. Bonus pour position (début et fin du document sont importants)
    const relativePosition = position / totalSentences;
    if (relativePosition < 0.1) {
      score += 2.0; // Introduction
    } else if (relativePosition > 0.9) {
      score += 1.5; // Conclusion
    }

    // 3. Bonus pour mots-clés académiques
    const lowerSentence = sentence.toLowerCase();
    const keywordCount = this.academicKeywords.filter((keyword) =>
      lowerSentence.includes(keyword)
    ).length;
    score += keywordCount * 0.5;

    // 4. Pénalité pour phrases trop courtes ou trop longues
    const wordCount = this.countWords(sentence);
    if (wordCount < 10) {
      score -= 1.0;
    } else if (wordCount > 50) {
      score -= 0.5;
    }

    // 5. Bonus pour présence de chiffres (souvent dans résultats)
    if (/\d/.test(sentence)) {
      score += 0.3;
    }

    return score;
  }

  /**
   * Compte le nombre de mots dans une chaîne
   */
  private countWords(text: string): number {
    return (text.match(/\b\w+\b/g) || []).length;
  }

  // MARK: - Abstractive Summarization

  /**
   * Résumé abstractif : génération via LLM
   */
  private async generateAbstractiveSummary(
    fullText: string,
    metadata?: PDFMetadata
  ): Promise<string> {
    if (!this.ollamaClient) {
      throw new Error('OllamaClient not configured');
    }

    // Limiter la taille du texte envoyé au LLM (contexte max)
    const maxInputLength = 4000; // ~3000 tokens
    const truncatedText =
      fullText.length > maxInputLength ? fullText.substring(0, maxInputLength) + '...' : fullText;

    // Construire le prompt structuré
    const prompt = this.buildAbstractiveSummaryPrompt(truncatedText, metadata);

    try {
      // Générer le résumé via Ollama (sans contexte RAG, juste le prompt)
      const summary = await this.ollamaClient.generateResponse(prompt, []);

      return summary.trim();
    } catch (error) {
      console.error('❌ Abstractive summarization failed:', error);
      // Fallback sur extractif en cas d'erreur
      return this.generateExtractiveSummary(fullText);
    }
  }

  /**
   * Construit le prompt pour résumé abstractif
   */
  private buildAbstractiveSummaryPrompt(text: string, metadata?: PDFMetadata): string {
    const metadataStr = metadata
      ? `Titre: ${metadata.title || 'Non spécifié'}
Auteur(s): ${metadata.author || 'Non spécifié'}
Année: ${metadata.year || 'Non spécifiée'}`
      : '';

    return `Tu es un assistant académique spécialisé dans la synthèse d'articles de recherche.

${metadataStr ? `Informations sur le document:\n${metadataStr}\n` : ''}
Voici le texte d'un article académique (extrait):

"""
${text}
"""

Génère un résumé structuré de ${this.config.maxLength} mots maximum qui identifie:
1. La question de recherche ou problématique
2. La méthodologie employée (brièvement)
3. Les principaux résultats ou contributions
4. Les conclusions principales

Le résumé doit être factuel, précis et concis. Écris dans la même langue que le document source.`;
  }
}
