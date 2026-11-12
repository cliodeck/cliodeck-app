/**
 * Les sources primaires et l'espace de leurs vecteurs, après un changement de modèle d'embeddings
 * (L06-9, S02-1-11, J7).
 *
 * Passé de nomic-embed-text (768) à mxbai-embed-large (1024), ou au modèle embarqué, le chat
 * interrogeait l'index des archives avec une question d'une autre dimension. Trois défauts :
 *
 * - la recherche levait l'erreur brute de hnswlib (« Invalid the given array length »), ou, l'index
 *   vide, ne levait rien et rendait les seuls résultats lexicaux, comme si de rien n'était ;
 * - un extrait embarqué à la nouvelle dimension (synchro, OCR manuel) réinitialisait l'index en
 *   mémoire, après son écriture en base : tous les vecteurs de l'ancienne en sortaient ;
 * - sans index sur disque, la dimension se lisait sur une ligne quelconque de la base.
 *
 * La règle : l'erreur est celle des PDF (`EmbeddingSpaceMismatchError`, L04-7), levée avant toute
 * écriture ; un corpus sans extrait à la dimension de l'index adopte la nouvelle ; la dimension
 * d'une base mêlée est celle du plus grand nombre d'extraits.
 *
 * Vrai magasin, vrai hnswlib, brain.db temporaire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sqliteAvailable } from '../../../__tests__/helpers/native-guards.js';
import { PrimarySourcesVectorStore, type PrimarySourceChunk } from '../PrimarySourcesVectorStore.js';
import { EmbeddingSpaceMismatchError } from '../embedding-space.js';

const OLD = 768;
const NEW = 1024;

let tmp = '';
const opened: PrimarySourcesVectorStore[] = [];

/** Un vecteur propre à `i` : la question qui le reprend tel quel le trouve en tête. */
function vec(dimension: number, i: number): Float32Array {
  const v = new Float32Array(dimension);
  v[i % dimension] = 1;
  v[(i * 7 + 3) % dimension] += 0.5;
  return v;
}

function open(): PrimarySourcesVectorStore {
  const store = new PrimarySourcesVectorStore(tmp);
  opened.push(store);
  return store;
}

function chunk(sourceId: string, id: string, content: string, index = 0): PrimarySourceChunk {
  return { id, sourceId, content, chunkIndex: index, startPosition: 0, endPosition: content.length };
}

function addSource(store: PrimarySourcesVectorStore, i: number): void {
  store.saveSource({
    id: `src-${i}`,
    tropyId: i,
    title: `Pièce ${i}`,
    tags: [],
    photos: [],
    transcription: `Corps de la pièce ${i}.`,
    transcriptionSource: 'tesseract',
    lastModified: new Date('2026-05-06T13:13:22.394Z'),
    metadata: {},
  });
}

/** `count` sources de deux extraits (`old-i-k`), embarquées à `dimension`. */
function fill(store: PrimarySourcesVectorStore, count: number, dimension = OLD): void {
  for (let i = 1; i <= count; i++) {
    addSource(store, i);
    store.replaceSourceChunks(
      `src-${i}`,
      [0, 1].map((k) => ({
        chunk: chunk(`src-${i}`, `old-${i}-${k}`, `pièce ${i} registre ${k}`, k),
        embedding: vec(dimension, 10 * i + k),
      }))
    );
  }
}

const brainDb = () => path.join(tmp, '.cliodeck', 'brain.db');

/** Les extraits de la source en base, avec la dimension de leur vecteur. */
function chunksInBase(sourceId: string): Array<{ id: string; dimension: number }> {
  const db = new Database(brainDb(), { readonly: true });
  try {
    return db
      .prepare('SELECT id, length(embedding) / 4 AS dimension FROM tropy_chunks WHERE source_id = ? ORDER BY id')
      .all(sourceId) as Array<{ id: string; dimension: number }>;
  } finally {
    db.close();
  }
}

