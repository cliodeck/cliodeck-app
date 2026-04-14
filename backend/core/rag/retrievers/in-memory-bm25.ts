/**
 * In-memory BM25 retriever for the RAG benchmark harness.
 *
 * Self-contained, dependency-free — implements Okapi BM25 over a list of
 * `BenchmarkDoc.chunks`. Useful as:
 *   - a deterministic baseline for `cliodeck rag-benchmark` on user
 *     corpora that don't (yet) need a live embedding provider.
 *   - the lexical leg of any future hybrid retriever built for Path A
 *     equivalence testing (the dense leg is gated on Ollama / cloud
 *     embeddings, which isn't suitable for unit tests).
 *
 * Tokenisation is intentionally simple (lowercase, split on non-letter
 * unicode, drop tokens shorter than 2 chars) to stay reproducible across
 * platforms. If a project needs richer tokenisation (stemming, language-
 * specific stop words), pass it in via `tokenize` instead of forking.
 */

import type { BenchmarkHit, Retriever } from '../benchmark.js';

export interface BM25Options {
  k1?: number;
  b?: number;
  /** Custom tokeniser. Default: lowercase + unicode letter split. */
  tokenize?: (text: string) => string[];
}

const defaultTokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);

interface IndexedChunk {
  id: string;
  tokens: string[];
  termFreq: Map<string, number>;
  length: number;
}

export function inMemoryBM25Retriever(opts: BM25Options = {}): Retriever {
  const k1 = opts.k1 ?? 1.5;
  const b = opts.b ?? 0.75;
  const tokenize = opts.tokenize ?? defaultTokenize;

  let chunks: IndexedChunk[] = [];
  let avgLength = 0;
  /** documentFrequency[term] = number of chunks containing the term. */
  const docFreq = new Map<string, number>();

  return {
    async index(docs) {
      chunks = [];
      docFreq.clear();
      let totalLen = 0;
      for (const d of docs) {
        for (const c of d.chunks) {
          const tokens = tokenize(c.content);
          const tf = new Map<string, number>();
          for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
          chunks.push({
            id: c.id,
            tokens,
            termFreq: tf,
            length: tokens.length,
          });
          for (const term of tf.keys()) {
            docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
          }
          totalLen += tokens.length;
        }
      }
      avgLength = chunks.length ? totalLen / chunks.length : 0;
    },

    async search(queryText, topK) {
      const queryTokens = tokenize(queryText);
      if (queryTokens.length === 0 || chunks.length === 0) return [];
      const N = chunks.length;

      const scored: BenchmarkHit[] = [];
      for (const c of chunks) {
        let score = 0;
        for (const qt of queryTokens) {
          const df = docFreq.get(qt) ?? 0;
          if (df === 0) continue;
          const tf = c.termFreq.get(qt) ?? 0;
          if (tf === 0) continue;
          // Standard Okapi BM25 IDF (with the +1 inside log to avoid negatives).
          const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
          const norm = 1 - b + b * (c.length / (avgLength || 1));
          score += idf * ((tf * (k1 + 1)) / (tf + k1 * norm));
        }
        if (score > 0) scored.push({ chunkId: c.id, score });
      }
      return scored.sort((a, b2) => b2.score - a.score).slice(0, topK);
    },
  };
}
