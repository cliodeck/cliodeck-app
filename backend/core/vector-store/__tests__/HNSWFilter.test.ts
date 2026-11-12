/**
 * Une question restreinte à une sélection interroge vraiment cette sélection (S01-1-1, S01-1-8).
 *
 * `HNSWVectorStore.search` demandait à hnswlib les 2k plus proches voisins du corpus entier, puis
 * écartait ceux qui n'étaient pas dans les documents choisis : quand d'autres documents parlaient
 * du même sujet de plus près, la recherche par le sens ne rendait rien du document sélectionné.
 * Le filtre se pose maintenant pendant la recherche (`searchKnn(…, filter)`), sans toucher au
 * fichier de l'index.
 *
 * `EnhancedVectorStore.search`, avec HNSW désactivé (`rag.useHNSWIndex: false`), levait « Search
 * indexes are not available » à chaque question : il fait maintenant la recherche linéaire. Elle
 * écarte les extraits d'une autre dimension que la question, et lève s'il n'en reste aucun, au lieu
 * de les rendre notés 0.
 *
 * Ici le vrai hnswlib, et une vraie base pour le second cas.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sqliteAvailable } from '../../../__tests__/helpers/native-guards.js';
import type { DocumentChunk, PDFDocument } from '../../../types/pdf-document.js';
import { SecondaryRetriever } from '../../rag/retrievers/secondary-retriever.js';
import { EnhancedVectorStore } from '../EnhancedVectorStore.js';
import { HNSWVectorStore } from '../HNSWVectorStore.js';
import { VectorStore } from '../VectorStore.js';

const DIMENSION = 32;
const DOCUMENTS = 40;
const CHUNKS_PER_DOCUMENT = 50;

/** Générateur pseudo-aléatoire à graine (mulberry32) : le même corpus à chaque passage. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = seeded(1789);
const vector = (): Float32Array => Float32Array.from({ length: DIMENSION }, () => random() * 2 - 1);

/** Un centre par document : ses extraits se tiennent autour, les autres documents ailleurs. */
const centers = Array.from({ length: DOCUMENTS }, vector);

const chunkOf = (d: number, i: number): DocumentChunk => ({
  id: `d${d}-c${i}`,
  documentId: `d${d}`,
  content: `Extrait ${i} du document ${d}.`,
  pageNumber: 1,
  chunkIndex: i,
  startPosition: 0,
  endPosition: 10,
});

const corpus: Array<{ chunk: DocumentChunk; embedding: Float32Array }> = [];
for (let d = 0; d < DOCUMENTS; d += 1) {
  for (let i = 0; i < CHUNKS_PER_DOCUMENT; i += 1) {
    const noise = vector();
    corpus.push({
      chunk: chunkOf(d, i),
      embedding: centers[d].map((x, j) => x + 0.4 * noise[j]),
    });
  }
}

/** Une question tout près du document 0 : les voisins du corpus entier sont tous les siens. */
const query = centers[0].map((x, j) => x + 0.05 * centers[5][j]);

const cosine = (a: Float32Array, b: Float32Array): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
};

/** Les k extraits d'un document les plus proches de la question, comptés un à un. */
const exactNearestIn = (documentId: string, k: number): string[] =>
  corpus
    .filter((entry) => entry.chunk.documentId === documentId)
    .map((entry) => ({ id: entry.chunk.id, similarity: cosine(query, entry.embedding) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k)
    .map((entry) => entry.id);

let project = '';

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-hnsw-filtre-'));
  // Les magasins tracent chaque ajout et chaque recherche.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(project, { recursive: true, force: true });
});

async function hnswOver(): Promise<HNSWVectorStore> {
  const store = new HNSWVectorStore(project, DIMENSION, DOCUMENTS * CHUNKS_PER_DOCUMENT);
  await store.initialize();
  await store.addChunks(corpus);
  return store;
}

describe('HNSWVectorStore : la sélection se filtre pendant la recherche', () => {
  it('le corpus entier : les voisins de la question sont ceux du document 0', async () => {
    const store = await hnswOver();
    const hits = await store.search(query, 10);
    expect(hits).toHaveLength(10);
    expect(new Set(hits.map((hit) => hit.chunk.documentId))).toEqual(new Set(['d0']));
  });

  it('restreinte au document 5 : k extraits, tous de d5, les plus proches de la question', async () => {
    const store = await hnswOver();
    const hits = await store.search(query, 10, ['d5']);
    expect(hits.map((hit) => hit.chunk.documentId)).toEqual(Array(10).fill('d5'));
    expect(hits.map((hit) => hit.chunk.id)).toEqual(exactNearestIn('d5', 10));
  });

  it('restreinte à trois documents : chacun peut répondre, aucun autre ne répond', async () => {
    const store = await hnswOver();
    const hits = await store.search(query, 50, ['d5', 'd17', 'd33']);
    expect(hits).toHaveLength(50);
    expect(hits.every((hit) => ['d5', 'd17', 'd33'].includes(hit.chunk.documentId))).toBe(true);
  });

  it('document inconnu, ou sélection vide : aucune réponse, sans lever', async () => {
    const store = await hnswOver();
    await expect(store.search(query, 10, ['inconnu'])).resolves.toEqual([]);
    await expect(store.search(query, 10, [])).resolves.toEqual([]);
  });

  it('index relu depuis le disque : le filtre s’applique de même', async () => {
    const written = await hnswOver();
    await written.save();

    const reread = new HNSWVectorStore(project, DIMENSION, DOCUMENTS * CHUNKS_PER_DOCUMENT);
    expect((await reread.initialize()).loaded).toBe(true);
    expect(await reread.loadMetadata()).toBe(true);
    const hits = await reread.search(query, 10, ['d5']);
    expect(hits.map((hit) => hit.chunk.id)).toEqual(exactNearestIn('d5', 10));
  });
});

