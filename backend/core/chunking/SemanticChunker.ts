/**
 * SemanticChunker - Creates chunks based on semantic boundaries
 *
 * Algorithm:
 * 1. Split document into sentences
 * 2. Create sliding windows of N sentences
 * 3. Generate embeddings for each window
 * 4. Calculate similarity between consecutive windows
 * 5. Detect boundaries where similarity drops significantly
 * 6. Group sentences between boundaries into chunks
 */

import { randomUUID } from 'crypto';
import type { DocumentPage, DocumentChunk } from '../../types/pdf-document.js';
import { EmbeddingCache } from './EmbeddingCache.js';
import type { ChunkingConfig } from './DocumentChunker.js';

export interface SemanticBoundary {
  position: number; // Sentence index
  similarityDrop: number; // How much similarity decreased
  confidence: number; // 0-1 confidence in boundary
}

export interface SemanticChunkingConfig {
  similarityThreshold: number; // 0.5-0.9, boundary detection threshold
  windowSize: number; // Number of sentences per window (2-5)
  minChunkSize: number; // Minimum words per chunk
  maxChunkSize: number; // Maximum words per chunk
  overlapSentences: number; // Number of sentences to overlap
}

type EmbeddingFunction = (text: string) => Promise<Float32Array>;

const DEFAULT_CONFIG: SemanticChunkingConfig = {
  similarityThreshold: 0.7,
  windowSize: 3,
  minChunkSize: 50,
  maxChunkSize: 500,
  overlapSentences: 1,
};

export class SemanticChunker {
  private config: SemanticChunkingConfig;
  private cache: EmbeddingCache;
  private generateEmbedding: EmbeddingFunction;

  constructor(
    generateEmbedding: EmbeddingFunction,
    config: Partial<SemanticChunkingConfig> = {},
    cache?: EmbeddingCache
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.cache = cache || new EmbeddingCache(500);
    this.generateEmbedding = generateEmbedding;
  }

  /**
   * Create chunks based on semantic boundaries
   */
  async createChunks(
    pages: DocumentPage[],
    documentId: string,
    documentMeta?: { title?: string }
  ): Promise<DocumentChunk[]> {
    // Combine all text
    const fullText = pages.map((p) => p.text).join('\n\n');

    // Split into sentences
    const sentences = this.splitIntoSentences(fullText);

    if (sentences.length === 0) {
      return [];
    }

    console.log(`🔍 [SEMANTIC] Processing ${sentences.length} sentences...`);

    // Detect semantic boundaries
    const boundaries = await this.detectBoundaries(sentences);

    console.log(`🔍 [SEMANTIC] Found ${boundaries.length} semantic boundaries`);

    // Create chunks based on boundaries
    const chunks = this.createChunksFromBoundaries(
      sentences,
      boundaries,
      documentId,
      pages,
      documentMeta
    );

    // Log cache stats
    const stats = this.cache.getStats();
    console.log(
      `📊 [SEMANTIC] Cache stats: ${stats.hits} hits, ${stats.misses} misses (${(stats.hitRate * 100).toFixed(1)}% hit rate)`
    );

    return chunks;
  }

  /**
   * Detect semantic boundaries between sentences
   */
  async detectBoundaries(sentences: string[]): Promise<SemanticBoundary[]> {
    if (sentences.length < this.config.windowSize * 2) {
      return []; // Not enough sentences for boundary detection
    }

    const boundaries: SemanticBoundary[] = [];
    const windowSize = this.config.windowSize;

    // Create windows and generate embeddings
    const windows: string[] = [];
    for (let i = 0; i <= sentences.length - windowSize; i++) {
      const window = sentences.slice(i, i + windowSize).join(' ');
      windows.push(window);
    }

    // Generate embeddings for all windows
    const embeddings = await this.generateWindowEmbeddings(windows);

    // Calculate similarity between consecutive windows
    const similarities: number[] = [];
    for (let i = 0; i < embeddings.length - 1; i++) {
      const sim = this.cosineSimilarity(embeddings[i], embeddings[i + 1]);
      similarities.push(sim);
    }

    // Detect boundaries where similarity drops
    const avgSimilarity =
      similarities.reduce((a, b) => a + b, 0) / similarities.length;
    const threshold = Math.min(
      this.config.similarityThreshold,
      avgSimilarity - 0.1
    );

    for (let i = 0; i < similarities.length; i++) {
      if (similarities[i] < threshold) {
        // Calculate confidence based on how much below threshold
        const drop = avgSimilarity - similarities[i];
        const confidence = Math.min(1, drop / 0.3);

        boundaries.push({
          position: i + windowSize, // Position after the window
          similarityDrop: drop,
          confidence,
        });
      }
    }

    // Filter out boundaries that are too close together
    return this.filterCloseBoundaries(boundaries, 3); // Min 3 sentences apart
  }

