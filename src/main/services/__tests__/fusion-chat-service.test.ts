import { describe, it, expect } from 'vitest';
import { hitsToSources } from '../fusion-chat-service.js';
import type { MultiSourceSearchResult } from '../retrieval-service.js';

describe('hitsToSources', () => {
  it('returns an empty array for empty input', () => {
    expect(hitsToSources([])).toEqual([]);
  });

  it('labels secondary hits as bibliographie', () => {
    const hits: MultiSourceSearchResult[] = [
      {
        sourceType: 'secondary',
        chunk: { id: 'c1', content: 'Hello world', documentId: 'd1', chunkIndex: 0 },
        document: { id: 'd1', title: 'Some Paper', author: 'X', bibtexKey: 'x2024' },
        similarity: 0.9,
      } as unknown as MultiSourceSearchResult,
    ];
    const out = hitsToSources(hits);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'bibliographie',
      sourceType: 'secondary',
      title: 'Some Paper',
      snippet: 'Hello world',
      similarity: 0.9,
    });
    expect(out[0].relativePath).toBeUndefined();
  });

  it('labels primary hits as archive', () => {
    const hits: MultiSourceSearchResult[] = [
      {
        sourceType: 'primary',
        chunk: { id: 'c2', content: 'Archive text', documentId: 'p1', chunkIndex: 0 },
        document: { id: 'p1', title: 'Lettre 1914', author: 'Foch', bibtexKey: null },
        source: undefined,
        similarity: 0.7,
      } as unknown as MultiSourceSearchResult,
    ];
    expect(hitsToSources(hits)[0].kind).toBe('archive');
  });

  it('labels vault hits as note and preserves relativePath', () => {
    const hits: MultiSourceSearchResult[] = [
      {
        sourceType: 'vault',
        chunk: { id: 'c3', content: 'Note content', documentId: 'n1', chunkIndex: 0 },
        document: { id: 'n1', title: 'My Note', author: null, bibtexKey: null },
        source: {
          kind: 'obsidian-note',
          relativePath: 'research/note1.md',
          noteId: 'n1',
        },
        similarity: 0.42,
      } as unknown as MultiSourceSearchResult,
    ];
    const out = hitsToSources(hits);
    expect(out[0].kind).toBe('note');
    expect(out[0].relativePath).toBe('research/note1.md');
    expect(out[0].title).toBe('My Note');
  });

  it('falls back to relativePath for title when document.title is missing', () => {
    const hits: MultiSourceSearchResult[] = [
      {
        sourceType: 'vault',
        chunk: { id: 'c4', content: 'body', documentId: 'n2', chunkIndex: 0 },
        document: { id: 'n2', title: undefined, author: null, bibtexKey: null },
        source: {
          kind: 'obsidian-note',
          relativePath: 'folder/untitled.md',
          noteId: 'n2',
        },
        similarity: 0.1,
      } as unknown as MultiSourceSearchResult,
    ];
    expect(hitsToSources(hits)[0].title).toBe('folder/untitled.md');
  });

  it('collapses whitespace and truncates snippet to 400 chars', () => {
    const content = 'alpha\n\nbeta   gamma\t\tdelta ' + 'x'.repeat(1000);
    const hits: MultiSourceSearchResult[] = [
      {
        sourceType: 'secondary',
        chunk: { id: 'c5', content, documentId: 'd', chunkIndex: 0 },
        document: { id: 'd', title: 'T', author: 'A', bibtexKey: null },
        similarity: 1,
      } as unknown as MultiSourceSearchResult,
    ];
    const snippet = hitsToSources(hits)[0].snippet;
    expect(snippet.length).toBe(400);
    expect(snippet.startsWith('alpha beta gamma delta')).toBe(true);
    expect(snippet).not.toMatch(/\s{2,}/);
  });
});
