/**
 * La dimension de l'index des PDF est celle du corpus, pas 768 par principe (S01-1-2).
 *
 * `EnhancedVectorStore` prenait la dimension d'une ligne de SQLite prise au hasard (`LIMIT 1`, sans
 * ordre), ou 768 sur une base vide, et n'en changeait plus. Avec un modèle d'embeddings d'une autre
 * dimension (mxbai-embed-large, 1024 ; text-embedding-3-small, 1536), HNSW sautait chaque vecteur
 * avec un simple avertissement : le PDF passait pour indexé, et chaque question levait « Search
 * indexes are not available » jusqu'à la réouverture du projet, la reconstruction refaisant le
 * même index vide. Sur un corpus existant, les PDF indexés après un changement de modèle entraient
 * dans SQLite sans jamais entrer dans HNSW, et la moitié du corpus sortait de la recherche par le
 * sens, sans un mot.
 *
 * Désormais : un corpus vide adopte la dimension du premier vecteur ; un PDF d'une autre dimension
 * que le corpus est refusé avant toute écriture (`EmbeddingSpaceMismatchError`) ; une base déjà
 * mêlée s'indexe dans sa dimension majoritaire, sans reconstruction à chaque ouverture.
 *
 * Le vrai indexeur, le vrai store, un vrai `brain.db` et un vrai index HNSW sur le disque. Seuls
 * l'extraction du PDF et le fournisseur d'embeddings sont simulés.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { sqliteAvailable } from '../../../__tests__/helpers/native-guards.js';
import type { DocumentChunk, PDFDocument } from '../../../types/pdf-document.js';
import type { RebuildProgressEvent } from '../../../types/rebuild-progress.js';
import type { RAGConfig } from '../../../types/config.js';
import { PdfVectorStore } from '../../../../src/main/services/pdf/PdfVectorStore.js';
import { PDFIndexer } from '../../pdf/PDFIndexer.js';
import { EnhancedVectorStore } from '../EnhancedVectorStore.js';
import { EmbeddingSpaceMismatchError } from '../embedding-space.js';
import { HNSWVectorStore } from '../HNSWVectorStore.js';
import { VectorStore } from '../VectorStore.js';

let project = '';

const TEXT =
  'Les archives de la Haute Autorité racontent la fusion des marchés du charbon et de l’acier. ' +
  'Chaque rapport annuel reprend les chiffres de production et les débats de l’Assemblée commune. ';

/** Un PDF de deux pages, déjà extrait : seule l'extraction est simulée. */
const extract = async () => ({
  pages: [
    { pageNumber: 1, text: TEXT.repeat(6) },
    { pageNumber: 2, text: TEXT.repeat(6) },
  ],
  metadata: {},
  title: 'Rapport annuel',
});

/** Filtres coupés : le texte répété donne alors plusieurs extraits. */
const RAW: Partial<RAGConfig> = { enablePreprocessing: false, enableQualityFiltering: false, enableDeduplication: false };

/** Un fournisseur d'embeddings de cette dimension : nomic-embed-text (768), mxbai-embed-large (1024). */
const embedIn =
  (dimension: number) =>
  async (content: string): Promise<Float32Array> => {
    const v = new Float32Array(dimension);
    for (let i = 0; i < content.length; i++) v[i % dimension] += content.charCodeAt(i) / 1000;
    return v;
  };

const indexer = (store: VectorStore | EnhancedVectorStore, dimension: number) =>
  new PDFIndexer(store, embedIn(dimension), 'cpuOptimized', undefined, false, RAW, extract);

const pdf = (name: string) => path.join(project, 'PDFs', `${name}.pdf`);

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

const chunkOf = (documentId: string, i: number): DocumentChunk => ({
  id: `${documentId}-c${i}`,
  documentId,
  content: `Extrait ${i} de ${documentId} sur la Haute Autorité.`,
  pageNumber: 1,
  chunkIndex: i,
  startPosition: 0,
  endPosition: 10,
});

const vectorOf = (dimension: number, seed: number): Float32Array =>
  new Float32Array(dimension).map((_, j) => Math.sin(seed * 7 + j));