/** Comme une base que deux modèles ont remplie : des extraits écrits sans passer par le magasin. */
function insertChunks(rows: Array<{ sourceId: string; id: string; embedding: Float32Array }>): void {
  const db = new Database(brainDb());
  try {
    const insert = db.prepare(
      `INSERT INTO tropy_chunks (id, source_id, content, chunk_index, start_position, end_position, embedding)
       VALUES (?, ?, ?, 0, 0, 10, ?)`
    );
    for (const row of rows) insert.run(row.id, row.sourceId, `extrait ${row.id}`, Buffer.from(row.embedding.buffer));
  } finally {
    db.close();
  }
}

/** L'index HNSW retiré du disque : la relance le refait à partir de la base. */
function removeIndexFiles(): void {
  for (const file of ['primary-hnsw.index', 'primary-hnsw.index.meta.json']) {
    fs.rmSync(path.join(tmp, '.cliodeck', file), { force: true });
  }
}

function catchError(run: () => unknown): unknown {
  try {
    run();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-primary-embedding-space-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const store of opened.splice(0)) {
    try {
      store.close();
    } catch {
      /* déjà fermé */
    }
  }
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('PrimarySourcesVectorStore — une question d’une autre dimension que le corpus', () => {
  it('index en 768, question en 1024 : EmbeddingSpaceMismatchError, et non l’erreur brute de hnswlib', () => {
    const store = open();
    fill(store, 4);

    const error = catchError(() => store.search(vec(NEW, 1), 3, 'pièce registre'));

    expect(error).toBeInstanceOf(EmbeddingSpaceMismatchError);
    expect(error).toMatchObject({ kind: 'dimension', code: 'embedding_dimension_mismatch', expected: OLD, actual: NEW });
  });

  it('index vide, extraits en 768, question en 1024 : la même erreur, jamais les seuls résultats lexicaux sans rien dire', () => {
    const first = open();
    fill(first, 4);
    first.close();
    removeIndexFiles();

    const store = open();
    const error = catchError(() => store.search(vec(NEW, 1), 3, 'pièce registre'));

    expect(error).toBeInstanceOf(EmbeddingSpaceMismatchError);
    expect(error).toMatchObject({ kind: 'dimension', expected: OLD, actual: NEW });
  });

  it('témoin : un corpus vide rend une liste vide, quelle que soit la dimension de la question', () => {
    const store = open();
    expect(store.search(vec(NEW, 1), 3, 'pièce')).toEqual([]);
  });
});

describe.skipIf(!sqliteAvailable)('PrimarySourcesVectorStore — un extrait d’une autre dimension n’entre pas', () => {
  it('extrait en 1024 dans un index non vide en 768 : levée avant toute écriture, base et index en mémoire intacts', () => {
    const store = open();
    fill(store, 4);
    const before = store.getIndexStats();

    const error = catchError(() =>
      store.replaceSourceChunks('src-2', [{ chunk: chunk('src-2', 'new-2-0', 'pièce 2 nouvelle'), embedding: vec(NEW, 99) }])
    );

    expect(error).toBeInstanceOf(EmbeddingSpaceMismatchError);
    expect(error).toMatchObject({ kind: 'dimension', expected: OLD, actual: NEW });
    // Rien d'écrit : les extraits de la source sont ceux d'avant, à l'ancienne dimension.
    expect(chunksInBase('src-2')).toEqual([
      { id: 'old-2-0', dimension: OLD },
      { id: 'old-2-1', dimension: OLD },
    ]);
    // L'index en mémoire n'a pas été vidé : il sert toujours les autres sources.
    expect(store.getIndexStats()).toEqual(before);
    expect(store.search(vec(OLD, 30), 1)[0]?.chunk.id).toBe('old-3-0');
    expect(store.search(vec(OLD, 20), 1)[0]?.chunk.id).toBe('old-2-0');
  });

  it('témoin : un corpus sans extrait adopte la dimension du premier vecteur', () => {
    const store = open();
    addSource(store, 1);

    store.replaceSourceChunks('src-1', [{ chunk: chunk('src-1', 'new-1-0', 'pièce 1'), embedding: vec(NEW, 5) }]);

    expect(store.getIndexStats()).toMatchObject({ hnswDimension: NEW, hnswSize: 1 });
    expect(store.search(vec(NEW, 5), 1)[0]?.chunk.id).toBe('new-1-0');
  });

  it('témoin : la seule source à l’ancienne dimension, réembarquée, fait passer le corpus à la nouvelle', () => {
    const store = open();
    fill(store, 1);

    store.replaceSourceChunks('src-1', [{ chunk: chunk('src-1', 'new-1-0', 'pièce 1'), embedding: vec(NEW, 5) }]);

    expect(store.getIndexStats()).toMatchObject({ hnswDimension: NEW });
    expect(store.search(vec(NEW, 5), 1)[0]?.chunk.id).toBe('new-1-0');
  });

  it('une reconstruction par tranches en cours vers la nouvelle dimension : l’extrait à cette dimension est accepté, et servi à la fin', async () => {
    const store = open();
    fill(store, 4);

    const rebuild = store.rebuildIndexesInSlices(2, NEW);
    store.replaceSourceChunks('src-1', [{ chunk: chunk('src-1', 'new-1-0', 'pièce 1 nouvelle'), embedding: vec(NEW, 5) }]);
    expect(await rebuild).toBe(true);

    expect(store.getIndexStats()).toMatchObject({ hnswDimension: NEW, hnswSize: 1 });
    expect(store.search(vec(NEW, 5), 1)[0]?.chunk.id).toBe('new-1-0');
  });
});

describe.skipIf(!sqliteAvailable)('PrimarySourcesVectorStore — une base où deux modèles ont écrit', () => {
  /** Une source en 1024 écrite la première, six en 768 : la première ligne lue n'est pas la majorité. */
  function mixedBase(): void {
    const store = open();
    for (let i = 1; i <= 7; i++) addSource(store, i);
    store.replaceSourceChunks('src-1', [{ chunk: chunk('src-1', 'new-1-0', 'pièce 1'), embedding: vec(NEW, 5) }]);
    store.close();
    insertChunks(
      [2, 3, 4, 5, 6, 7].flatMap((i) => [0, 1].map((k) => ({ sourceId: `src-${i}`, id: `old-${i}-${k}`, embedding: vec(OLD, 10 * i + k) })))
    );
    removeIndexFiles();
  }

  it('sans index sur disque, la dimension est celle du plus grand nombre d’extraits, pas celle de la première ligne', () => {
    mixedBase();
    const store = open();

    expect(store.getEmbeddingDimension()).toBe(OLD);
    expect(store.getIndexStats().hnswDimension).toBe(OLD);
  });

  it('la reconstruction d’un bloc garde la dimension majoritaire', () => {
    mixedBase();
    const store = open();

    store.rebuildAllIndexes();

    expect(store.getIndexStats()).toMatchObject({ hnswDimension: OLD, hnswSize: 12 });
    expect(store.search(vec(OLD, 40), 1)[0]?.chunk.id).toBe('old-4-0');
  });

  it('J7 : la passe d’ouverture ne liste pas les sources d’une autre dimension que celle du fournisseur, listées à part avec leurs extraits', () => {
    mixedBase();
    const store = open();

    // Les six sources en 768 n'ont pas de version d'extraits (`chunks_version`) : à la dimension du
    // fournisseur, la passe d'ouverture les refait ; à une autre, elle ne les prend pas.
    const old = [2, 3, 4, 5, 6, 7].map((i) => ({ id: `src-${i}`, chunks: 2 }));
    expect(store.listOutdatedChunkSources(OLD)).toEqual(old);
    expect(store.listOutdatedChunkSources(NEW)).toEqual([]);
    expect(store.hasOutdatedChunks('src-2', OLD)).toBe(true);
    expect(store.hasOutdatedChunks('src-2', NEW)).toBe(false);
    // Listées à part, pour la réindexation proposée (Q29) : celles qui ont des extraits à une autre
    // dimension que celle du fournisseur, avec leur nombre d'extraits.
    expect(store.listOtherDimensionSources(NEW)).toEqual(old);
    expect(store.listOtherDimensionSources(OLD)).toEqual([{ id: 'src-1', chunks: 1 }]);
    expect(store.hasOtherDimensionChunks('src-2', NEW)).toBe(true);
    expect(store.hasOtherDimensionChunks('src-1', NEW)).toBe(false);
  });
});
