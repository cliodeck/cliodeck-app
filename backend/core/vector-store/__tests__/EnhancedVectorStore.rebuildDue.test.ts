/**
 * J8 : l'index des PDF garde sur le disque qu'il est à reconstruire.
 *
 * `indexesStale` ne vivait qu'en mémoire. Une reconstruction demandée après une suppression (ou un
 * PDF réindexé qui remplace sa copie) et abandonnée à la fermeture du projet ne repartait pas à la
 * réouverture : l'index, non vide et lisible, passait pour sain, et gardait les vecteurs des
 * documents partis, qui prenaient des places dans les réponses sans que rien ne le dise.
 *
 * La marque vit maintenant dans `brain.db` ; à la réouverture, la reconstruction est proposée,
 * jamais lancée d'office. Vrai store, vrai `brain.db`, vrai index HNSW sur le disque.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { sqliteAvailable } from '../../../__tests__/helpers/native-guards.js';
import type { DocumentChunk, PDFDocument } from '../../../types/pdf-document.js';
import type { RebuildProgressEvent } from '../../../types/rebuild-progress.js';
import { PdfVectorStore } from '../../../../src/main/services/pdf/PdfVectorStore.js';
import { EnhancedVectorStore } from '../EnhancedVectorStore.js';
import { VectorStore } from '../VectorStore.js';

let project = '';

const documentOf = (documentId: string): PDFDocument => {
  const now = new Date();
  return {
    id: documentId,
    fileURL: path.join(project, `${documentId}.pdf`),
    title: documentId,
    pageCount: 3,
    metadata: {},
    createdAt: now,
    indexedAt: now,
    lastAccessedAt: now,
    displayString: documentId,
  } as PDFDocument;
};

const chunkOf = (documentId: string, i: number): DocumentChunk => ({
  id: `${documentId}-c${i}`,
  documentId,
  content: `Extrait ${i} de ${documentId} sur les archives.`,
  pageNumber: 1,
  chunkIndex: i,
  startPosition: 0,
  endPosition: 10,
});

const embeddingOf = (seed: number): Float32Array => new Float32Array(768).map((_, j) => Math.sin(seed * 7 + j));

/** Deux PDF déjà indexés, et leur index HNSW écrit sur le disque, à jour : un projet sain. */
async function seedHealthyProject(): Promise<void> {
  const base = new VectorStore(project);
  ['doc1', 'doc2'].forEach((documentId, d) => {
    base.saveDocument(documentOf(documentId));
    for (let i = 0; i < 6; i += 1) base.saveChunk(chunkOf(documentId, i), embeddingOf(d * 100 + i));
  });
  base.close();
  const store = new EnhancedVectorStore(project);
  await store.rebuildIndexes();
  store.close();
}

/** Ce que fait `PDFIndexer` pour un PDF, sur le store ouvert : SQLite d'un bloc, puis HNSW et BM25. */
async function indexDocument(
  store: EnhancedVectorStore,
  documentId: string,
  count: number,
  replacing: string[] = []
): Promise<void> {
  const chunks = Array.from({ length: count }, (_, i) => ({
    chunk: chunkOf(documentId, i),
    embedding: embeddingOf(500 + i),
  }));
  store.transaction(() => {
    store.saveDocument(documentOf(documentId));
    for (const { chunk, embedding } of chunks) store.saveChunk(chunk, embedding);
    if (replacing.length > 0) store.mergeDocumentsInto(documentId, replacing);
  });
  await store.addToSearchIndexes(chunks);
}

const cliodeck = (file: string) => path.join(project, '.cliodeck', file);

/** Une écriture de l'index rendue impossible, comme sur un disque réel. */
const blockIndexWrite = () => fs.mkdirSync(cliodeck('hnsw.index.meta.json.tmp'));

/**
 * La marque telle que `brain.db` la garde, lue par une connexion à part, comme la lirait la
 * prochaine ouverture. Null sans table (une base d'avant J8) ou sans marque.
 */
