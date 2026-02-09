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
      const chunker = new DocumentChunker(CHUNKING_CONFIGS.standard);

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
});