  /**
   * Create chunks from detected boundaries
   */
  private createChunksFromBoundaries(
    sentences: string[],
    boundaries: SemanticBoundary[],
    documentId: string,
    pages: DocumentPage[],
    documentMeta?: { title?: string }
  ): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    const boundaryPositions = [0, ...boundaries.map((b) => b.position), sentences.length];

    // Build page mapping
    const pageMapping = this.buildPageMapping(pages);

    let chunkIndex = 0;
    for (let i = 0; i < boundaryPositions.length - 1; i++) {
      const start = boundaryPositions[i];
      const end = boundaryPositions[i + 1];

      // Get sentences for this chunk
      const chunkSentences = sentences.slice(start, end);
      let content = chunkSentences.join(' ');

      // Check chunk size
      const wordCount = content.split(/\s+/).length;

      // Skip if too small
      if (wordCount < this.config.minChunkSize && i < boundaryPositions.length - 2) {
        continue;
      }

      // Split if too large
      if (wordCount > this.config.maxChunkSize) {
        const subChunks = this.splitLargeChunk(
          chunkSentences,
          documentId,
          chunkIndex,
          pageMapping,
          documentMeta
        );
        chunks.push(...subChunks);
        chunkIndex += subChunks.length;
        continue;
      }

      // Add document context
      if (documentMeta?.title) {
        content = `[Doc: ${documentMeta.title}]\n\n` + content;
      }

      // Find position in original text
      const position = this.findPosition(content, pageMapping);

      chunks.push({
        id: randomUUID(),
        documentId,
        content: this.cleanText(content),
        pageNumber: position.pageNumber,
        chunkIndex: chunkIndex++,
        startPosition: position.start,
        endPosition: position.end,
      });
    }

