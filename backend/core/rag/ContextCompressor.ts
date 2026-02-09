/**
 * ContextCompressor - Intelligent chunk compression for RAG
 *
 * Implements multi-strategy compression:
 * 1. Semantic deduplication (remove similar chunks)
 * 2. Relevance-based sentence extraction (keep only relevant sentences)
 * 3. Hierarchical compression (adapt strategy based on size)
 * 4. Keyword preservation (always keep sentences with query terms)
 */

interface Chunk {
  content: string;
  documentId: string;
  documentTitle: string;
  pageNumber: number;
  similarity: number;
  embedding?: number[];
}

interface CompressedResult {
  chunks: Chunk[];
  stats: {
    originalSize: number;
    compressedSize: number;
    originalChunks: number;
    compressedChunks: number;
    reductionPercent: number;
    strategy: string;
  };
}

export class ContextCompressor {
  /**
   * Main compression method - applies strategies based on content size
   */
  compress(chunks: Chunk[], query: string, maxChars: number = 20000): CompressedResult {
    const startTime = Date.now();
    const originalSize = this.calculateTotalSize(chunks);
    const originalCount = chunks.length;

    // 🚀 OPTIMIZATION: Skip compression for small contexts (< 10k chars)
    if (originalSize <= 10000) {
      console.log('⏭️  [COMPRESSION] Skipping - context already small:', {
        originalChunks: originalCount,
        originalSize,
      });
      return {
        chunks,
        stats: {
          originalSize,
          compressedSize: originalSize,
          originalChunks: originalCount,
          compressedChunks: originalCount,
          reductionPercent: 0,
          strategy: 'none-small',
        },
      };
    }

    console.log('🗜️  [COMPRESSION] Starting intelligent compression:', {
      originalChunks: originalCount,
      originalSize,
      maxChars,
      targetReduction: originalSize > maxChars ? `${Math.round((1 - maxChars / originalSize) * 100)}%` : 'none',
    });

    // Extract keywords from query for preservation
    const keywords = this.extractKeywords(query);
    console.log('🔑 [COMPRESSION] Query keywords:', keywords);

    let processed = [...chunks];
    let strategy = 'none';

    // Level 1: Light compression (15k-25k chars) - Semantic deduplication only
    if (originalSize > 15000 && originalSize <= 25000) {
      strategy = 'light-deduplication';
      console.log('📊 [COMPRESSION] Applying Level 1: Light semantic deduplication (threshold: 0.88)');
      processed = this.deduplicateSemanticChunks(processed, 0.88);
    }
    // Level 2: Medium compression (25k-35k chars) - Dedup + sentence extraction
    else if (originalSize > 25000 && originalSize <= 35000) {
      strategy = 'medium-dedup-extraction';
      console.log('📊 [COMPRESSION] Applying Level 2: Semantic dedup + sentence extraction');

      // Step 1: Semantic deduplication (moderate threshold)
      processed = this.deduplicateSemanticChunks(processed, 0.85);

      // Step 2: Extract relevant sentences
      const currentSize = this.calculateTotalSize(processed);
      if (currentSize > maxChars) {
        processed = this.extractRelevantSentences(processed, query, keywords, 0.3);
      }
    }
    // Level 3: Aggressive compression (>35k chars) - All strategies
    else if (originalSize > 35000) {
      strategy = 'aggressive-full';
      console.log('📊 [COMPRESSION] Applying Level 3: Aggressive full compression');

      // Step 1: Aggressive semantic deduplication
      processed = this.deduplicateSemanticChunks(processed, 0.80);

      // Step 2: Relevance-based sentence extraction
      processed = this.extractRelevantSentences(processed, query, keywords, 0.4);

      // Step 3: If still too large, reduce to top-K most similar chunks
      const currentSize = this.calculateTotalSize(processed);
      if (currentSize > maxChars) {
        const targetChunks = Math.ceil(processed.length * (maxChars / currentSize));
        processed = this.selectTopKChunks(processed, Math.max(3, targetChunks));
      }
    }

    const finalSize = this.calculateTotalSize(processed);
    const reduction = originalSize > 0 ? ((originalSize - finalSize) / originalSize) * 100 : 0;
    const duration = Date.now() - startTime;

    console.log('✅ [COMPRESSION] Compression complete:', {
      strategy,
      originalChunks: originalCount,
      compressedChunks: processed.length,
      originalSize,
      compressedSize: finalSize,
      reduction: `${reduction.toFixed(1)}%`,
      duration: `${duration}ms`,
    });

    return {
      chunks: processed,
      stats: {
        originalSize,
        compressedSize: finalSize,
        originalChunks: originalCount,
        compressedChunks: processed.length,
        reductionPercent: reduction,
        strategy,
      },
    };
  }

  /**
   * Calculate total character count of all chunks
   */
  private calculateTotalSize(chunks: Chunk[]): number {
    return chunks.reduce((sum, chunk) => sum + chunk.content.length, 0);
  }

