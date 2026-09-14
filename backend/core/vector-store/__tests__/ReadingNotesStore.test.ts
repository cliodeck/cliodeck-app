import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sqliteAvailable } from '../../../__tests__/helpers/native-guards.js';
import {
  ReadingNotesStore,
  readingNoteHeader,
  readingNoteId,
  type ReadingNoteRecord,
} from '../ReadingNotesStore.js';

let tmp = '';
let store: ReadingNotesStore;

function note(over: Partial<ReadingNoteRecord> = {}): ReadingNoteRecord {
  return {
    id: 'zotero:ABCD1234',
    relativePath: 'reading-notes/Braudel_1949.md',
    citekey: 'Braudel_1949',
    zoteroKey: 'ABCD1234',
    title: 'La Méditerranée',
    tags: ['chapitre-2'],
    contentHash: 'hash-1',
    indexedAt: new Date().toISOString(),
    ...over,
  };
}

function vec(values: number[]): Float32Array {
  return Float32Array.from(values);
}

describe('identité et en-tête d’une note', () => {
  it('identifie une note par sa référence, pas par son fichier', () => {
    expect(readingNoteId({ citekey: 'Braudel_1949', zoteroKey: 'ABCD1234' })).toBe('zotero:ABCD1234');
    expect(readingNoteId({ citekey: 'Braudel_1949' })).toBe('citekey:Braudel_1949');
  });

  it('nomme la référence et les étiquettes du projet', () => {
    expect(readingNoteHeader(note())).toBe(
      'Note de lecture sur @Braudel_1949 — La Méditerranée\nÉtiquettes : chapitre-2'
    );
    expect(readingNoteHeader({ citekey: 'X_2000', tags: [] })).toBe('Note de lecture sur @X_2000');
  });
});

describe.skipIf(!sqliteAvailable)('ReadingNotesStore', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-reading-notes-'));
    store = new ReadingNotesStore({ dbPath: path.join(tmp, 'brain.db') });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('retrouve un extrait, le rattache à sa note et publie les signaux bruts', () => {
    store.upsertNote(note());
    store.addChunk(
      { id: 'n-0', noteId: 'zotero:ABCD1234', chunkIndex: 0, content: 'La longue durée écrase l’événement.', line: 9 },
      vec([1, 0, 0]),
      readingNoteHeader(note())
    );
    store.addChunk(
      { id: 'n-1', noteId: 'zotero:ABCD1234', chunkIndex: 1, content: 'Sans rapport.', line: 12 },
      vec([0.8, 0.6, 0])
    );

    const hits = store.search(vec([1, 0, 0]), 'durée', 5);
    const byId = Object.fromEntries(hits.map((h) => [h.chunk.id, h]));
    expect(byId['n-0'].note).toMatchObject({ citekey: 'Braudel_1949', tags: ['chapitre-2'] });
    expect(byId['n-0'].chunk.line).toBe(9);
    expect(byId['n-0'].signals.lexicalRank).toBe(1);
    expect(byId['n-0'].signals.dense).toBeCloseTo(1);
    expect(byId['n-1'].signals.lexicalRank).toBeNull();
    expect(byId['n-1'].signals.dense).toBeCloseTo(0.8);
  });

  it('trouve la note par sa référence ou ses étiquettes, sans les mettre dans l’extrait', () => {
    store.upsertNote(note());
    store.addChunk(
      { id: 'n-0', noteId: 'zotero:ABCD1234', chunkIndex: 0, content: 'Trois temps de l’histoire.', line: 9 },
      vec([1, 0, 0]),
      readingNoteHeader(note())
    );

    expect(store.searchLexical('Méditerranée', 5)).toHaveLength(1);
    expect(store.searchLexical('chapitre-2', 5)).toHaveLength(1);
    expect(store.searchLexical('Méditerranée', 5)[0].chunk.content).toBe('Trois temps de l’histoire.');
  });

  it('réindexer une note remplace ses extraits, index plein texte compris', () => {
    store.upsertNote(note());
    store.addChunk({ id: 'n-0', noteId: 'zotero:ABCD1234', chunkIndex: 0, content: 'Version initiale.', line: 1 }, vec([1, 0, 0]));
    store.deleteNoteChunks('zotero:ABCD1234');
    store.addChunk({ id: 'n-0', noteId: 'zotero:ABCD1234', chunkIndex: 0, content: 'Version corrigée.', line: 1 }, vec([1, 0, 0]));

    expect(store.stats().chunkCount).toBe(1);
    expect(store.searchLexical('initiale', 5)).toHaveLength(0);
    expect(store.searchLexical('corrigée', 5)).toHaveLength(1);
  });

  it('un fichier renommé garde la même note', () => {
    store.upsertNote(note());
    store.upsertNote(note({ relativePath: 'reading-notes/braudel-mediterranee.md' }));
    expect(store.listNotes()).toHaveLength(1);
    expect(store.getNote('zotero:ABCD1234')?.relativePath).toBe('reading-notes/braudel-mediterranee.md');
  });

  it('supprimer une note la retire avec ses extraits', () => {
    store.upsertNote(note());
    store.addChunk({ id: 'n-0', noteId: 'zotero:ABCD1234', chunkIndex: 0, content: 'Texte.', line: 1 }, vec([1, 0, 0]));
    store.deleteNote('zotero:ABCD1234');
    expect(store.stats()).toEqual({ noteCount: 0, chunkCount: 0, lastIndexedAt: null });
    expect(store.searchLexical('Texte', 5)).toEqual([]);
  });

  it('verrouille la dimension et refuse un embedding non fini', () => {
    store.upsertNote(note());
    store.addChunk({ id: 'n-0', noteId: 'zotero:ABCD1234', chunkIndex: 0, content: 'a', line: 1 }, vec([1, 0, 0]));
    expect(() =>
      store.addChunk({ id: 'n-1', noteId: 'zotero:ABCD1234', chunkIndex: 1, content: 'b', line: 2 }, vec([1, 0]))
    ).toThrow(/dimension mismatch/i);
    expect(() =>
      store.addChunk({ id: 'n-2', noteId: 'zotero:ABCD1234', chunkIndex: 2, content: 'c', line: 3 }, vec([1, NaN, 0]))
    ).toThrow(/non-finite/i);
  });

  it('partage brain.db avec le manuscrit sans collision', async () => {
    const { ManuscriptStore } = await import('../ManuscriptStore.js');
    const manuscript = new ManuscriptStore({ dbPath: path.join(tmp, 'brain.db') });
    try {
      expect(manuscript.stats().chunkCount).toBe(0);
    } finally {
      manuscript.close();
    }
  });

  it('une requête FTS malformée ne fait pas tomber la recherche', () => {
    store.upsertNote(note());
    store.addChunk({ id: 'n-0', noteId: 'zotero:ABCD1234', chunkIndex: 0, content: 'Braudel', line: 1 }, vec([1, 0, 0]));
    expect(() => store.search(vec([1, 0, 0]), 'AND OR "((', 5)).not.toThrow();
    expect(store.searchLexical('AND OR "((', 5)).toEqual([]);
  });
});
