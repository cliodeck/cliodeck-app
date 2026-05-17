import { describe, it, expect } from 'vitest';
import {
  brainstormSourceToUnified,
  chatSourceToUnified,
  type UnifiedSource,
} from '../chat-source';

describe('chatSourceToUnified (legacy PDF-centric)', () => {
  it('maps the required fields and stamps kind:pdf', () => {
    const u = chatSourceToUnified({
      documentId: 'doc-1',
      documentTitle: 'La Grande Guerre',
      pageNumber: 42,
      chunkContent: 'extrait…',
      similarity: 0.87,
    });
    expect(u.kind).toBe('pdf');
    expect(u.id).toBe('doc-1');
    expect(u.title).toBe('La Grande Guerre');
    expect(u.documentId).toBe('doc-1');
    expect(u.pageNumber).toBe(42);
    expect(u.snippet).toBe('extrait…');
    expect(u.score).toBeCloseTo(0.87);
  });

  it('propagates optional bibliographic fields', () => {
    const u = chatSourceToUnified({
      documentId: 'd',
      documentTitle: 't',
      author: 'Bloch, M.',
      year: '1949',
      pageNumber: 1,
      chunkContent: 'c',
      similarity: 0.1,
    });
    expect(u.author).toBe('Bloch, M.');
    expect(u.year).toBe('1949');
  });
});

describe('brainstormSourceToUnified', () => {
  it('maps a primary (archive) hit with itemId as id', () => {
    const u = brainstormSourceToUnified({
      kind: 'archive',
      sourceType: 'primary',
      title: 'Lettre de 1914',
      snippet: 's',
      similarity: 0.77,
      itemId: 'tropy-123',
      imagePath: '/p/1.jpg',
    });
    expect(u.kind).toBe('primary');
    expect(u.id).toBe('tropy-123');
    expect(u.itemId).toBe('tropy-123');
    expect(u.imagePath).toBe('/p/1.jpg');
    expect(u.score).toBeCloseTo(0.77);
  });

  it('maps a secondary (bibliographie) hit with documentId + pageNumber', () => {
    const u = brainstormSourceToUnified({
      kind: 'bibliographie',
      sourceType: 'secondary',
      title: 'Article',
      snippet: 's',
      similarity: 0.5,
      documentId: 'doc-9',
      pageNumber: 12,
      chunkOffset: 320,
    });
    expect(u.kind).toBe('secondary');
    expect(u.id).toBe('doc-9');
    expect(u.pageNumber).toBe(12);
    expect(u.chunkOffset).toBe(320);
  });

  it('maps a vault (note) hit, merging relativePath into notePath', () => {
    const u = brainstormSourceToUnified({
      kind: 'note',
      sourceType: 'vault',
      title: 'Fiche Jaurès',
      snippet: 's',
      similarity: 0.42,
      relativePath: 'Notes/Jaures.md',
      lineNumber: 7,
    });
    expect(u.kind).toBe('vault');
    expect(u.id).toBe('Notes/Jaures.md');
    expect(u.notePath).toBe('Notes/Jaures.md');
    expect(u.lineNumber).toBe(7);
  });

  it('leaves optional fields undefined when absent', () => {
    const u: UnifiedSource = brainstormSourceToUnified({
      kind: 'bibliographie',
      sourceType: 'secondary',
      title: 't',
      snippet: '',
      similarity: 0,
    });
    expect(u.documentId).toBeUndefined();
    expect(u.pageNumber).toBeUndefined();
    expect(u.author).toBeUndefined();
    expect(u.explanation).toBeUndefined();
  });
});
