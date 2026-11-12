/**
 * J8 : à la réouverture, le service PDF propose de reconstruire l'index que la session précédente a
 * laissé périmé (une suppression, puis le projet fermé avant la reconstruction programmée), et
 * « Reconstruire » le refait depuis les vecteurs de SQLite, sans rien envoyer au fournisseur.
 *
 * Vrai `pdfService`, vrai magasin (`EnhancedVectorStore`) sur un vrai `brain.db`, vraie
 * reconstruction. Simulés : la configuration, le registre des fournisseurs (un espion sur `embed`),
 * l'indexeur et la recherche, qui ne servent pas ici.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sqliteAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';
import type { DocumentChunk, PDFDocument } from '../../../../backend/types/pdf-document.js';
import type { RebuildProgressEvent } from '../../../../backend/types/rebuild-progress.js';
import { EnhancedVectorStore } from '../../../../backend/core/vector-store/EnhancedVectorStore.js';
import { VectorStore } from '../../../../backend/core/vector-store/VectorStore.js';

const state = vi.hoisted(() => ({
  embed: vi.fn(async (texts: string[]) => texts.map(() => new Array(768).fill(0.1))),
}));

vi.mock('../config-manager.js', () => ({
  configManager: {
    getLLMConfig: () => ({ backend: 'ollama', ollamaChatModel: 'llama3.2', ollamaEmbeddingModel: 'nomic-embed-text' }),
    getRAGConfig: () => ({ chunkingConfig: 'cpuOptimized', topK: 10 }),
    get: () => ({}),
  },
}));
vi.mock('../../../../backend/core/llm/providers/cliodeck-config-adapter.js', () => ({
  createRegistryFromClioDeckConfig: () => ({
    getLLM: () => ({}),
    getEmbedding: () => ({ embed: state.embed }),
    dispose: async () => undefined,
  }),
}));
vi.mock('../pdf/PdfIndexer.js', () => ({ PdfIndexer: class {} }));
vi.mock('../pdf-extract-isolated.js', () => ({ extractPdfIsolated: vi.fn() }));
vi.mock('../retrieval-service.js', () => ({
  retrievalService: { configure: vi.fn(), clear: vi.fn(), drainSearches: vi.fn(async () => undefined) },
}));

const { pdfService } = await import('../pdf-service.js');

let project = '';
let events: RebuildProgressEvent[] = [];

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
  content: `Extrait ${i} de ${documentId}.`,
  pageNumber: 1,
  chunkIndex: i,
  startPosition: 0,
  endPosition: 10,
});

/** Deux PDF indexés et leur index HNSW à jour sur le disque. */
async function seedHealthyProject(): Promise<void> {
  const base = new VectorStore(project);
  ['doc1', 'doc2'].forEach((documentId, d) => {
    base.saveDocument(documentOf(documentId));
    for (let i = 0; i < 6; i += 1) {
      base.saveChunk(chunkOf(documentId, i), new Float32Array(768).map((_, j) => Math.sin((d * 100 + i) * 7 + j)));
    }
  });
  base.close();
  const store = new EnhancedVectorStore(project);
  await store.rebuildIndexes();
  store.close();
}

/**
 * Ouvre le projet comme la séquence, et attend la fin de ce que l'ouverture lance d'elle-même : le
 * préchauffage du modèle d'embeddings, puis la reconstruction d'office si l'index en demande une.
 */
async function open(): Promise<void> {
  const warmups = state.embed.mock.calls.length;
  await pdfService.init(project, (event) => events.push(event));
  await vi.waitFor(() => expect(state.embed.mock.calls.length).toBe(warmups + 1));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const hnswSize = async (): Promise<number> =>
  (await (pdfService.getVectorStore() as EnhancedVectorStore).getStats()).hnsw.currentSize;

describe.skipIf(!sqliteAvailable)('pdfService : la reconstruction due, proposée à la réouverture', () => {
  beforeEach(async () => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-pdf-reconstruction-due-'));
    events = [];
    state.embed.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await seedHealthyProject();
  });

  afterEach(async () => {
    await pdfService.close();
    vi.restoreAllMocks();
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('fermé avant la reconstruction programmée : la réouverture la propose, et « Reconstruire » la fait sans le fournisseur', async () => {
    await open();
    await pdfService.deleteDocument('doc2');
    // Avant les 2 s de `scheduleIndexRebuild` : la reconstruction programmée est annulée.
    await pdfService.close();
    expect(events).toEqual([]);

    await open();

    // Rien d'office, et l'état est exposé.
    expect(events).toEqual([]);
    expect(pdfService.getIndexState()).toEqual({ rebuildDue: true });
    expect(await hnswSize()).toBe(12);

    state.embed.mockClear();
    expect(pdfService.rebuildIndexOnRequest()).toBe(true);
    await vi.waitFor(() => expect(events.at(-1)?.phase).toBe('done'));

    expect(state.embed).not.toHaveBeenCalled();
    expect(await hnswSize()).toBe(6);
    expect(pdfService.getIndexState()).toEqual({ rebuildDue: false });
    await pdfService.close();

    events = [];
    await open();
    expect(events).toEqual([]);
    expect(pdfService.getIndexState()).toEqual({ rebuildDue: false });
  });

  it('la reconstruction demandée puis le projet fermé aussitôt : abandonnée, la marque reste pour la réouverture suivante', async () => {
    await open();
    await pdfService.deleteDocument('doc2');
    await pdfService.close();
    await open();

    expect(pdfService.rebuildIndexOnRequest()).toBe(true);
    await pdfService.close();

    expect(events).toEqual([]);
    await open();
    expect(events).toEqual([]);
    expect(pdfService.getIndexState()).toEqual({ rebuildDue: true });
  });

  it('un index sain : rien n’est proposé, et la demande ne lance rien', async () => {
    await open();

    expect(pdfService.getIndexState()).toEqual({ rebuildDue: false });
    expect(pdfService.rebuildIndexOnRequest()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual([]);
  });

  it('pendant la session, la reconstruction qui suit une suppression reste automatique et efface la marque', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await pdfService.init(project, (event) => events.push(event));
      await vi.advanceTimersByTimeAsync(0);
      await pdfService.deleteDocument('doc2');

      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
    }

    expect(events.at(-1)?.phase).toBe('done');
    expect(pdfService.getIndexState()).toEqual({ rebuildDue: false });
    await pdfService.close();
    events = [];
    await open();
    expect(events).toEqual([]);
    expect(pdfService.getIndexState()).toEqual({ rebuildDue: false });
  });
});
