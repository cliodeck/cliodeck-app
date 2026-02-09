/**
 * ChunkQualityScorer - Evaluates and filters chunks based on quality metrics
 *
 * Metrics used:
 * - Shannon entropy: Measures lexical diversity (higher = more information)
 * - Unique word ratio: Proportion of unique words (higher = less repetition)
 * - Average word length: Detects OCR garbage (too short or too long)
 * - Sentence count: Indicates coherence (very few = fragment)
 */

export interface ChunkQualityScore {
  entropy: number; // Shannon entropy normalized to 0-1
  uniqueWordRatio: number; // Unique words / total words
  avgWordLength: number; // Average word length in characters
  sentenceCount: number; // Number of sentences detected
  wordCount: number; // Total word count
  overallScore: number; // Weighted composite score 0-1
}

export interface QualityFilterConfig {
  minEntropy: number; // Minimum entropy threshold (default 0.3)
  minUniqueWordRatio: number; // Minimum unique word ratio (default 0.4)
  minSentenceCount: number; // Minimum sentences (default 1)
  minWordCount: number; // Minimum words (default 20)
  maxAvgWordLength: number; // Maximum avg word length (default 20)
  minAvgWordLength: number; // Minimum avg word length (default 2)
}

const DEFAULT_QUALITY_CONFIG: QualityFilterConfig = {
  minEntropy: 0.3,
  minUniqueWordRatio: 0.4,
  minSentenceCount: 1,
  minWordCount: 20,
  maxAvgWordLength: 20,
  minAvgWordLength: 2,
};

export class ChunkQualityScorer {
  private config: QualityFilterConfig;

  constructor(config: Partial<QualityFilterConfig> = {}) {
    this.config = { ...DEFAULT_QUALITY_CONFIG, ...config };
  }

  /**
   * Score a chunk's quality on multiple dimensions
   */
  scoreChunk(content: string): ChunkQualityScore {
    const words = this.tokenize(content);
    const sentences = this.countSentences(content);

    const wordCount = words.length;
    const uniqueWords = new Set(words.map((w) => w.toLowerCase()));
    const uniqueWordRatio = wordCount > 0 ? uniqueWords.size / wordCount : 0;

    const entropy = this.calculateEntropy(words);
    const avgWordLength = this.calculateAvgWordLength(words);

    // Calculate overall score (weighted average)
    const overallScore = this.calculateOverallScore({
      entropy,
      uniqueWordRatio,
      avgWordLength,
      sentenceCount: sentences,
      wordCount,
    });

    return {
      entropy,
      uniqueWordRatio,
      avgWordLength,
      sentenceCount: sentences,
      wordCount,
      overallScore,
    };
  }

  /**
   * Check if a chunk meets quality thresholds
   */
  meetsQualityThreshold(
    score: ChunkQualityScore,
    config?: Partial<QualityFilterConfig>
  ): boolean {
    const thresholds = { ...this.config, ...config };

    // Check each criterion
    if (score.entropy < thresholds.minEntropy) {
      return false;
    }

    if (score.uniqueWordRatio < thresholds.minUniqueWordRatio) {
      return false;
    }

    if (score.sentenceCount < thresholds.minSentenceCount) {
      return false;
    }

    if (score.wordCount < thresholds.minWordCount) {
      return false;
    }

    if (
      score.avgWordLength > thresholds.maxAvgWordLength ||
      score.avgWordLength < thresholds.minAvgWordLength
    ) {
      return false;
    }

    return true;
  }

  /**
   * Get rejection reason for debugging
   */
  getRejectionReason(
    score: ChunkQualityScore,
    config?: Partial<QualityFilterConfig>
  ): string | null {
    const thresholds = { ...this.config, ...config };

    if (score.entropy < thresholds.minEntropy) {
      return `low entropy (${score.entropy.toFixed(2)} < ${thresholds.minEntropy})`;
    }

    if (score.uniqueWordRatio < thresholds.minUniqueWordRatio) {
      return `low unique word ratio (${score.uniqueWordRatio.toFixed(2)} < ${thresholds.minUniqueWordRatio})`;
    }

    if (score.sentenceCount < thresholds.minSentenceCount) {
      return `too few sentences (${score.sentenceCount} < ${thresholds.minSentenceCount})`;
    }

    if (score.wordCount < thresholds.minWordCount) {
      return `too few words (${score.wordCount} < ${thresholds.minWordCount})`;
    }

    if (score.avgWordLength > thresholds.maxAvgWordLength) {
      return `avg word too long (${score.avgWordLength.toFixed(1)} > ${thresholds.maxAvgWordLength})`;
    }

    if (score.avgWordLength < thresholds.minAvgWordLength) {
      return `avg word too short (${score.avgWordLength.toFixed(1)} < ${thresholds.minAvgWordLength})`;
    }

    return null;
  }