  /**
   * Extract important keywords from query (for preservation during compression)
   */
  private extractKeywords(query: string): string[] {
    // Remove common French stopwords and extract meaningful terms
    const stopwords = new Set([
      'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'et', 'ou', 'mais',
      'dans', 'sur', 'pour', 'par', 'avec', 'sans', 'sous', 'est', 'sont',
      'qui', 'que', 'quoi', 'comment', 'quand', 'où', 'quels', 'quelles',
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'what', 'which',
    ]);

    const words = query
      .toLowerCase()
      .replace(/[^\w\s'-]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopwords.has(word));

    // Also extract quoted phrases
    const quotedPhrases = query.match(/"([^"]+)"/g)?.map(p => p.replace(/"/g, '')) || [];

    return [...new Set([...words, ...quotedPhrases])];
  }

  /**
   * Semantic deduplication - Remove chunks that are too similar to each other
   */
  private deduplicateSemanticChunks(chunks: Chunk[], threshold: number): Chunk[] {
    if (chunks.length <= 1) return chunks;

    const kept: Chunk[] = [];
    const removed: string[] = [];

    for (const chunk of chunks) {
      // Check if this chunk is too similar to any already kept chunk
      const isSimilar = kept.some(keptChunk => {
        const similarity = this.calculateTextSimilarity(chunk.content, keptChunk.content);
        return similarity > threshold;
      });

      if (!isSimilar) {
        kept.push(chunk);
      } else {
        removed.push(`${chunk.documentTitle} (p.${chunk.pageNumber})`);
      }
    }

    if (removed.length > 0) {
      console.log(`🗑️  [COMPRESSION] Removed ${removed.length} duplicate chunks (threshold: ${threshold}):`, removed.slice(0, 3));
    }

    return kept;
  }

  /**
   * Calculate text similarity using Jaccard similarity on word sets
   * (Faster than cosine similarity, good enough for deduplication)
   */
  private calculateTextSimilarity(text1: string, text2: string): number {
    const words1 = new Set(text1.toLowerCase().split(/\s+/));
    const words2 = new Set(text2.toLowerCase().split(/\s+/));

    const intersection = new Set([...words1].filter(w => words2.has(w)));
    const union = new Set([...words1, ...words2]);

    return intersection.size / union.size;
  }

  /**
   * Extract only the most relevant sentences from each chunk
   */
  private extractRelevantSentences(
    chunks: Chunk[],
    query: string,
    keywords: string[],
    minRelevanceScore: number
  ): Chunk[] {
    console.log(`✂️  [COMPRESSION] Extracting relevant sentences (min score: ${minRelevanceScore})`);

    const queryLower = query.toLowerCase();
    let totalSentencesKept = 0;
    let totalSentencesRemoved = 0;

    const processed = chunks.map(chunk => {
      const sentences = this.splitIntoSentences(chunk.content);

      // Score each sentence based on keyword presence and position
      const scoredSentences = sentences.map((sentence, index) => {
        const sentenceLower = sentence.toLowerCase();
        let score = 0;

        // Keyword matching (weighted by keyword importance)
        for (const keyword of keywords) {
          if (sentenceLower.includes(keyword.toLowerCase())) {
            score += 1.0;
          }
        }

        // Exact phrase matching (bonus)
        if (sentenceLower.includes(queryLower)) {
          score += 2.0;
        }

        // Position bonus (earlier sentences often more important)
        const positionBonus = Math.max(0, 0.3 - (index * 0.05));
        score += positionBonus;

        // Length penalty (very short sentences less informative)
        if (sentence.length < 50) {
          score *= 0.5;
        }

        return { sentence, score };
      });

      // Keep sentences above threshold, but always keep at least 2 sentences
      const relevantSentences = scoredSentences
        .filter(s => s.score >= minRelevanceScore)
        .map(s => s.sentence);

      // Ensure minimum context (keep top 2 if filter was too aggressive)
      const finalSentences = relevantSentences.length >= 2
        ? relevantSentences
        : scoredSentences
            .sort((a, b) => b.score - a.score)
            .slice(0, 2)
            .map(s => s.sentence);

      totalSentencesKept += finalSentences.length;
      totalSentencesRemoved += sentences.length - finalSentences.length;

      return {
        ...chunk,
        content: finalSentences.join(' '),
      };
    });

    console.log(`📝 [COMPRESSION] Sentence extraction results:`, {
      kept: totalSentencesKept,
      removed: totalSentencesRemoved,
      reduction: `${Math.round((totalSentencesRemoved / (totalSentencesKept + totalSentencesRemoved)) * 100)}%`,
    });

    return processed;
  }

  /**
   * Split text into sentences (handles common abbreviations)
   */
  private splitIntoSentences(text: string): string[] {
    // Simple sentence splitter (handles . ! ?)
    // Preserves common abbreviations like "Dr." "M." "etc."
    return text
      .replace(/([.!?])\s+(?=[A-Z])/g, '$1|')
      .split('|')
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }

  /**
   * Select top-K chunks by similarity score
   */
  private selectTopKChunks(chunks: Chunk[], k: number): Chunk[] {
    console.log(`🎯 [COMPRESSION] Selecting top-${k} chunks by similarity`);

    const sorted = [...chunks].sort((a, b) => b.similarity - a.similarity);
    return sorted.slice(0, k);
  }
}