/**
 * Une base où deux modèles ont écrit, comme le laissait un changement de modèle avant ce correctif :
 * `old` extraits en 768 (trois par défaut), écrits les premiers (`LIMIT 1` les voyait donc d'abord),
 * puis six en 1024, trois par document.
 */
function seedMixedBase(old = 3): void {
  const base = new VectorStore(project);
  base.saveDocument(documentOf('ancien'));
  for (let i = 0; i < old; i += 1) base.saveChunk(chunkOf('ancien', i), vectorOf(768, i));
  ['nouveau1', 'nouveau2'].forEach((documentId, d) => {
    base.saveDocument(documentOf(documentId));
    for (let i = 0; i < 3; i += 1) base.saveChunk(chunkOf(documentId, i), vectorOf(1024, 100 + d * 10 + i));
  });
  base.close();
}

const cliodeck = (file: string) => path.join(project, '.cliodeck', file);

/** Ce que `brain.db` contient sur le disque, lu par une autre connexion. */
function onDisk(): { documents: number; chunks: number; mark: boolean } {
  const db = new Database(cliodeck('brain.db'), { readonly: true });
  try {
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const mark = db.prepare('SELECT 1 FROM pdf_index_state WHERE id = 1 AND rebuild_due = 1').get();
    return { documents: count('pdf_documents'), chunks: count('pdf_chunks'), mark: mark !== undefined };
  } finally {
    db.close();
  }
}

const hnsw = async (store: EnhancedVectorStore) => (await store.getStats()).hnsw;

/** Une ouverture de projet : `initialize`, puis ce que fait `pdf-service` une fois le modèle préchauffé. */
async function open(): Promise<{ store: EnhancedVectorStore; events: RebuildProgressEvent[] }> {
  const store = new EnhancedVectorStore(project);
  const events: RebuildProgressEvent[] = [];
  store.setRebuildProgressCallback((event) => events.push(event));
  await store.initialize();
  await PdfVectorStore.maybeRebuild(store);
  return { store, events };
}

