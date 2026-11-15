/**
 * Ce qui dit qu'un corpus a changé, pour l'empreinte du cache de similarité (S13-1-1).
 *
 * L'empreinte lisait `stats.documents` et `stats.chunks`, deux champs que `getStatistics` ne rend
 * pas : elle valait toujours la même chose, et indexer de nouveaux PDF n'invalidait jamais le cache.
 * Le nombre de documents ne suffit pas : une réindexation remplace un document par un autre. Sa
 * date d'indexation, elle, est neuve.
 *
 * Côté sources primaires, deux chemins refont les extraits sans toucher la ligne de la source,
 * donc sans changer `indexed_at`, et souvent sans changer leur nombre : la réindexation des
 * extraits périmés (H7) et la transcription d'une carte (OCR manuel, import). `MAX(rowid)` ne suit
 * pas non plus : les extraits réécrits de la dernière source reprennent les mêmes numéros. L'id
 * de l'extrait écrit le dernier, lui, est neuf à chaque écriture.
 *
 * Vrais magasins, `brain.db` temporaire.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sqliteAvailable } from '../../../__tests__/helpers/native-guards.js';
import type { DocumentChunk, PDFDocument } from '../../../types/pdf-document.js';
import { EnhancedVectorStore } from '../EnhancedVectorStore.js';
import { VectorStore } from '../VectorStore.js';
import { PrimarySourcesVectorStore, type PrimarySourceChunk } from '../PrimarySourcesVectorStore.js';

let project = '';

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-fraicheur-'));
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

const documentOf = (id: string, indexedAt: string): PDFDocument => {
  const at = new Date(indexedAt);
  return {
    id,
    fileURL: path.join(project, `${id}.pdf`),
    title: id,
    pageCount: 1,
    metadata: {},
    createdAt: at,
    indexedAt: at,
    lastAccessedAt: at,
    displayString: id,
  } as PDFDocument;
};

const chunkOf = (documentId: string): DocumentChunk => ({
  id: `${documentId}-c0`,
  documentId,
  content: `Extrait de ${documentId}.`,
  pageNumber: 1,
  chunkIndex: 0,
  startPosition: 0,
  endPosition: 10,
});

const vector = (seed: number): Float32Array => new Float32Array(768).map((_, j) => Math.sin(seed * 7 + j));

describe.skipIf(!sqliteAvailable)('PDF — date du dernier document indexé', () => {
  it('null sur une base vide, puis la plus récente, magasin simple comme enrichi', () => {
    const base = new VectorStore(project);
    try {
      expect(base.getLastIndexedAt()).toBeNull();
      base.saveDocument(documentOf('ancien', '2026-11-01T10:00:00.000Z'));
      base.saveDocument(documentOf('recent', '2026-11-14T09:30:00.000Z'));
      base.saveChunk(chunkOf('recent'), vector(1));
      expect(base.getLastIndexedAt()).toBe('2026-11-14T09:30:00.000Z');
    } finally {
      base.close();
    }

    const enhanced = new EnhancedVectorStore(project);
    try {
      expect(enhanced.getLastIndexedAt()).toBe('2026-11-14T09:30:00.000Z');
      expect(enhanced.getStatistics()).toMatchObject({ documentCount: 2, chunkCount: 1 });
    } finally {
      enhanced.close();
    }
  });
});

describe.skipIf(!sqliteAvailable)('sources primaires — date de la dernière source et dernier extrait écrit', () => {
  let store: PrimarySourcesVectorStore;

  beforeEach(() => {
    store = new PrimarySourcesVectorStore(project);
  });

  afterEach(() => {
    store.close();
  });

  const addSource = (id: string): void => {
    store.saveSource({
      id,
      tropyId: Number(id.replace(/\D/g, '')) || 1,
      title: `Pièce ${id}`,
      tags: [],
      photos: [],
      transcription: `Corps de la pièce ${id}.`,
      transcriptionSource: 'tesseract',
      lastModified: new Date('2026-05-06T13:13:22.394Z'),
      metadata: {},
    });
  };

  const chunks = (sourceId: string, tag: string): Array<{ chunk: PrimarySourceChunk; embedding: Float32Array }> =>
    [0, 1, 2].map((i) => ({
      chunk: {
        id: `${sourceId}-${tag}-${i}`,
        sourceId,
        content: `Extrait ${i} de ${sourceId}`,
        chunkIndex: i,
        startPosition: 0,
        endPosition: 10,
      },
      embedding: vector(i + sourceId.length),
    }));

  it('null sur une base vide, puis la date de la dernière source écrite', () => {
    expect(store.getLastIndexedAt()).toBeNull();
    expect(store.getLastChunkId()).toBeNull();

    addSource('src-1');
    const first = store.getLastIndexedAt();
    expect(first).not.toBeNull();
    expect(new Date(first!).toISOString()).toBe(first);
  });

  it('réécrire les extraits de la dernière source, autant qu’avant : la date et le nombre restent, le dernier extrait change', () => {
    addSource('src-1');
    addSource('src-2');
    store.replaceSourceChunks('src-1', chunks('src-1', 'v1'));
    store.replaceSourceChunks('src-2', chunks('src-2', 'v1'));
    const before = {
      at: store.getLastIndexedAt(),
      count: store.getStatistics().chunkCount,
      last: store.getLastChunkId(),
    };
    expect(before.last).toBe('src-2-v1-2');

    // Ce que font la réindexation H7 et la transcription d'une carte : les extraits seuls.
    store.replaceSourceChunks('src-2', chunks('src-2', 'v2'));

    expect(store.getLastIndexedAt()).toBe(before.at);
    expect(store.getStatistics().chunkCount).toBe(before.count);
    expect(store.getLastChunkId()).toBe('src-2-v2-2');
  });

  it('réécrire une autre source que la dernière change aussi le dernier extrait', () => {
    addSource('src-1');
    addSource('src-2');
    store.replaceSourceChunks('src-1', chunks('src-1', 'v1'));
    store.replaceSourceChunks('src-2', chunks('src-2', 'v1'));

    store.replaceSourceChunks('src-1', chunks('src-1', 'v2'));

    expect(store.getLastChunkId()).toBe('src-1-v2-2');
  });
});
