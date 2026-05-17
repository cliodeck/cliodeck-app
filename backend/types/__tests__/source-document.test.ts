import { describe, it, expect } from 'vitest';
import {
  fromDocumentChunk,
  fromPDFDocument,
  fromSearchResult,
  isPDFSource,
  toPDFDocument,
  type SourceDocument,
} from '../source-document.js';
import type {
  DocumentChunk,
  PDFDocument,
  SearchResult,
} from '../pdf-document.js';

function makePDF(): PDFDocument {
  return {
    id: 'doc-1',
    fileURL: '/tmp/a.pdf',
    title: 'A',
    author: 'Author',
    year: '1999',
    bibtexKey: 'author1999',
    pageCount: 42,
    metadata: { subject: 'x' } as unknown as PDFDocument['metadata'],
    createdAt: new Date('2024-01-01'),
    indexedAt: new Date('2024-02-01'),
    lastAccessedAt: new Date('2024-03-01'),
    summary: 'short',
    language: 'fr',
    get displayString() {
      return 'A (1999)';
    },
  };
}

function makeChunk(): DocumentChunk {
  return {
    id: 'c-1',
    documentId: 'doc-1',
    content: 'hello',
    pageNumber: 7,
    chunkIndex: 0,
    startPosition: 0,
    endPosition: 5,
    metadata: { sectionType: 'introduction' },
  };
}

describe('SourceDocument type scaffolding (2.4a prep)', () => {
  it('isPDFSource defaults to true when sourceType is absent', () => {
    const d = {
      id: 'x',
      fileURL: '/x',
      title: 't',
      createdAt: new Date(),
      indexedAt: new Date(),
    } as SourceDocument;
    expect(isPDFSource(d)).toBe(true);
  });

  it('fromPDFDocument widens a PDFDocument to a SourceDocument', () => {
    const p = makePDF();
    const s = fromPDFDocument(p);
    expect(s.sourceType).toBe('pdf');
    expect(s.fileFormat).toBe('pdf');
    expect(s.pageCount).toBe(42);
    expect(s.title).toBe('A');
    expect(isPDFSource(s)).toBe(true);
  });

  it('toPDFDocument narrows a PDF-typed SourceDocument back', () => {
    const s = fromPDFDocument(makePDF());
    const p = toPDFDocument(s);
    expect(p.id).toBe('doc-1');
    expect(p.pageCount).toBe(42);
    expect(p.displayString).toMatch(/A/);
  });

  it('toPDFDocument refuses non-PDF sources', () => {
    const s: SourceDocument = {
      id: 'n-1',
      fileURL: '/vault/note.md',
      title: 'Note',
      sourceType: 'obsidian-note',
      createdAt: new Date(),
      indexedAt: new Date(),
    };
    expect(() => toPDFDocument(s)).toThrow(/not a PDF/);
  });

  it('fromDocumentChunk preserves pageNumber and lifts section metadata', () => {
    const c = makeChunk();
    const sc = fromDocumentChunk(c);
    expect(sc.pageNumber).toBe(7);
    expect(sc.sectionType).toBe('introduction');
    expect(sc.id).toBe('c-1');
  });

  it('fromSearchResult bundles widened chunk + document + similarity', () => {
    const r: SearchResult = {
      chunk: makeChunk(),
      document: makePDF(),
      similarity: 0.87,
    };
    const u = fromSearchResult(r);
    expect(u.similarity).toBe(0.87);
    expect(u.chunk.id).toBe('c-1');
    expect(u.document.sourceType).toBe('pdf');
  });
});