    return chunks;
  }

  // MARK: - Helper Methods

  /**
   * Split text into sentences
   */
  private splitIntoSentences(text: string): string[] {
    // Handle common abbreviations
    const abbrevs = ['Dr', 'Mr', 'Mrs', 'Ms', 'Prof', 'Jr', 'Sr', 'vs', 'etc', 'e.g', 'i.e'];
    let processed = text;

    for (const abbrev of abbrevs) {
      processed = processed.replace(
        new RegExp(`\\b${abbrev}\\.`, 'gi'),
        `${abbrev}<<<DOT>>>`
      );
    }

    // Split on sentence boundaries
    const sentences = processed
      .split(/(?<=[.!?;])\s+/)
      .map((s) => s.replace(/<<<DOT>>>/g, '.').trim())
      .filter((s) => s.length > 10); // Filter very short fragments

    return sentences;
  }

  /**
   * Generate embeddings for windows with caching
   */
  private async generateWindowEmbeddings(windows: string[]): Promise<Float32Array[]> {
    const embeddings: Float32Array[] = [];

    for (const window of windows) {
      const embedding = await this.cache.getOrCompute(
        window,
        this.generateEmbedding
      );
      embeddings.push(embedding);
    }

    return embeddings;
  }

  /**
   * Calculate cosine similarity between two embeddings
   */
  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      throw new Error('Embedding dimensions must match');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude > 0 ? dotProduct / magnitude : 0;
  }

  /**
   * Filter boundaries that are too close together
   */
  private filterCloseBoundaries(
    boundaries: SemanticBoundary[],
    minDistance: number
  ): SemanticBoundary[] {
    if (boundaries.length === 0) return [];

    // Sort by position
    const sorted = [...boundaries].sort((a, b) => a.position - b.position);

    const filtered: SemanticBoundary[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const last = filtered[filtered.length - 1];
      if (sorted[i].position - last.position >= minDistance) {
        filtered.push(sorted[i]);
      } else if (sorted[i].confidence > last.confidence) {
        // Replace with higher confidence boundary
        filtered[filtered.length - 1] = sorted[i];
      }
    }

    return filtered;
  }

  /**
   * Split a chunk that's too large
   */
  private splitLargeChunk(
    sentences: string[],
    documentId: string,
    startIndex: number,
    pageMapping: Array<{ pageNumber: number; startPosition: number; endPosition: number }>,
    documentMeta?: { title?: string }
  ): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    const targetSize = this.config.maxChunkSize * 0.8; // Target 80% of max

    let currentSentences: string[] = [];
    let currentWordCount = 0;
    let chunkIndex = startIndex;

    for (const sentence of sentences) {
      const sentenceWords = sentence.split(/\s+/).length;

      if (currentWordCount + sentenceWords > targetSize && currentSentences.length > 0) {
        // Create chunk
        let content = currentSentences.join(' ');
        if (documentMeta?.title) {
          content = `[Doc: ${documentMeta.title}]\n\n` + content;
        }

        const position = this.findPosition(content, pageMapping);

        chunks.push({
          id: randomUUID(),
          documentId,
          content: this.cleanText(content),
          pageNumber: position.pageNumber,
          chunkIndex: chunkIndex++,
          startPosition: position.start,
          endPosition: position.end,
        });

        // Start new chunk with overlap
        currentSentences = currentSentences.slice(-this.config.overlapSentences);
        currentWordCount = currentSentences.join(' ').split(/\s+/).length;
      }

      currentSentences.push(sentence);
      currentWordCount += sentenceWords;
    }

    // Don't forget the last chunk
    if (currentSentences.length > 0) {
      let content = currentSentences.join(' ');
      if (documentMeta?.title) {
        content = `[Doc: ${documentMeta.title}]\n\n` + content;
      }

      const position = this.findPosition(content, pageMapping);

      chunks.push({
        id: randomUUID(),
        documentId,
        content: this.cleanText(content),
        pageNumber: position.pageNumber,
        chunkIndex: chunkIndex++,
        startPosition: position.start,
        endPosition: position.end,
      });
    }

    return chunks;
  }

  /**
   * Build page mapping for position tracking
   */
  private buildPageMapping(
    pages: DocumentPage[]
  ): Array<{ pageNumber: number; startPosition: number; endPosition: number }> {
    const mapping: Array<{ pageNumber: number; startPosition: number; endPosition: number }> = [];
    let currentPos = 0;

    for (const page of pages) {
      mapping.push({
        pageNumber: page.pageNumber,
        startPosition: currentPos,
        endPosition: currentPos + page.text.length,
      });
      currentPos += page.text.length + 2; // +2 for \n\n
    }

    return mapping;
  }

  /**
   * Find position of content in original document
   */
  private findPosition(
    _content: string,
    mapping: Array<{ pageNumber: number; startPosition: number; endPosition: number }>
  ): { pageNumber: number; start: number; end: number } {
    // Simplified: return first page info
    // In production, would do proper text matching
    if (mapping.length === 0) {
      return { pageNumber: 1, start: 0, end: 0 };
    }

    return {
      pageNumber: mapping[0].pageNumber,
      start: mapping[0].startPosition,
      end: mapping[0].endPosition,
    };
  }

  /**
   * Clean text for storage
   */
  private cleanText(text: string): string {
    return text
      .replace(/\n{3,}/g, '\n\n')
      .replace(/ {2,}/g, ' ')
      .trim();
  }

  /**
   * Get cache for external use
   */
  getCache(): EmbeddingCache {
    return this.cache;
  }
}