function markOf(): { marked_at: string; reason: string } | null {
  const db = new Database(cliodeck('brain.db'), { readonly: true });
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pdf_index_state'").get();
    if (!table) return null;
    const row = db.prepare('SELECT marked_at, reason FROM pdf_index_state WHERE id = 1 AND rebuild_due = 1').get() as
      | { marked_at: string; reason: string }
      | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

const hnswSize = async (store: EnhancedVectorStore) => (await store.getStats()).hnsw.currentSize;

/** Une ouverture de projet : `initialize`, puis ce que fait `pdf-service` une fois le modèle préchauffé. */
async function reopen(): Promise<{ store: EnhancedVectorStore; events: RebuildProgressEvent[] }> {
  const store = new EnhancedVectorStore(project);
  const events: RebuildProgressEvent[] = [];
  store.setRebuildProgressCallback((event) => events.push(event));
  await store.initialize();
  await PdfVectorStore.maybeRebuild(store);
  return { store, events };
}

describe.skipIf(!sqliteAvailable)('J8 : l’index des PDF à reconstruire, gardé dans brain.db', () => {
  beforeEach(async () => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-reconstruction-due-'));
    await seedHealthyProject();
  });

  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('une suppression pose la marque dans brain.db', async () => {
    const { store } = await reopen();

    store.deleteDocument('doc2');
    store.close();

    expect(markOf()).toMatchObject({ reason: 'documents-removed' });
  });

  it('un PDF réindexé qui remplace sa copie la pose aussi : ses anciens vecteurs restent dans HNSW', async () => {
    const { store } = await reopen();

    await indexDocument(store, 'doc2-bis', 3, ['doc2']);
    store.close();

    expect(markOf()).toMatchObject({ reason: 'documents-removed' });
  });

  it('jamais sur un index sain : un PDF indexé sans rien remplacer ne pose rien, et la réouverture ne propose rien', async () => {
    const first = await reopen();
    await indexDocument(first.store, 'doc3', 3);
    await PdfVectorStore.maybeRebuild(first.store);
    first.store.close();

    expect(markOf()).toBeNull();
    const next = await reopen();
    expect(next.events).toEqual([]);
    expect(next.store.getRebuildStatus().rebuildDue).not.toBe(true);
    next.store.close();
  });

  it('fermé avant la reconstruction : la marque reste, et la réouverture la propose sans rien reconstruire d’office', async () => {
    const first = await reopen();
    first.store.deleteDocument('doc2');
    first.store.close();

    const next = await reopen();

    // Proposée, pas lancée : aucun voile à l'ouverture.
    expect(next.events).toEqual([]);
    expect(next.store.getRebuildStatus().rebuildDue).toBe(true);
    expect(markOf()).not.toBeNull();
    // Ce qu'elle remettra d'aplomb : les vecteurs de doc2 sont encore dans l'index.
    expect(await hnswSize(next.store)).toBe(12);
    next.store.close();
  });

  it('une reconstruction réussie l’efface : la réouverture suivante ne propose plus rien', async () => {
    const first = await reopen();
    first.store.deleteDocument('doc2');
    first.store.close();
    const second = await reopen();
    expect(markOf()).not.toBeNull();

    await second.store.rebuildIndexes();

    expect(markOf()).toBeNull();
    expect(second.store.getRebuildStatus().rebuildDue).toBe(false);
    expect(await hnswSize(second.store)).toBe(6);
    second.store.close();

    const third = await reopen();
    expect(third.events).toEqual([]);
    expect(third.store.getRebuildStatus().rebuildDue).toBe(false);
    third.store.close();
  });

  it('une reconstruction qui échoue à l’écriture la laisse ; l’index retiré du disque se refait d’office', async () => {
    const first = await reopen();
    first.store.deleteDocument('doc2');
    blockIndexWrite();

    await expect(first.store.rebuildIndexes()).rejects.toThrow('Failed to save HNSW index');
    expect(first.store.getRebuildStatus().rebuildDue).toBe(false);
    first.store.close();

    expect(markOf()).toMatchObject({ reason: 'documents-removed' });
    // `clear()` avait déjà retiré l'ancien index du disque : l'ouverture le refait, comme avant.
    fs.rmdirSync(cliodeck('hnsw.index.meta.json.tmp'));
    const next = await reopen();
    expect(next.events.at(-1)?.phase).toBe('done');
    expect(markOf()).toBeNull();
    next.store.close();
  });

  // chmod ne retire pas ce droit sous Windows, ni à root : le vrai disque en refuserait le test, pas le code.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'une reconstruction qui échoue en laissant l’ancien index sur le disque garde la marque : la réouverture la propose encore',
    async () => {
      const first = await reopen();
      first.store.deleteDocument('doc2');
      const directory = path.join(project, '.cliodeck');
      fs.chmodSync(directory, 0o555);
      try {
        await expect(first.store.rebuildIndexes()).rejects.toThrow();
      } finally {
        fs.chmodSync(directory, 0o755);
      }
      first.store.close();

      expect(markOf()).toMatchObject({ reason: 'documents-removed' });
      const next = await reopen();
      expect(next.events).toEqual([]);
      expect(next.store.getRebuildStatus().rebuildDue).toBe(true);
      expect(await hnswSize(next.store)).toBe(12);
      next.store.close();
    }
  );

  it('demandée par l’historien : la reconstruction part du magasin, puis plus rien n’est proposé', async () => {
    const first = await reopen();
    first.store.deleteDocument('doc2');
    first.store.close();
    const { store, events } = await reopen();

    expect(store.requestRebuild()).toBe(true);
    await PdfVectorStore.maybeRebuild(store);

    expect(events.at(-1)?.phase).toBe('done');
    expect(await hnswSize(store)).toBe(6);
    expect(markOf()).toBeNull();
    // Plus rien à proposer : une seconde demande ne relance rien.
    expect(store.requestRebuild()).toBe(false);
    store.close();
  });

  it('rien de proposé : la demande ne déclenche rien', async () => {
    const { store, events } = await reopen();

    expect(store.requestRebuild()).toBe(false);
    await PdfVectorStore.maybeRebuild(store);

    expect(events).toEqual([]);
    store.close();
  });

  it('index absent avec la marque : reconstruit d’office comme avant, et la marque tombe', async () => {
    const first = await reopen();
    first.store.deleteDocument('doc2');
    first.store.close();
    fs.rmSync(cliodeck('hnsw.index'));
    fs.rmSync(cliodeck('hnsw.index.meta.json'));

    const next = await reopen();

    expect(next.events.at(-1)?.phase).toBe('done');
    expect(await hnswSize(next.store)).toBe(6);
    expect(markOf()).toBeNull();
    expect(next.store.getRebuildStatus().rebuildDue).not.toBe(true);
    next.store.close();
  });

  it('purger la base retire aussi la marque : il ne reste rien à reconstruire', async () => {
    const { store } = await reopen();
    store.deleteDocument('doc2');

    store.purgeAllData();
    store.close();

    expect(markOf()).toBeNull();
  });
});
