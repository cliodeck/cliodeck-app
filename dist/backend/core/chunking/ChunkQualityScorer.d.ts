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
    entropy: number;
    uniqueWordRatio: number;
    avgWordLength: number;
    sentenceCount: number;
    wordCount: number;
    overallScore: number;
}
export interface QualityFilterConfig {
    minEntropy: number;
    minUniqueWordRatio: number;
    minSentenceCount: number;
    minWordCount: number;
    maxAvgWordLength: number;
    minAvgWordLength: number;
}
export declare class ChunkQualityScorer {
    private config;
    constructor(config?: Partial<QualityFilterConfig>);
    /**
     * Score a chunk's quality on multiple dimensions
     */
    scoreChunk(content: string): ChunkQualityScore;
    /**
     * Check if a chunk meets quality thresholds
     */
    meetsQualityThreshold(score: ChunkQualityScore, config?: Partial<QualityFilterConfig>): boolean;
    /**
     * Get rejection reason for debugging
     */
    getRejectionReason(score: ChunkQualityScore, config?: Partial<QualityFilterConfig>): string | null;
    /**
     * Tokenize text into words
     */
    private tokenize;
    /**
     * Count sentences using punctuation markers
     */
    private countSentences;
    /**
     * Calculate Shannon entropy of word distribution
     * Returns value normalized to 0-1
     */
    private calculateEntropy;
    /**
     * Calculate average word length
     */
    private calculateAvgWordLength;
    /**
     * Calculate overall quality score (0-1)
     */
    private calculateOverallScore;
    /**
     * Filter an array of chunks by quality
     */
    filterByQuality<T extends {
        content: string;
    }>(chunks: T[], config?: Partial<QualityFilterConfig>, logFiltered?: boolean): {
        passed: T[];
        filtered: T[];
        stats: FilterStats;
    };
}
export interface FilterStats {
    totalChunks: number;
    passedChunks: number;
    filteredChunks: number;
    filterRate: number;
}
