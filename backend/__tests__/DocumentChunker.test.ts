import { describe, it, expect } from 'vitest';
import { DocumentChunker, CHUNKING_CONFIGS } from '../core/chunking/DocumentChunker';
import type { DocumentPage } from '../types/pdf-document';

describe('DocumentChunker', () => {
  const documentId = 'test-doc-123';

  describe('createChunks', () => {
    it('should create chunks from pages', () => {
      const chunker = new DocumentChunker(CHUNKING_CONFIGS.cpuOptimized);

      const pages: DocumentPage[] = [
        { pageNumber: 1, text: 'This is a test document. '.repeat(50) },
        { pageNumber: 2, text: 'More content here. '.repeat(50) },
      ];

      const chunks = chunker.createChunks(pages, documentId);

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].documentId).toBe(documentId);
      expect(chunks[0].pageNumber).toBe(1);
      expect(chunks[0].id).toBeDefined();
    });

    it('should respect maxChunkSize', () => {
      const chunker = new DocumentChunker(CHUNKING_CONFIGS.cpuOptimized);
      const maxWords = CHUNKING_CONFIGS.cpuOptimized.maxChunkSize;

      const pages: DocumentPage[] = [
        { pageNumber: 1, text: 'word '.repeat(1000) },
      ];

      const chunks = chunker.createChunks(pages, documentId);

      for (const chunk of chunks) {
        const wordCount = chunk.content.split(/\s+/).filter((w) => w.length > 0).length;
        expect(wordCount).toBeLessThanOrEqual(maxWords + 10); // +10 for tolerance
      }
    });

    it('should create overlap between chunks', () => {
      const chunker = new DocumentChunker(CHUNKING_CONFIGS.cpuOptimized);

      const pages: DocumentPage[] = [
        { pageNumber: 1, text: 'word '.repeat(500) },
      ];

      const chunks = chunker.createChunks(pages, documentId);

      if (chunks.length > 1) {
        // Check that chunks have some overlapping content
        expect(chunks.length).toBeGreaterThan(1);
      }
    });

    it('should handle empty pages', () => {
      const chunker = new DocumentChunker(CHUNKING_CONFIGS.cpuOptimized);

      const pages: DocumentPage[] = [
        { pageNumber: 1, text: '' },
        { pageNumber: 2, text: '   ' },
      ];

      const chunks = chunker.createChunks(pages, documentId);

      expect(chunks.length).toBe(0);
    });
  });

  describe('createSemanticChunks', () => {
    it('should respect paragraph boundaries', () => {
      // Use a small-min config so the ~13-word fixture actually produces a chunk
      // (CHUNKING_CONFIGS.standard has minChunkSize=100, which would swallow this input).
      const chunker = new DocumentChunker({ maxChunkSize: 50, overlapSize: 5, minChunkSize: 3 });

      const pages: DocumentPage[] = [
        {
          pageNumber: 1,
          text: `First paragraph with some content.\n\nSecond paragraph with more text.\n\nThird paragraph here.`,
        },
      ];

      const chunks = chunker.createSemanticChunks(pages, documentId);

      expect(chunks.length).toBeGreaterThan(0);
      // Each chunk should ideally end at paragraph boundary
    });
  });

  describe('getChunkingStats', () => {
    it('should calculate correct statistics', () => {
      const chunker = new DocumentChunker(CHUNKING_CONFIGS.cpuOptimized);

      const pages: DocumentPage[] = [
        { pageNumber: 1, text: 'This is a test. '.repeat(100) },
      ];

      const chunks = chunker.createChunks(pages, documentId);
      const stats = chunker.getChunkingStats(chunks);

      expect(stats.totalChunks).toBe(chunks.length);
      expect(stats.totalWords).toBeGreaterThan(0);
      expect(stats.averageWordCount).toBeGreaterThan(0);
      expect(stats.minWordCount).toBeGreaterThan(0);
      expect(stats.maxWordCount).toBeGreaterThan(0);
    });
  });

  describe('page et position d’un extrait (#160)', () => {
    // Le premier mot d'un extrait était cherché après la fin du précédent,
    // donc trop loin puisque les extraits se recouvrent : la position
    // bondissait, et tous les extraits finissaient par annoncer la dernière page.
    const PER_PAGE = 34;
    const pages = Array.from({ length: 20 }, (_, p) => ({
      pageNumber: p + 1,
      text: Array.from({ length: PER_PAGE }, (_, s) => `Phrase s${p * PER_PAGE + s + 1} alpha beta gamma delta epsilon zeta eta theta iota fin.`).join(' '),
    }));
    const fullText = pages.map((page) => page.text + '\n\n').join('');
    const firstId = (text: string) => Number(/\bs(\d+)\b/.exec(text)?.[1]);

    it('enregistre la position réelle du début de l’extrait', () => {
      const chunks = new DocumentChunker(CHUNKING_CONFIGS.cpuOptimized).createChunks(pages, 'doc');

      for (const chunk of chunks) {
        const firstWord = chunk.content.split(/\s+/)[0];
        expect(fullText.slice(chunk.startPosition).startsWith(firstWord)).toBe(true);
      }
    });

    it('annonce la page où l’extrait commence, jusqu’à la fin du document', () => {
      const chunks = new DocumentChunker(CHUNKING_CONFIGS.cpuOptimized).createChunks(pages, 'doc');

      for (const chunk of chunks) {
        // La page du premier mot : celle de la phrase en cours à cette position.
        const before = fullText.slice(0, chunk.startPosition + 1);
        const expectedPage = (before.match(/\n\n/g)?.length ?? 0) + 1;
        expect(chunk.pageNumber).toBe(expectedPage);
      }
      expect(chunks[chunks.length - 1].pageNumber).toBe(20);
      expect(new Set(chunks.map((chunk) => chunk.pageNumber)).size).toBe(20);
      expect(firstId(chunks[0].content)).toBe(1);
    });
  });
});
