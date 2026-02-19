import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextCompressor } from '../ContextCompressor';

// Suppress console.log during tests
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

function makeChunk(content: string, overrides: Partial<{
  documentId: string;
  documentTitle: string;
  pageNumber: number;
  similarity: number;
  embedding: number[];
}> = {}) {
  return {
    content,
    documentId: overrides.documentId ?? 'doc-1',
    documentTitle: overrides.documentTitle ?? 'Test Document',
    pageNumber: overrides.pageNumber ?? 1,
    similarity: overrides.similarity ?? 0.9,
    embedding: overrides.embedding,
  };
}

function makeChunksOfSize(totalChars: number, chunkCount: number): ReturnType<typeof makeChunk>[] {
  const charsPerChunk = Math.ceil(totalChars / chunkCount);
  return Array.from({ length: chunkCount }, (_, i) =>
    makeChunk('A'.repeat(charsPerChunk), {
      documentId: `doc-${i}`,
      documentTitle: `Document ${i}`,
      pageNumber: i + 1,
      similarity: 0.95 - i * 0.05,
    }),
  );
}

describe('ContextCompressor', () => {
  let compressor: ContextCompressor;

  beforeEach(() => {
    compressor = new ContextCompressor();
  });

  describe('compress()', () => {
    it('returns chunks unchanged when total size <= 10000 (none-small strategy)', () => {
      const chunks = [
        makeChunk('Short chunk content about history.'),
        makeChunk('Another short chunk about World War II.'),
      ];

      const result = compressor.compress(chunks, 'World War II');

      expect(result.stats.strategy).toBe('none-small');
      expect(result.stats.reductionPercent).toBe(0);
      expect(result.chunks.length).toBe(2);
      expect(result.chunks).toEqual(chunks);
    });

    it('applies light-deduplication for 15k-25k char contexts', () => {
      // Create chunks totaling ~18000 chars, some duplicated
      const uniqueContent1 = 'The French Revolution began in 1789. ' + 'X'.repeat(4000);
      const uniqueContent2 = 'Napoleon crowned himself emperor in 1804. ' + 'Y'.repeat(4000);
      const duplicateContent = 'The French Revolution began in 1789. ' + 'X'.repeat(4000); // same as #1

      const chunks = [
        makeChunk(uniqueContent1, { documentTitle: 'Doc A', pageNumber: 1 }),
        makeChunk(uniqueContent2, { documentTitle: 'Doc B', pageNumber: 2 }),
        makeChunk(duplicateContent, { documentTitle: 'Doc C', pageNumber: 3 }),
        makeChunk('Z'.repeat(6000), { documentTitle: 'Doc D', pageNumber: 4 }),
      ];

      const result = compressor.compress(chunks, 'French Revolution');

      expect(result.stats.strategy).toBe('light-deduplication');
      // The duplicate should have been removed
      expect(result.chunks.length).toBeLessThan(chunks.length);
    });

    it('applies medium-dedup-extraction for 25k-35k char contexts', () => {
      const chunks = makeChunksOfSize(30000, 6);

      const result = compressor.compress(chunks, 'test query keywords');

      expect(result.stats.strategy).toBe('medium-dedup-extraction');
      expect(result.stats.originalSize).toBeGreaterThan(25000);
    });

    it('applies aggressive-full for >35k char contexts', () => {
      const chunks = makeChunksOfSize(40000, 8);

      const result = compressor.compress(chunks, 'test query');

      expect(result.stats.strategy).toBe('aggressive-full');
      expect(result.stats.compressedSize).toBeLessThan(result.stats.originalSize);
    });

    it('reports accurate stats', () => {
      const chunks = [makeChunk('Hello world')];
      const result = compressor.compress(chunks, 'test');

      expect(result.stats.originalChunks).toBe(1);
      expect(result.stats.compressedChunks).toBe(1);
      expect(result.stats.originalSize).toBe(11);
      expect(result.stats.compressedSize).toBe(11);
    });

    it('handles empty chunks array', () => {
      const result = compressor.compress([], 'test query');

      expect(result.chunks).toEqual([]);
      expect(result.stats.originalSize).toBe(0);
      expect(result.stats.strategy).toBe('none-small');
    });

    it('respects maxChars parameter', () => {
      // Create a very large context that needs aggressive compression
      const chunks = makeChunksOfSize(50000, 10);
      const maxChars = 15000;

      const result = compressor.compress(chunks, 'test query', maxChars);

      expect(result.stats.strategy).toBe('aggressive-full');
    });
  });

  describe('extractKeywords()', () => {
    // Access private method for testing
    const getKeywords = (query: string) => {
      return (compressor as any)['extractKeywords'](query);
    };

    it('extracts meaningful words from query', () => {
      const keywords = getKeywords('What is the history of World War II?');
      expect(keywords).toContain('history');
      expect(keywords).toContain('world');
      expect(keywords).toContain('war');
    });

    it('filters out French stopwords', () => {
      const keywords = getKeywords('Quels sont les impacts de la Révolution française?');
      expect(keywords).not.toContain('les');
      expect(keywords).not.toContain('de');
      expect(keywords).not.toContain('la');
      expect(keywords).toContain('impacts');
    });

    it('filters out English stopwords', () => {
      const keywords = getKeywords('What is the meaning of this document?');
      expect(keywords).not.toContain('the');
      expect(keywords).not.toContain('of');
      expect(keywords).not.toContain('is');
      expect(keywords).toContain('meaning');
      expect(keywords).toContain('document');
    });

    it('filters out words with 2 or fewer characters', () => {
      const keywords = getKeywords('I am at a big house');
      expect(keywords).not.toContain('am');
      expect(keywords).not.toContain('at');
      expect(keywords).toContain('big');
      expect(keywords).toContain('house');
    });

    it('extracts quoted phrases', () => {
      const keywords = getKeywords('Find documents about "World War II" and "Cold War"');
      expect(keywords).toContain('World War II');
      expect(keywords).toContain('Cold War');
    });

    it('returns unique keywords', () => {
      const keywords = getKeywords('history history history');
      const unique = [...new Set(keywords)];
      expect(keywords.length).toBe(unique.length);
    });
  });

  describe('deduplicateSemanticChunks()', () => {
    const deduplicate = (chunks: any[], threshold: number) => {
      return (compressor as any)['deduplicateSemanticChunks'](chunks, threshold);
    };

    it('removes chunks with high text similarity', () => {
      const chunks = [
        makeChunk('The quick brown fox jumps over the lazy dog'),
        makeChunk('The quick brown fox jumps over the lazy dog'), // exact duplicate
        makeChunk('Something completely different about quantum physics'),
      ];

      const result = deduplicate(chunks, 0.85);
      expect(result.length).toBe(2);
    });

    it('keeps all chunks when they are dissimilar', () => {
      const chunks = [
        makeChunk('The French Revolution changed European politics forever.'),
        makeChunk('Quantum computing uses qubits instead of classical bits.'),
        makeChunk('Marine biology studies organisms living in the ocean.'),
      ];

      const result = deduplicate(chunks, 0.85);
      expect(result.length).toBe(3);
    });

    it('handles single chunk', () => {
      const chunks = [makeChunk('Only one chunk here')];
      const result = deduplicate(chunks, 0.85);
      expect(result.length).toBe(1);
    });

    it('handles empty array', () => {
      const result = deduplicate([], 0.85);
      expect(result.length).toBe(0);
    });
  });

  describe('selectTopKChunks()', () => {
    const selectTopK = (chunks: any[], k: number) => {
      return (compressor as any)['selectTopKChunks'](chunks, k);
    };

    it('selects chunks with highest similarity scores', () => {
      const chunks = [
        makeChunk('Low similarity', { similarity: 0.3 }),
        makeChunk('High similarity', { similarity: 0.95 }),
        makeChunk('Medium similarity', { similarity: 0.7 }),
        makeChunk('Very high similarity', { similarity: 0.99 }),
      ];

      const result = selectTopK(chunks, 2);
      expect(result.length).toBe(2);
      expect(result[0].similarity).toBe(0.99);
      expect(result[1].similarity).toBe(0.95);
    });

    it('returns all chunks when k >= chunk count', () => {
      const chunks = [
        makeChunk('A', { similarity: 0.5 }),
        makeChunk('B', { similarity: 0.8 }),
      ];

      const result = selectTopK(chunks, 5);
      expect(result.length).toBe(2);
    });
  });

  describe('calculateTextSimilarity()', () => {
    const calcSimilarity = (a: string, b: string) => {
      return (compressor as any)['calculateTextSimilarity'](a, b);
    };

    it('returns 1 for identical texts', () => {
      expect(calcSimilarity('hello world', 'hello world')).toBe(1);
    });

    it('returns 0 for completely different texts', () => {
      expect(calcSimilarity('aaa bbb ccc', 'xxx yyy zzz')).toBe(0);
    });

    it('returns a value between 0 and 1 for partially similar texts', () => {
      const sim = calcSimilarity('the quick brown fox', 'the slow brown fox');
      expect(sim).toBeGreaterThan(0);
      expect(sim).toBeLessThan(1);
    });
  });

  describe('splitIntoSentences()', () => {
    const splitSentences = (text: string) => {
      return (compressor as any)['splitIntoSentences'](text);
    };

    it('splits text at sentence boundaries', () => {
      const sentences = splitSentences('First sentence. Second sentence. Third one.');
      expect(sentences.length).toBe(3);
    });

    it('handles question marks and exclamation marks', () => {
      const sentences = splitSentences('Is this a question? Yes it is! Good.');
      expect(sentences.length).toBe(3);
    });

    it('returns empty array for empty string', () => {
      const sentences = splitSentences('');
      expect(sentences.length).toBe(0);
    });
  });
});
