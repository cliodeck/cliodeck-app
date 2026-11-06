/**
 * Une bibliographie vide n'est pas une bibliographie en panne (P212-F).
 *
 * Sur un projet neuf, sans aucun PDF, l'index HNSW est vide et la recherche
 * levait « Search indexes are not available » : le corpus était rapporté en
 * échec, et le chat disait à chaque question que des recherches avaient
 * échoué. Vide, il n'y a rien à trouver : la recherche rend une liste vide.
 * Un index vide alors que SQLite a des extraits, lui, reste une panne : les
 * extraits existent et la recherche ne peut pas les atteindre.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sqliteAvailable } from '../../../__tests__/helpers/native-guards.js';
import type { PDFDocument } from '../../../types/pdf-document.js';
import { EnhancedVectorStore } from '../EnhancedVectorStore.js';
import { VectorStore } from '../VectorStore.js';

let project = '';

const embedding = (): Float32Array => new Float32Array(768).fill(0.1);

describe.skipIf(!sqliteAvailable)('EnhancedVectorStore : un corpus vide', () => {
  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-corpus-vide-'));
  });

  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('projet sans aucun PDF : la recherche rend une liste vide, sans lever', async () => {
    const store = new EnhancedVectorStore(project);
    await store.initialize();
    try {
      await expect(store.search('la crise de 1929', embedding(), 5)).resolves.toEqual([]);
    } finally {
      store.close();
    }
  });

  it('extraits dans SQLite mais index HNSW vide : la recherche lève toujours', async () => {
    const seed = new VectorStore(project);
    const now = new Date();
    seed.saveDocument({
      id: 'doc1',
      fileURL: path.join(project, 'doc1.pdf'),
      title: 'A',
      pageCount: 1,
      metadata: {},
      createdAt: now,
      indexedAt: now,
      lastAccessedAt: now,
      displayString: 'A',
    } as PDFDocument);
    seed.saveChunk(
      {
        id: 'doc1-c0',
        documentId: 'doc1',
        content: 'Extrait sur la crise de 1929.',
        pageNumber: 1,
        chunkIndex: 0,
        startPosition: 0,
        endPosition: 10,
      },
      embedding()
    );
    seed.close();

    // Sans `initialize()` : l'index n'est pas reconstruit depuis SQLite.
    const store = new EnhancedVectorStore(project);
    try {
      await expect(store.search('la crise de 1929', embedding(), 5)).rejects.toThrow(
        'Search indexes are not available'
      );
    } finally {
      store.close();
    }
  });
});
