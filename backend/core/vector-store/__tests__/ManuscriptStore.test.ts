import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sqliteAvailable } from '../../../__tests__/helpers/native-guards.js';
import {
  ManuscriptStore,
  type ManuscriptChapterRecord,
} from '../ManuscriptStore.js';

let tmp = '';
let store: ManuscriptStore;

function chapter(
  over: Partial<ManuscriptChapterRecord> = {}
): ManuscriptChapterRecord {
  return {
    id: 'c1',
    relativePath: 'chapters/01.md',
    title: 'Ouverture',
    order: 0,
    contentHash: 'hash-1',
    indexedAt: new Date().toISOString(),
    ...over,
  };
}

/** Vecteur normalisé simple, pour des cosinus lisibles. */
function vec(values: number[]): Float32Array {
  return Float32Array.from(values);
}

describe.skipIf(!sqliteAvailable)('ManuscriptStore', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-manuscript-'));
    store = new ManuscriptStore({ dbPath: path.join(tmp, 'brain.db') });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('verrouille la dimension sur le premier embedding écrit', () => {
    store.upsertChapter(chapter());
    store.addChunk(
      { id: 'c1-0', chapterId: 'c1', chunkIndex: 0, content: 'Danzig', line: 1 },
      vec([1, 0, 0])
    );
    // Une seconde dimension corromprait les cosinus en silence.
    expect(() =>
      store.addChunk(
        { id: 'c1-1', chapterId: 'c1', chunkIndex: 1, content: 'Volkstag', line: 3 },
        vec([1, 0])
      )
    ).toThrow(/dimension mismatch/i);
  });

  it('refuse un embedding non fini plutôt que d’empoisonner l’index', () => {
    store.upsertChapter(chapter());
    expect(() =>
      store.addChunk(
        { id: 'c1-0', chapterId: 'c1', chunkIndex: 0, content: 'x', line: 1 },
        vec([1, NaN, 0])
      )
    ).toThrow(/non-finite/i);
  });

  it('retrouve un extrait et le rattache à son chapitre', () => {
    store.upsertChapter(chapter());
    store.addChunk(
      {
        id: 'c1-0',
        chapterId: 'c1',
        chunkIndex: 0,
        content: 'Le port de Danzig est disputé.',
        sectionTitle: 'Le Volkstag',
        line: 5,
      },
      vec([1, 0, 0])
    );

    const hits = store.search(vec([1, 0, 0]), 'Danzig', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].chunk.content).toContain('Danzig');
    expect(hits[0].chunk.sectionTitle).toBe('Le Volkstag');
    expect(hits[0].chunk.line).toBe(5);
    expect(hits[0].chapter.title).toBe('Ouverture');
    expect(hits[0].chapter.relativePath).toBe('chapters/01.md');
  });

  it('la recherche lexicale fonctionne sans embedding', () => {
    store.upsertChapter(chapter());
    store.addChunk(
      { id: 'c1-0', chapterId: 'c1', chunkIndex: 0, content: 'La Société des Nations hésite.', line: 1 },
      vec([0, 1, 0])
    );
    const hits = store.searchLexical('Nations', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].chunk.content).toContain('Nations');
  });

  it('réindexer un chapitre remplace ses chunks sans en laisser d’orphelins', () => {
    store.upsertChapter(chapter());
    store.addChunk(
      { id: 'c1-0', chapterId: 'c1', chunkIndex: 0, content: 'Version initiale.', line: 1 },
      vec([1, 0, 0])
    );
    expect(store.stats().chunkCount).toBe(1);

    store.deleteChapterChunks('c1');
    store.addChunk(
      { id: 'c1-0', chapterId: 'c1', chunkIndex: 0, content: 'Version corrigée.', line: 1 },
      vec([1, 0, 0])
    );

    expect(store.stats().chunkCount).toBe(1);
    // L'index FTS suit : l'ancien texte ne doit plus être trouvable.
    expect(store.searchLexical('initiale', 5)).toHaveLength(0);
    expect(store.searchLexical('corrigée', 5)).toHaveLength(1);
  });

  it('supprimer un chapitre le retire, lui et ses chunks', () => {
    store.upsertChapter(chapter());
    store.addChunk(
      { id: 'c1-0', chapterId: 'c1', chunkIndex: 0, content: 'Texte.', line: 1 },
      vec([1, 0, 0])
    );
    store.deleteChapter('c1');
    expect(store.stats()).toEqual({ chapterCount: 0, chunkCount: 0 });
    expect(store.listChapters()).toEqual([]);
  });

  it('liste les chapitres dans l’ordre du manuscrit', () => {
    store.upsertChapter(chapter({ id: 'c2', relativePath: 'chapters/02.md', title: 'Deux', order: 1 }));
    store.upsertChapter(chapter({ id: 'c1', relativePath: 'chapters/01.md', title: 'Un', order: 0 }));
    expect(store.listChapters().map((c) => c.title)).toEqual(['Un', 'Deux']);
  });

  it('une requête FTS malformée ne fait pas tomber la recherche', () => {
    store.upsertChapter(chapter());
    store.addChunk(
      { id: 'c1-0', chapterId: 'c1', chunkIndex: 0, content: 'Danzig', line: 1 },
      vec([1, 0, 0])
    );
    expect(() => store.search(vec([1, 0, 0]), 'AND OR "((', 5)).not.toThrow();
    expect(store.searchLexical('AND OR "((', 5)).toEqual([]);
  });
});
