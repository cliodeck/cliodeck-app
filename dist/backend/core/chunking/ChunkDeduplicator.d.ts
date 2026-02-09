/**
 * ChunkDeduplicator - Detects and removes duplicate chunks
 *
 * Two deduplication strategies:
 * 1. Content hash: Fast exact-match deduplication using MD5 hash
 * 2. Similarity-based: Slower but catches near-duplicates using Jaccard similarity
 */
import type { DocumentChunk } from '../../types/pdf-document.js';
export interface DeduplicationConfig {
    useContentHash: boolean;
    useSimilarity: boolean;
    similarityThreshold: number;
}
export interface DeduplicationResult {
    uniqueChunks: DocumentChunk[];
    duplicateCount: number;
    duplicateMap: Map<string, string[]>;
}
export declare class ChunkDeduplicator {
    private config;
    constructor(config?: Partial<DeduplicationConfig>);
    /**
     * Deduplicate an array of chunks
     */
    deduplicate(chunks: DocumentChunk[], options?: Partial<DeduplicationConfig>): DeduplicationResult;
    /**
     * Compute content hash for a chunk
     */
    computeContentHash(content: string): string;
    /**
     * Calculate Jaccard similarity between two texts
     */
    calculateSimilarity(text1: string, text2: string): number;
    /**
     * Deduplicate using content hash (O(n))
     */
    private deduplicateByHash;
    /**
     * Deduplicate using similarity (O(n²) worst case)
     * Optimized: only compare chunks from same document or consecutive chunks
     */
    private deduplicateBySimilarity;
    /**
     * Normalize content for hashing
     */
    private normalizeContent;
    /**
     * Tokenize text into words for similarity calculation
     */
    private tokenize;
    /**
     * Check if a chunk would be a duplicate of existing chunks
     */
    isNearDuplicate(content: string, existingContents: string[], threshold?: number): boolean;
}
