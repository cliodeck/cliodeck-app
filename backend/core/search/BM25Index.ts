import natural from 'natural';
import type { DocumentChunk } from '../../types/pdf-document';
import { tokenize } from '../text/normalize';

const { TfIdf } = natural;

/**
 * Le découpage de l'index et celui de la requête : le même, sinon un mot n'est jamais retrouvé.
 * `natural` reçoit un tableau de jetons, jamais une chaîne : avec une chaîne, il la redécoupait
 * avec son propre tokeniseur, qui coupe un mot sur chaque lettre accentuée (« Liège » → « li »,
 * « ge »), et n'appliquait sa liste de mots vides anglais qu'aux extraits.
 */
const tokensOf = (text: string): string[] => tokenize(text, { fold: 'diacritics', stopwords: true });

/** Clé que `natural` ajoute à chaque document : ce n'est pas un terme. */
const NATURAL_KEY = '__key';

const hasTerm = (doc: object, term: string): boolean =>
  Object.prototype.hasOwnProperty.call(doc, term);

/**
 * BM25 Index for keyword-based search
 *
 * BM25 is a probabilistic ranking function that scores documents based on
 * term frequency (TF) and inverse document frequency (IDF).
 *
 * Memory footprint: ~50-100 MB for 50k chunks
 * Search time: O(k) where k = number of query terms (very fast)
 *
 * Best for:
 * - Exact keyword matching
 * - Technical terms, proper nouns
 * - Multi-word phrases
 * - Queries with rare/specific words
 */
export class BM25Index {
  private tfidf: InstanceType<typeof TfIdf>;
  private chunkMap: Map<number, DocumentChunk>;
  /** Nombre de jetons de chaque document, par rang dans `tfidf.documents`. */
  private docLengths: number[] = [];
  private k1: number = 1.5; // Term frequency saturation parameter
  private b: number = 0.75; // Length normalization parameter

  // Performance optimization: cache IDF values
  private idfCache: Map<string, number> = new Map();
  private avgDocLength: number = 0;
  private isDirty: boolean = true; // Track if cache needs update

  constructor() {
    this.tfidf = new TfIdf();
    this.chunkMap = new Map();
  }

  /**
   * Add a chunk to the index
   */
  addChunk(chunk: DocumentChunk): void {
    const docIndex = this.tfidf.documents.length;
    const tokens = tokensOf(chunk.content);
    this.tfidf.addDocument(tokens);
    this.docLengths[docIndex] = tokens.length;
    this.chunkMap.set(docIndex, chunk);
    this.isDirty = true; // Mark cache as dirty
  }

  /**
   * Batch add chunks (more efficient)
   */
  addChunks(chunks: DocumentChunk[]): void {
    console.log(`📥 Adding ${chunks.length} chunks to BM25 index...`);
    const startTime = Date.now();

    for (const chunk of chunks) {
      this.addChunk(chunk);
    }

    const duration = Date.now() - startTime;
    console.log(
      `✅ BM25 index built in ${duration}ms (${Math.round(chunks.length / (duration / 1000))} chunks/s)`
    );
  }

  /**
   * Search for chunks matching query
   */
  search(query: string, k: number = 10, documentIds?: string[]): BM25Result[] {
    // Un terme répété dans la question ne compte qu'une fois.
    const queryTerms = Array.from(new Set(tokensOf(query)));

    if (queryTerms.length === 0) {
      return [];
    }

    // Update cache if needed (once per search, not per term!)
    if (this.isDirty) {
      this.updateCache();
    }

    const scores: Array<{ index: number; score: number; chunk: DocumentChunk }> = [];
    // Un ensemble : `includes` reparcourait la sélection pour chaque extrait du corpus.
    const allowed = documentIds ? new Set(documentIds) : null;

    // Calculate BM25 score for each document
    this.chunkMap.forEach((chunk, docIndex) => {
      // Filter by document IDs if provided
      if (allowed && !allowed.has(chunk.documentId)) {
        return;
      }

      let score = 0;
      const doc = this.tfidf.documents[docIndex];
      const docLength = this.docLengths[docIndex];

      for (const term of queryTerms) {
        // Un terme absent ne doit pas lire une propriété héritée (« constructor » rendait une
        // fonction, et le score NaN faisait disparaître l'extrait).
        if (!hasTerm(doc, term)) continue;
        const tf = doc[term];

        const idf = this.idfCache.get(term) || 0;

        // BM25 formula
        const numerator = tf * (this.k1 + 1);
        const denominator =
          tf + this.k1 * (1 - this.b + this.b * (docLength / this.avgDocLength));
        score += idf * (numerator / denominator);
      }

      if (score > 0) {
        scores.push({ index: docIndex, score, chunk });
      }
    });

    // Sort by score descending and take top k
    return scores
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((result) => ({
        chunk: result.chunk,
        score: result.score,
      }));
  }

  /**
   * Update IDF cache and average doc length (called once when cache is dirty)
   */
  private updateCache(): void {
    const startTime = Date.now();
    this.idfCache.clear();

    const N = this.tfidf.documents.length;
    if (N === 0) {
      this.avgDocLength = 0;
      this.isDirty = false;
      return;
    }

    // Build term document frequency map
    const termDocFreq = new Map<string, number>();
    let totalLength = 0;

    this.tfidf.documents.forEach((doc, docIndex) => {
      totalLength += this.docLengths[docIndex];

      // Track which terms appear in this document
      for (const term in doc) {
        if (term === NATURAL_KEY) continue;
        termDocFreq.set(term, (termDocFreq.get(term) || 0) + 1);
      }
    });

    // Calculate average document length
    this.avgDocLength = totalLength / N;

    // Calculate IDF for all terms
    for (const [term, df] of termDocFreq.entries()) {
      // IDF formula: log((N - df + 0.5) / (df + 0.5))
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      this.idfCache.set(term, idf);
    }

    this.isDirty = false;

    const duration = Date.now() - startTime;
    console.log(`✅ BM25 cache updated: ${this.idfCache.size} terms indexed in ${duration}ms`);
  }

  /**
   * Get average document length (from cache)
   */
  private getAverageDocLength(): number {
    if (this.isDirty) {
      this.updateCache();
    }
    return this.avgDocLength;
  }

  /**
   * Clear the index
   */
  clear(): void {
    this.tfidf = new TfIdf();
    this.docLengths = [];
    this.chunkMap.clear();
    this.idfCache.clear();
    this.avgDocLength = 0;
    this.isDirty = true;
  }

  /**
   * Get index size
   */
  getSize(): number {
    return this.chunkMap.size;
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalChunks: number;
    vocabularySize: number;
    averageDocLength: number;
  } {
    const vocabSet = new Set<string>();

    for (const doc of this.tfidf.documents) {
      for (const term in doc) {
        if (term !== NATURAL_KEY) vocabSet.add(term);
      }
    }

    return {
      totalChunks: this.chunkMap.size,
      vocabularySize: vocabSet.size,
      averageDocLength: this.getAverageDocLength(),
    };
  }
}

export interface BM25Result {
  chunk: DocumentChunk;
  score: number;
}
