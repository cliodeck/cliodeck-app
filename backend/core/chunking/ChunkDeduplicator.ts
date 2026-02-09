/**
 * ChunkDeduplicator - Detects and removes duplicate chunks
 *
 * Two deduplication strategies:
 * 1. Content hash: Fast exact-match deduplication using MD5 hash
 * 2. Similarity-based: Slower but catches near-duplicates using Jaccard similarity
 */

import { createHash } from 'crypto';
import type { DocumentChunk } from '../../types/pdf-document.js';

export interface DeduplicationConfig {
  useContentHash: boolean; // Enable exact-match dedup
  useSimilarity: boolean; // Enable similarity-based dedup
  similarityThreshold: number; // 0.7-0.95, threshold for near-duplicates
}

export interface DeduplicationResult {
  uniqueChunks: DocumentChunk[];
  duplicateCount: number;
  duplicateMap: Map<string, string[]>; // hash -> duplicate chunk IDs
}

const DEFAULT_DEDUP_CONFIG: DeduplicationConfig = {
  useContentHash: true,
  useSimilarity: false,
  similarityThreshold: 0.85,
};

export class ChunkDeduplicator {
  private config: DeduplicationConfig;

  constructor(config: Partial<DeduplicationConfig> = {}) {
    this.config = { ...DEFAULT_DEDUP_CONFIG, ...config };
  }

  /**
   * Deduplicate an array of chunks
   */
  deduplicate(
    chunks: DocumentChunk[],
    options?: Partial<DeduplicationConfig>
  ): DeduplicationResult {
    const config = { ...this.config, ...options };

    if (chunks.length === 0) {
      return {
        uniqueChunks: [],
        duplicateCount: 0,
        duplicateMap: new Map(),
      };
    }

    let result = chunks;
    const duplicateMap = new Map<string, string[]>();
    let duplicateCount = 0;

    // Phase 1: Content hash deduplication (fast, exact)
    if (config.useContentHash) {
      const hashResult = this.deduplicateByHash(result);
      result = hashResult.uniqueChunks;
      duplicateCount += hashResult.duplicateCount;

      // Merge duplicate maps
      for (const [hash, ids] of hashResult.duplicateMap) {
        duplicateMap.set(hash, ids);
      }
    }

    // Phase 2: Similarity deduplication (slower, catches near-duplicates)
    if (config.useSimilarity) {
      const simResult = this.deduplicateBySimilarity(
        result,
        config.similarityThreshold
      );
      result = simResult.uniqueChunks;
      duplicateCount += simResult.duplicateCount;

      // Merge duplicate maps
      for (const [key, ids] of simResult.duplicateMap) {
        duplicateMap.set(key, ids);
      }
    }

    return {
      uniqueChunks: result,
      duplicateCount,
      duplicateMap,
    };
  }

  /**
   * Compute content hash for a chunk
   */
  computeContentHash(content: string): string {
    const normalized = this.normalizeContent(content);
    return createHash('md5').update(normalized).digest('hex');
  }

  /**
   * Calculate Jaccard similarity between two texts
   */
  calculateSimilarity(text1: string, text2: string): number {
    const words1 = new Set(this.tokenize(text1));
    const words2 = new Set(this.tokenize(text2));

    if (words1.size === 0 && words2.size === 0) return 1;
    if (words1.size === 0 || words2.size === 0) return 0;

    // Jaccard similarity: |A ∩ B| / |A ∪ B|
    let intersection = 0;
    for (const word of words1) {
      if (words2.has(word)) {
        intersection++;
      }
    }

    const union = words1.size + words2.size - intersection;
    return intersection / union;
  }

  // MARK: - Private Methods

  /**
   * Deduplicate using content hash (O(n))
   */
  private deduplicateByHash(chunks: DocumentChunk[]): DeduplicationResult {
    const seen = new Map<string, DocumentChunk>();
    const duplicateMap = new Map<string, string[]>();
    const uniqueChunks: DocumentChunk[] = [];

    for (const chunk of chunks) {
      const hash = this.computeContentHash(chunk.content);

      if (seen.has(hash)) {
        // Duplicate found
        const existingIds = duplicateMap.get(hash) || [seen.get(hash)!.id];
        existingIds.push(chunk.id);
        duplicateMap.set(hash, existingIds);
      } else {
        seen.set(hash, chunk);
        uniqueChunks.push(chunk);
      }
    }

    const duplicateCount = chunks.length - uniqueChunks.length;

    return {
      uniqueChunks,
      duplicateCount,
      duplicateMap,
    };
  }

  /**
   * Deduplicate using similarity (O(n²) worst case)
   * Optimized: only compare chunks from same document or consecutive chunks
   */
  private deduplicateBySimilarity(
    chunks: DocumentChunk[],
    threshold: number
  ): DeduplicationResult {
    const uniqueChunks: DocumentChunk[] = [];
    const duplicateMap = new Map<string, string[]>();
    const removed = new Set<string>();

    // Group chunks by document for faster comparison
    const byDocument = new Map<string, DocumentChunk[]>();
    for (const chunk of chunks) {
      const docChunks = byDocument.get(chunk.documentId) || [];
      docChunks.push(chunk);
      byDocument.set(chunk.documentId, docChunks);
    }

    // For each document, find similar chunks
    for (const [docId, docChunks] of byDocument) {
      // Compare consecutive chunks within document
      for (let i = 0; i < docChunks.length; i++) {
        const chunk = docChunks[i];
        if (removed.has(chunk.id)) continue;

        // Compare with next few chunks (overlap often creates near-duplicates)
        for (let j = i + 1; j < Math.min(i + 5, docChunks.length); j++) {
          const other = docChunks[j];
          if (removed.has(other.id)) continue;

          const similarity = this.calculateSimilarity(
            chunk.content,
            other.content
          );

          if (similarity >= threshold) {
            // Keep the first one, mark the other as duplicate
            removed.add(other.id);
            const key = `sim_${chunk.id}`;
            const existing = duplicateMap.get(key) || [chunk.id];
            existing.push(other.id);
            duplicateMap.set(key, existing);
          }
        }
      }
    }

    // Filter out removed chunks
    for (const chunk of chunks) {
      if (!removed.has(chunk.id)) {
        uniqueChunks.push(chunk);
      }
    }

    return {
      uniqueChunks,
      duplicateCount: removed.size,
      duplicateMap,
    };
  }

  /**
   * Normalize content for hashing
   */
  private normalizeContent(content: string): string {
    return content
      .toLowerCase()
      .replace(/\s+/g, ' ') // Collapse whitespace
      .replace(/[^\p{L}\p{N}\s]/gu, '') // Remove punctuation
      .trim();
  }

  /**
   * Tokenize text into words for similarity calculation
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2); // Filter very short words
  }

  /**
   * Check if a chunk would be a duplicate of existing chunks
   */
  isNearDuplicate(
    content: string,
    existingContents: string[],
    threshold = 0.85
  ): boolean {
    for (const existing of existingContents) {
      if (this.calculateSimilarity(content, existing) >= threshold) {
        return true;
      }
    }
    return false;
  }
}