describe.skipIf(!sqliteAvailable)('L04-7 : la dimension de l’index des PDF est celle du corpus', () => {
  let opened: EnhancedVectorStore[] = [];
  const track = (store: EnhancedVectorStore) => {
    opened.push(store);
    return store;
  };

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-dimension-'));
    opened = [];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const store of opened) {
      try {
        store.close();
      } catch {
        // déjà fermé
      }
    }
    vi.restoreAllMocks();
    fs.rmSync(project, { recursive: true, force: true });
  });

  describe('corpus vide : la dimension du premier vecteur est adoptée', () => {
    it('modèle à 1024 dimensions sur un projet neuf : la recherche répond dans la session, reconstruction comprise', async () => {
      const { store } = await open();
      track(store);

      await indexer(store, 1024).indexPDF(pdf('Rapport_1952'), 'Rapport_1952');

      const query = await embedIn(1024)(TEXT);
      expect((await hnsw(store)).dimension).toBe(1024);
      expect((await hnsw(store)).currentSize).toBeGreaterThan(0);
      const hits = await store.search('Haute Autorité', query, 5);
      expect(hits.length).toBeGreaterThan(0);

      // La reconstruction que `pdf-service` programme après chaque indexation refaisait l'index vide.
      await store.rebuildIndexes();
      expect((await store.search('Haute Autorité', query, 5)).length).toBeGreaterThan(0);

      // Et la réouverture le relit tel quel, sans rien reconstruire.
      store.close();
      const again = await open();
      track(again.store);
      expect(again.events).toEqual([]);
      expect((await again.store.search('Haute Autorité', query, 5)).length).toBeGreaterThan(0);
    });

    it('purger la base, puis indexer en 1024 un corpus qui était en 768 : la dimension se réadopte', async () => {
      const { store } = await open();
      track(store);
      await indexer(store, 768).indexPDF(pdf('Rapport_1952'), 'Rapport_1952');
      expect((await hnsw(store)).dimension).toBe(768);

      store.purgeAllData();
      await indexer(store, 1024).indexPDF(pdf('Rapport_1952'), 'Rapport_1952');

      expect((await hnsw(store)).dimension).toBe(1024);
      const hits = await store.search('Haute Autorité', await embedIn(1024)(TEXT), 5);
      expect(hits.length).toBeGreaterThan(0);
    });
  });

  describe('corpus non vide, autre dimension : refusé avant toute écriture', () => {
    it('corpus en 768, un PDF embarqué en 1024 : erreur typée, base et index inchangés', async () => {
      const { store } = await open();
      track(store);
      await indexer(store, 768).indexPDF(pdf('Rapport_1952'), 'Rapport_1952');
      const before = onDisk();
      const indexed = (await hnsw(store)).currentSize;

      const refusal = indexer(store, 1024).indexPDF(pdf('Rapport_1953'), 'Rapport_1953');

      await expect(refusal).rejects.toBeInstanceOf(EmbeddingSpaceMismatchError);
      await expect(refusal).rejects.toMatchObject({
        kind: 'dimension',
        code: 'embedding_dimension_mismatch',
        expected: 768,
        actual: 1024,
      });
      expect(onDisk()).toEqual(before);
      expect(await hnsw(store)).toMatchObject({ dimension: 768, currentSize: indexed });
      // Le corpus répond toujours, dans sa dimension.
      expect((await store.search('Haute Autorité', await embedIn(768)(TEXT), 5)).length).toBeGreaterThan(0);
    });

    it('le refus tombe dès le premier embedding : les extraits suivants ne sont pas embarqués pour rien', async () => {
      const { store } = await open();
      track(store);
      await indexer(store, 768).indexPDF(pdf('Rapport_1952'), 'Rapport_1952');
      const chunks = onDisk().chunks;
      expect(chunks).toBeGreaterThan(1);
      const calls: string[] = [];
      const counted = async (content: string) => {
        calls.push(content);
        return embedIn(1024)(content);
      };
      // Un PDF trois fois plus long : six pages, au moins trois fois plus d'extraits.
      const longer = async () => {
        const { pages, ...rest } = await extract();
        return { ...rest, pages: [...pages, ...pages, ...pages].map((page, i) => ({ ...page, pageNumber: i + 1 })) };
      };
      const refusing = new PDFIndexer(store, counted, 'cpuOptimized', undefined, false, RAW, longer);

      await expect(refusing.indexPDF(pdf('Rapport_1953'), 'Rapport_1953')).rejects.toMatchObject({
        code: 'embedding_dimension_mismatch',
      });

      // Un seul appel au fournisseur, pas un par extrait : le refus ne dépend que de la dimension.
      expect(calls).toHaveLength(1);
      expect(onDisk().chunks).toBe(chunks);
    });

    it('réindexer le même PDF avec un autre modèle : refusé aussi, l’ancien document reste', async () => {
      const { store } = await open();
      track(store);
      const document = await indexer(store, 1024).indexPDF(pdf('Rapport_1952'), 'Rapport_1952');
      const before = onDisk();

      await expect(indexer(store, 768).indexPDF(pdf('Rapport_1952'), 'Rapport_1952')).rejects.toMatchObject({
        code: 'embedding_dimension_mismatch',
        expected: 1024,
        actual: 768,
      });

      expect(onDisk()).toEqual(before);
      expect(store.getAllDocuments().map((d: PDFDocument) => d.id)).toEqual([document.id]);
    });

    it('store simple (HNSW et BM25 coupés) : le même refus', async () => {
      fs.mkdirSync(path.join(project, '.cliodeck'), { recursive: true });
      const base = new VectorStore(project);
      try {
        await indexer(base, 768).indexPDF(pdf('Rapport_1952'), 'Rapport_1952');
        const before = onDisk();
        await expect(indexer(base, 1024).indexPDF(pdf('Rapport_1953'), 'Rapport_1953')).rejects.toMatchObject({
          code: 'embedding_dimension_mismatch',
          expected: 768,
          actual: 1024,
        });
        expect(onDisk()).toEqual(before);
      } finally {
        base.close();
      }
    });

    it('une question d’une autre dimension que l’index : la même erreur typée, HNSW actif ou non', async () => {
      const { store } = await open();
      track(store);
      await indexer(store, 768).indexPDF(pdf('Rapport_1952'), 'Rapport_1952');
      const query = await embedIn(1024)(TEXT);

      await expect(store.search('Haute Autorité', query, 5)).rejects.toMatchObject({
        name: 'EmbeddingSpaceMismatchError',
        kind: 'dimension',
        expected: 768,
        actual: 1024,
      });
      store.setUseHNSW(false);
      await expect(store.search('Haute Autorité', query, 5)).rejects.toBeInstanceOf(EmbeddingSpaceMismatchError);
    });
  });

  describe('base déjà mêlée : la dimension majoritaire, une fois pour toutes', () => {
    it('l’index prend la dimension du plus grand nombre, et compte les autres au journal', async () => {
      seedMixedBase();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const { store, events } = await open();
      track(store);

      expect(await hnsw(store)).toMatchObject({ dimension: 1024, currentSize: 6 });
      expect(events.at(-1)?.phase).toBe('done');
      const hits = await store.search('Haute Autorité', vectorOf(1024, 100), 3);
      expect(hits.map((hit) => hit.chunk.documentId)).toContain('nouveau1');
      // Les trois extraits en 768 restent hors de la recherche par le sens : comptés une fois, pas
      // un avertissement par extrait. Ils restent trouvables par les mots (BM25).
      const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(logged).toMatch(/\b3 chunk\(s\) of another embedding dimension/);
      expect(logged).not.toMatch(/Skipping chunk/);
      expect((await store.getStats()).bm25.totalChunks).toBe(9);
      // Rien n'est proposé (J8) : une reconstruction ne les y mettrait pas.
      expect(onDisk().mark).toBe(false);
      expect(store.getRebuildStatus().rebuildDue).toBe(false);
    });

    it('seconde ouverture d’une base mêlée : aucune reconstruction, rien de proposé', async () => {
      seedMixedBase();
      track((await open()).store).close();

      const { store, events } = await open();
      track(store);

      expect(events).toEqual([]);
      expect(store.needsRebuild()).toBe(false);
      expect(store.getRebuildStatus().rebuildDue).toBe(false);
      expect(onDisk().mark).toBe(false);
      expect(await hnsw(store)).toMatchObject({ dimension: 1024, currentSize: 6 });
    });

    it('la majorité bascule en session (un PDF supprimé) : la reconstruction refait l’index dans la nouvelle, et efface la marque', async () => {
      // Quatre extraits en 768, six en 1024 : l'index s'ouvre en 1024.
      seedMixedBase(4);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { store } = await open();
      track(store);
      expect(await hnsw(store)).toMatchObject({ dimension: 1024, currentSize: 6 });

      // Plus que trois en 1024 : la majorité passe en 768, et la suppression pose la marque (J8).
      store.deleteDocument('nouveau1');
      expect(onDisk().mark).toBe(true);
      await PdfVectorStore.maybeRebuild(store);

      expect(await hnsw(store)).toMatchObject({ dimension: 768, currentSize: 4 });
      expect(onDisk().mark).toBe(false);
      expect(store.getRebuildStatus().rebuildDue).toBe(false);
      const hits = await store.search('Haute Autorité', vectorOf(768, 0), 3);
      expect(hits.map((hit) => hit.chunk.documentId)).toContain('ancien');
    });

    it('un index écrit dans la dimension minoritaire (avant ce correctif) : la réouverture le refait dans la majoritaire', async () => {
      seedMixedBase();
      // Ce que laissait `LIMIT 1` : l'index construit sur les trois extraits en 768.
      const old = new HNSWVectorStore(project, 768);
      await old.initialize();
      await old.addChunks([0, 1, 2].map((i) => ({ chunk: chunkOf('ancien', i), embedding: vectorOf(768, i) })));
      await old.save();
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const { store, events } = await open();
      track(store);

      expect(events.at(-1)?.phase).toBe('done');
      expect(await hnsw(store)).toMatchObject({ dimension: 1024, currentSize: 6 });
      expect((await store.search('Haute Autorité', vectorOf(1024, 100), 3)).length).toBeGreaterThan(0);
      // Et c'est fini : la suivante relit cet index.
      store.close();
      const again = await open();
      track(again.store);
      expect(again.events).toEqual([]);
    });
  });
});