  // MARK: - Private Methods

  /**
   * Tokenize text into words
   */
  private tokenize(text: string): string[] {
    return text
      .split(/\s+/)
      .map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')) // Keep only letters and numbers
      .filter((w) => w.length > 0);
  }

  /**
   * Count sentences using punctuation markers
   */
  private countSentences(text: string): number {
    // Match sentence-ending punctuation followed by space or end
    const sentenceEndings = text.match(/[.!?;]+(?:\s|$)/g);
    return sentenceEndings ? sentenceEndings.length : 0;
  }

  /**
   * Calculate Shannon entropy of word distribution
   * Returns value normalized to 0-1
   */
  private calculateEntropy(words: string[]): number {
    if (words.length === 0) return 0;

    // Count word frequencies
    const freqMap = new Map<string, number>();
    for (const word of words) {
      const lower = word.toLowerCase();
      freqMap.set(lower, (freqMap.get(lower) || 0) + 1);
    }

    // Calculate entropy: H = -SUM(p(x) * log2(p(x)))
    const total = words.length;
    let entropy = 0;

    for (const count of freqMap.values()) {
      const p = count / total;
      if (p > 0) {
        entropy -= p * Math.log2(p);
      }
    }

    // Normalize by max possible entropy (log2 of vocabulary size)
    const maxEntropy = Math.log2(freqMap.size);
    if (maxEntropy === 0) return 0;

    return Math.min(1, entropy / maxEntropy);
  }

  /**
   * Calculate average word length
   */
  private calculateAvgWordLength(words: string[]): number {
    if (words.length === 0) return 0;

    const totalLength = words.reduce((sum, w) => sum + w.length, 0);
    return totalLength / words.length;
  }

  /**
   * Calculate overall quality score (0-1)
   */
  private calculateOverallScore(metrics: {
    entropy: number;
    uniqueWordRatio: number;
    avgWordLength: number;
    sentenceCount: number;
    wordCount: number;
  }): number {
    // Weights for each metric
    const weights = {
      entropy: 0.35,
      uniqueWordRatio: 0.25,
      lengthScore: 0.2,
      sentenceScore: 0.2,
    };

    // Normalize avgWordLength to 0-1 (optimal around 5-8 chars)
    const optimalWordLength = 6;
    const lengthDeviation = Math.abs(metrics.avgWordLength - optimalWordLength);
    const lengthScore = Math.max(0, 1 - lengthDeviation / 10);

    // Normalize sentence count (diminishing returns after 5)
    const sentenceScore = Math.min(1, metrics.sentenceCount / 5);

    // Weighted sum
    return (
      weights.entropy * metrics.entropy +
      weights.uniqueWordRatio * metrics.uniqueWordRatio +
      weights.lengthScore * lengthScore +
      weights.sentenceScore * sentenceScore
    );
  }

  /**
   * Filter an array of chunks by quality
   */
  filterByQuality<T extends { content: string }>(
    chunks: T[],
    config?: Partial<QualityFilterConfig>,
    logFiltered = true
  ): { passed: T[]; filtered: T[]; stats: FilterStats } {
    const passed: T[] = [];
    const filtered: T[] = [];

    for (const chunk of chunks) {
      const score = this.scoreChunk(chunk.content);
      if (this.meetsQualityThreshold(score, config)) {
        passed.push(chunk);
      } else {
        filtered.push(chunk);
        if (logFiltered) {
          const reason = this.getRejectionReason(score, config);
          console.log(`⏭️  Filtered chunk: ${reason}`);
        }
      }
    }

    const stats: FilterStats = {
      totalChunks: chunks.length,
      passedChunks: passed.length,
      filteredChunks: filtered.length,
      filterRate: chunks.length > 0 ? filtered.length / chunks.length : 0,
    };

    return { passed, filtered, stats };
  }
}

export interface FilterStats {
  totalChunks: number;
  passedChunks: number;
  filteredChunks: number;
  filterRate: number;
}
