import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VectorStore } from '../core/vector-store/VectorStore';
import type { PDFDocument, DocumentChunk } from '../types/pdf-document';
import * as fs from 'fs';
import * as path from 'path';

describe('VectorStore', () => {
  let vectorStore: VectorStore;
  const testDbPath = path.join(__dirname, 'test-vectors.db');

  beforeEach(() => {
    // Create a test database
    vectorStore = new VectorStore(path.dirname(testDbPath));
  });

  afterEach(() => {
    // Clean up test database
    vectorStore.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('Document operations', () => {
    it('should save and retrieve a document', () => {
      const doc: PDFDocument = {
        id: 'doc-1',
        fileURL: '/test/doc.pdf',
        title: 'Test Document',
        author: 'Test Author',
        year: '2023',
        pageCount: 10,
        metadata: { keywords: [] },
        createdAt: new Date(),
        indexedAt: new Date(),
        lastAccessedAt: new Date(),
        get displayString() {
          return `${this.author} (${this.year})`;
        },
      };

      vectorStore.saveDocument(doc);

      const retrieved = vectorStore.getDocument('doc-1');

      expect(retrieved).toBeDefined();
      expect(retrieved?.title).toBe('Test Document');
      expect(retrieved?.author).toBe('Test Author');
    });

    it('should list all documents', () => {
      const docs: PDFDocument[] = [
        {
          id: 'doc-1',
          fileURL: '/test/doc1.pdf',
          title: 'Document 1',
          pageCount: 5,
          metadata: { keywords: [] },
          createdAt: new Date(),
          indexedAt: new Date(),
          lastAccessedAt: new Date(),
          get displayString() {
            return this.title;
          },
        },
        {
          id: 'doc-2',
          fileURL: '/test/doc2.pdf',
          title: 'Document 2',
          pageCount: 8,
          metadata: { keywords: [] },
          createdAt: new Date(),
          indexedAt: new Date(),
          lastAccessedAt: new Date(),
          get displayString() {
            return this.title;
          },
        },
      ];

      docs.forEach((doc) => vectorStore.saveDocument(doc));

      const allDocs = vectorStore.getAllDocuments();

      expect(allDocs).toHaveLength(2);
    });

    it('should delete a document', () => {
      const doc: PDFDocument = {
        id: 'doc-to-delete',
        fileURL: '/test/doc.pdf',
        title: 'To Delete',
        pageCount: 3,
        metadata: { keywords: [] },
        createdAt: new Date(),
        indexedAt: new Date(),
        lastAccessedAt: new Date(),
        get displayString() {
          return this.title;
        },
      };

      vectorStore.saveDocument(doc);
      expect(vectorStore.getDocument('doc-to-delete')).toBeDefined();

      vectorStore.deleteDocument('doc-to-delete');
      expect(vectorStore.getDocument('doc-to-delete')).toBeNull();
    });
  });

  describe('Chunk operations', () => {
    it('should save and retrieve chunks', () => {
      // First save a document
      const doc: PDFDocument = {
        id: 'doc-1',
        fileURL: '/test/doc.pdf',
        title: 'Test',
        pageCount: 1,
        metadata: { keywords: [] },
        createdAt: new Date(),
        indexedAt: new Date(),
        lastAccessedAt: new Date(),
        get displayString() {
          return this.title;
        },
      };
      vectorStore.saveDocument(doc);

      // Save chunks
      const chunk: DocumentChunk = {
        id: 'chunk-1',
        documentId: 'doc-1',
        content: 'This is test content',
        pageNumber: 1,
        chunkIndex: 0,
        startPosition: 0,
        endPosition: 20,
      };

      const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);
      vectorStore.saveChunk(chunk, embedding);

      const chunks = vectorStore.getChunksForDocument('doc-1');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].chunk.content).toBe('This is test content');
      expect(chunks[0].embedding).toBeDefined();
    });

    it('should CASCADE delete chunks when document is deleted', () => {
      // Create document and chunk
      const doc: PDFDocument = {
        id: 'doc-cascade',
        fileURL: '/test/doc.pdf',
        title: 'Cascade Test',
        pageCount: 1,
        metadata: { keywords: [] },
        createdAt: new Date(),
        indexedAt: new Date(),
        lastAccessedAt: new Date(),
        get displayString() {
          return this.title;
        },
      };
      vectorStore.saveDocument(doc);

      const chunk: DocumentChunk = {
        id: 'chunk-cascade',
        documentId: 'doc-cascade',
        content: 'Content',
        pageNumber: 1,
        chunkIndex: 0,
        startPosition: 0,
        endPosition: 7,
      };
      vectorStore.saveChunk(chunk, new Float32Array([0.1, 0.2]));

      // Verify chunk exists
      expect(vectorStore.getChunksForDocument('doc-cascade')).toHaveLength(1);

      // Delete document
      vectorStore.deleteDocument('doc-cascade');

      // Chunks should be deleted too
      expect(vectorStore.getChunksForDocument('doc-cascade')).toHaveLength(0);
    });
  });

  describe('Vector search', () => {
    it('should search by similarity', () => {
      // Setup documents and chunks
      const doc: PDFDocument = {
        id: 'doc-search',
        fileURL: '/test/doc.pdf',
        title: 'Search Test',
        pageCount: 1,
        metadata: { keywords: [] },
        createdAt: new Date(),
        indexedAt: new Date(),
        lastAccessedAt: new Date(),
        get displayString() {
          return this.title;
        },
      };
      vectorStore.saveDocument(doc);

      const chunks: DocumentChunk[] = [
        {
          id: 'chunk-1',
          documentId: 'doc-search',
          content: 'First chunk',
          pageNumber: 1,
          chunkIndex: 0,
          startPosition: 0,
          endPosition: 11,
        },
        {
          id: 'chunk-2',
          documentId: 'doc-search',
          content: 'Second chunk',
          pageNumber: 1,
          chunkIndex: 1,
          startPosition: 11,
          endPosition: 23,
        },
      ];

      vectorStore.saveChunk(chunks[0], new Float32Array([1.0, 0.0, 0.0]));
      vectorStore.saveChunk(chunks[1], new Float32Array([0.0, 1.0, 0.0]));

      // Search with similar embedding
      const queryEmbedding = new Float32Array([0.9, 0.1, 0.0]);
      const results = vectorStore.search(queryEmbedding, 2);

      expect(results).toHaveLength(2);
      expect(results[0].similarity).toBeGreaterThan(results[1].similarity);
    });

    it('should calculate cosine similarity correctly', () => {
      const doc: PDFDocument = {
        id: 'doc-sim',
        fileURL: '/test/doc.pdf',
        title: 'Similarity Test',
        pageCount: 1,
        metadata: { keywords: [] },
        createdAt: new Date(),
        indexedAt: new Date(),
        lastAccessedAt: new Date(),
        get displayString() {
          return this.title;
        },
      };
      vectorStore.saveDocument(doc);

      // Identical vectors should have similarity = 1.0
      const chunk: DocumentChunk = {
        id: 'chunk-identical',
        documentId: 'doc-sim',
        content: 'Test',
        pageNumber: 1,
        chunkIndex: 0,
        startPosition: 0,
        endPosition: 4,
      };

      const embedding = new Float32Array([1.0, 0.0, 0.0]);
      vectorStore.saveChunk(chunk, embedding);

      const results = vectorStore.search(embedding, 1);

      expect(results[0].similarity).toBeCloseTo(1.0, 5);
    });
  });

  describe('Statistics and maintenance', () => {
    it('should return correct statistics', () => {
      const doc: PDFDocument = {
        id: 'doc-stats',
        fileURL: '/test/doc.pdf',
        title: 'Stats Test',
        pageCount: 1,
        metadata: { keywords: [] },
        createdAt: new Date(),
        indexedAt: new Date(),
        lastAccessedAt: new Date(),
        get displayString() {
          return this.title;
        },
      };
      vectorStore.saveDocument(doc);

      const chunk: DocumentChunk = {
        id: 'chunk-stats',
        documentId: 'doc-stats',
        content: 'Test',
        pageNumber: 1,
        chunkIndex: 0,
        startPosition: 0,
        endPosition: 4,
      };
      vectorStore.saveChunk(chunk, new Float32Array([0.1]));

      const stats = vectorStore.getStatistics();

      expect(stats.documentCount).toBe(1);
      expect(stats.chunkCount).toBe(1);
    });

    it('should verify integrity', () => {
      const integrity = vectorStore.verifyIntegrity();

      expect(integrity.orphanedChunks).toBe(0);
      expect(integrity.totalChunks).toBeGreaterThanOrEqual(0);
    });
  });
});