const documentOf = (documentId: string): PDFDocument => {
  const now = new Date();
  return {
    id: documentId,
    fileURL: path.join(project, `${documentId}.pdf`),
    title: documentId,
    pageCount: 1,
    metadata: {},
    createdAt: now,
    indexedAt: now,
    lastAccessedAt: now,
    displayString: documentId,
  } as PDFDocument;
};

/** Le corpus dans brain.db, sans index HNSW sur le disque. */
function seedDatabase(): void {
  const store = new VectorStore(project);
  for (let d = 0; d < DOCUMENTS; d += 1) store.saveDocument(documentOf(`d${d}`));
  for (const { chunk, embedding } of corpus) store.saveChunk(chunk, embedding);
  store.close();
}

describe.skipIf(!sqliteAvailable)('EnhancedVectorStore : HNSW désactivé, la recherche est linéaire', () => {
  it('rend les extraits de la recherche linéaire, avec leur document, au lieu de lever', async () => {
    seedDatabase();
    const store = new EnhancedVectorStore(project);
    await store.initialize();
    store.setUseHNSW(false);
    try {
      const hits = await store.search('sans rapport', query, 10);
      const linear = store.getBaseStore().search(query, 10);
      expect(hits.map((hit) => hit.chunk.id)).toEqual(linear.map((hit) => hit.chunk.id));
      expect(hits).toHaveLength(10);
      expect(hits.every((hit) => hit.document?.id === hit.chunk.documentId)).toBe(true);

      const selected = await store.search('sans rapport', query, 10, ['d5']);
      expect(selected.map((hit) => hit.chunk.id)).toEqual(exactNearestIn('d5', 10));
    } finally {
      store.close();
    }
  });

  it('n’attend pas une reconstruction de HNSW et de BM25, qu’elle ne lit pas', async () => {
    seedDatabase();
    const store = new EnhancedVectorStore(project);
    store.setUseHNSW(false);
    try {
      const rebuilding = store.rebuildIndexes();
      expect(store.getRebuildStatus().isRebuilding).toBe(true);
      const hits = await store.search('sans rapport', query, 10, ['d5']);
      expect(hits.map((hit) => hit.chunk.id)).toEqual(exactNearestIn('d5', 10));
      await rebuilding;
    } finally {
      store.close();
    }
  });

  it('question d’une autre dimension que la base : lève comme HNSW, sans rendre d’extraits notés 0', async () => {
    seedDatabase();
    const store = new EnhancedVectorStore(project);
    await store.initialize();
    store.setUseHNSW(false);
    // Le modèle d'embeddings a changé (32 → 64 dimensions), les PDF ne sont pas réindexés.
    const wideQuery = Float32Array.from({ length: DIMENSION * 2 }, (_, j) => query[j % DIMENSION]);
    try {
      await expect(store.search('sans rapport', wideQuery, 10)).rejects.toThrow(
        `Query embedding dimension mismatch: expected ${DIMENSION}, got ${DIMENSION * 2}`
      );
      await expect(store.search('sans rapport', wideQuery, 10, ['d5'])).rejects.toThrow(
        'Query embedding dimension mismatch'
      );

      // Par le chemin du chat : le corpus est en panne (E2), pas trois extraits arbitraires
      // gardés par le repli `CROSS_LANGUAGE_FALLBACK`.
      const retriever = new SecondaryRetriever({
        vectorStore: store,
        getQueryEmbedding: async () => wideQuery,
        expandQuery: (text) => [text],
      });
      await expect(retriever.search('sans rapport', { topK: 10, threshold: 0.12 })).rejects.toThrow(
        'Query embedding dimension mismatch'
      );
    } finally {
      store.close();
    }
  });

  it('base à deux dimensions (réindexation en cours) : seuls les extraits de la dimension de la question répondent', async () => {
    seedDatabase();
    const base = new VectorStore(project);
    base.saveDocument(documentOf('n0'));
    const wide = (i: number): Float32Array =>
      Float32Array.from({ length: DIMENSION * 2 }, (_, j) => query[j % DIMENSION] + 0.01 * i);
    for (let i = 0; i < 5; i += 1) base.saveChunk({ ...chunkOf(0, i), id: `n0-c${i}`, documentId: 'n0' }, wide(i));
    base.close();

    const store = new EnhancedVectorStore(project);
    store.setUseHNSW(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const hits = await store.search('sans rapport', wide(0), 10);
      expect(hits.map((hit) => hit.chunk.documentId)).toEqual(Array(5).fill('n0'));
      expect(hits.every((hit) => hit.similarity > 0)).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('2000 chunks skipped'));
      // Les extraits pas encore réembarqués répondent toujours à une question de leur dimension.
      expect((await store.search('sans rapport', query, 10, ['d5'])).map((hit) => hit.chunk.id)).toEqual(
        exactNearestIn('d5', 10)
      );
    } finally {
      store.close();
    }
  });

  it('HNSW activé mais vide alors que la base a des extraits : la recherche lève toujours', async () => {
    seedDatabase();
    // Sans `initialize()` : l'index n'est pas reconstruit depuis SQLite.
    const store = new EnhancedVectorStore(project);
    try {
      await expect(store.search('sans rapport', query, 10)).rejects.toThrow(
        'Search indexes are not available'
      );
    } finally {
      store.close();
    }
  });
});
