/**
 * Un index qui se construit n'est pas un index en panne (E3).
 *
 * Pendant une reconstruction des index (après la réindexation d'un PDF déjà présent, après une
 * suppression, à l'ouverture d'un projet dont l'index manque), la recherche levait une `Error`
 * ordinaire : le chat disait « Bibliographie : échec ». Elle lève maintenant une erreur typée, que le
 * parcours des corpus distingue d'une panne. Un index vide que rien ne construit reste une panne
 * (P212-F) : le témoin le tient.
 *
 * Vrai store sur une vraie base, vrai HNSW.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sqliteAvailable } from '../../../__tests__/helpers/native-guards.js';
import type { DocumentChunk, PDFDocument } from '../../../types/pdf-document.js';
import { EnhancedVectorStore } from '../EnhancedVectorStore.js';
import { VectorStore } from '../VectorStore.js';
import { SearchIndexBuildingError } from '../search-index-building.js';

let project = '';
const stores: EnhancedVectorStore[] = [];

const documentOf = (documentId: string): PDFDocument => {
  const now = new Date();
  return {
    id: documentId,
    fileURL: path.join(project, `${documentId}.pdf`),
    title: 'A',
    pageCount: 1,
    metadata: {},
    createdAt: now,
    indexedAt: now,
    lastAccessedAt: now,
    displayString: 'A',
  } as PDFDocument;
};

const chunkOf = (documentId: string, i: number): DocumentChunk => ({
  id: `${documentId}-c${i}`,
  documentId,
  content: `Extrait ${i} sur la grève des dockers.`,
  pageNumber: 1,
  chunkIndex: i,
  startPosition: 0,
  endPosition: 10,
});

const embeddingOf = (i: number, dimension = 768): Float32Array =>
  new Float32Array(dimension).map((_, j) => Math.sin(i * 7 + j));

function open(): EnhancedVectorStore {
  const store = new EnhancedVectorStore(project);
  stores.push(store);
  return store;
}

/** Un corpus déjà indexé dans brain.db, sans index HNSW sur le disque. */
function seedChunks(count: number): void {
  const seed = new VectorStore(project);
  seed.saveDocument(documentOf('doc1'));
  for (let i = 0; i < count; i += 1) seed.saveChunk(chunkOf('doc1', i), embeddingOf(i));
  seed.close();
}

describe.skipIf(!sqliteAvailable)('EnhancedVectorStore : un index qui se construit (E3)', () => {
  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-index-en-construction-'));
  });

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('pendant une reconstruction des index : « en indexation », puis la recherche répond', async () => {
    seedChunks(3);
    const store = open();
    await store.initialize();
    const rebuilding = store.rebuildIndexes();

    const during = store.search('la grève', embeddingOf(0), 3);
    await expect(during).rejects.toBeInstanceOf(SearchIndexBuildingError);
    await expect(during).rejects.toThrow('being rebuilt');

    await rebuilding;
    await expect(store.search('la grève', embeddingOf(0), 3)).resolves.not.toHaveLength(0);
  });

  // Ce que L02-7 (#257) a réglé de la première indexation : `PDFIndexer` écrivait les extraits dans
  // SQLite un à un, pendant les embeddings, et HNSW ne les recevait qu'à la fin. Une question posée
  // entre-temps voyait des extraits hors d'atteinte. Depuis, SQLite les reçoit d'un bloc, et HNSW
  // dans la foulée, sans rendre la main : aucune question ne passe entre les deux. Le test le tient ;
  // s'il tombe, l'ajout à HNSW rend la main avant d'avoir tout ajouté. Avant ce bloc, pendant les
  // embeddings, la bibliographie n'a aucun extrait : `retrievalService` la dit alors « en
  // indexation », d'après `pdfService` (`retrieval-first-pdf-indexing.test.ts`).
  it('première indexation d’un PDF : aucune question ne voit les extraits dans SQLite sans HNSW (L02-7)', async () => {
    const store = open();
    await store.initialize();
    // Un projet neuf avec un modèle de 1024 dimensions : l'index est refait vide à sa dimension.
    await store.adoptEmbeddingDimension(1024);
    const chunks = [0, 1].map((i) => ({ chunk: chunkOf('doc1', i), embedding: embeddingOf(i, 1024) }));
    // Ce que fait `PDFIndexer` : SQLite d'un bloc, puis HNSW et BM25.
    store.transaction(() => {
      store.saveDocument(documentOf('doc1'));
      for (const { chunk, embedding } of chunks) store.saveChunk(chunk, embedding);
    });
    const adding = store.addToSearchIndexes(chunks);

    // La question arrive aussitôt après l'appel, avant la fin de l'ajout.
    await expect(store.search('la grève', embeddingOf(0, 1024), 3)).resolves.not.toHaveLength(0);
    await adding;
  });

  it('témoin : extraits dans SQLite, index vide, rien en construction : une panne, pas « en indexation »', async () => {
    seedChunks(1);
    // Sans `initialize()` : l'index n'est pas reconstruit depuis SQLite.
    const store = open();
    const search = store.search('la grève', embeddingOf(0), 3);
    await expect(search).rejects.toThrow('Search indexes are not available');
    await expect(search).rejects.not.toBeInstanceOf(SearchIndexBuildingError);
  });
});
