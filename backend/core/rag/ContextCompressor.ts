/**
 * ContextCompressor - Intelligent chunk compression for RAG
 *
 * Implements multi-strategy compression:
 * 1. Near-duplicate removal — Jaccard LEXICAL sur les mots (pas
 *    d'embeddings), limité au MÊME document : les fenêtres de chunking
 *    qui se chevauchent sont des doublons, un même passage cité par deux
 *    documents différents est une corroboration qu'on garde.
 * 2. Relevance-based sentence extraction (keep only relevant sentences)
 * 3. Hierarchical compression (adapt strategy based on size)
 * 4. Keyword preservation (always keep sentences with query terms)
 */

interface Chunk {
  content: string;
  /** Identifiant du document d'origine — porte la dédup intra-document. */
  documentId: string;
  documentTitle: string;
  pageNumber: number;
  similarity: number;
  /**
   * Clé de correspondance opaque pour l'appelant (ex. index du hit
   * d'origine) — transportée telle quelle, jamais interprétée ici.
   */
  key?: string;
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

    // Level 1: Light compression (10k-25k chars) - deduplication only.
    // (Couvre l'ancienne zone morte 10-15k, où aucun niveau ne
    // s'appliquait alors que les stats annonçaient une stratégie.)
    if (originalSize <= 25000) {
      strategy = 'light-deduplication';
      console.log('📊 [COMPRESSION] Applying Level 1: Light near-duplicate removal (threshold: 0.88)');
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

    // \p{L}/\p{N} et non \w : \w est ASCII et mutilait les termes
    // accentués (« mémoire » → « moire », « été » disparaissait) — fatal
    // pour la préservation par mots-clés dans une app francophone.
    const words = query
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopwords.has(word));

    // Also extract quoted phrases
    const quotedPhrases = query.match(/"([^"]+)"/g)?.map(p => p.replace(/"/g, '')) || [];

    return [...new Set([...words, ...quotedPhrases])];
  }

  /**
   * Near-duplicate removal (Jaccard lexical), INTRA-DOCUMENT uniquement.
   * Les fenêtres de chunking qui se chevauchent produisent des doublons au
   * sein d'un même document ; un même passage cité par deux documents
   * différents est une corroboration — on la garde (et elle reste visible
   * dans le panneau de sources, aligné sur le prompt).
   */
  private deduplicateSemanticChunks(chunks: Chunk[], threshold: number): Chunk[] {
    if (chunks.length <= 1) return chunks;

    const kept: Chunk[] = [];
    const removed: string[] = [];

    for (const chunk of chunks) {
      // Trop proche d'un chunk déjà retenu DU MÊME document ?
      const isSimilar = kept.some(keptChunk => {
        if (keptChunk.documentId !== chunk.documentId) return false;
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
   * Split text into sentences (handles common abbreviations).
   *
   * Deux pièges des textes historiques français, vérifiés empiriquement :
   * les abréviations (« M. Clemenceau » était coupé en deux, et le
   * fragment « Selon M. » — court donc pénalisé — était jeté, détachant
   * les noms de leurs attributions) et les majuscules accentuées
   * (« . Épuisée » ne coupait pas car [A-Z] ignore É/À).
   */
  private splitIntoSentences(text: string): string[] {
    // Protéger les abréviations courantes (adressage, historiographie)
    // avant le découpage : leur point n'est pas une fin de phrase.
    const ABBREVIATIONS =
      /\b(M|MM|Mme|Mlle|Dr|Pr|St|Ste|etc|cf|p|pp|vol|no|art|chap|fig|éd|ibid|op|loc|trad|ms|mss|fol|t)\.\s+/g;
    const SENTINEL = '\u0000';
    const protectedText = text.replace(ABBREVIATIONS, (m) =>
      m.replace(/\.\s+$/, `.${SENTINEL}`)
    );

    return protectedText
      .replace(/([.!?])\s+(?=\p{Lu})/gu, '$1|')
      .split('|')
      .map(s => s.split(SENTINEL).join(' ').trim())
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
