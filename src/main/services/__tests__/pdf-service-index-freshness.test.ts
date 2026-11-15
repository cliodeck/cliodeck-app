/**
 * L'état du corpus des PDF que lit l'empreinte du cache de similarité (S13-1-1, L11-2).
 *
 * Avec un filtre de collections, l'empreinte ne voyait pas une appartenance changée par une
 * synchronisation Zotero : celle-ci rattache de nouveau les documents à leurs collections
 * (`linkDocumentsToCollectionsByBibtexKey`) sans rien réindexer, et le nombre de documents,
 * d'extraits et la date du dernier indexé restent les mêmes. Une analyse restreinte à la collection
 * X restait servie 24 h, sans les références entrées dans X. Avec un filtre, l'état porte donc les
 * documents qu'il retient, comme la recherche : sous-collections comprises.
 *
 * Vrai `pdfService`, vrai magasin (`EnhancedVectorStore`) sur un vrai `brain.db`. Simulés : la
 * configuration, le registre des fournisseurs, l'indexeur et la recherche, qui ne servent pas ici.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sqliteAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';
import type { DocumentChunk, PDFDocument } from '../../../../backend/types/pdf-document.js';
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

const documentOf = (documentId: string, bibtexKey: string): PDFDocument => {
  const now = new Date('2026-11-14T09:00:00.000Z');
  return {
    id: documentId,
    fileURL: path.join(project, `${documentId}.pdf`),
    title: documentId,
    bibtexKey,
    pageCount: 1,
    metadata: {},
    createdAt: now,
    indexedAt: now,
    lastAccessedAt: now,
    displayString: documentId,
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

/** Deux PDF ; « Février 1934 », sous-collection de « Guerre », contient le premier. */
async function seedProject(): Promise<void> {
  const base = new VectorStore(project);
  [
    ['doc1', 'Berstein_1975'],
    ['doc2', 'Jackson_1985'],
  ].forEach(([documentId, bibtexKey], d) => {
    base.saveDocument(documentOf(documentId, bibtexKey));
    base.saveChunk(chunkOf(documentId), new Float32Array(768).map((_, j) => Math.sin(d * 100 + j)));
  });
  base.saveCollections([
    { key: 'GUERRE', name: 'Guerre' },
    { key: 'FEVRIER', name: 'Février 1934', parentKey: 'GUERRE' },
    { key: 'FRONT', name: 'Front populaire' },
  ]);
  base.setDocumentCollections('doc1', ['FEVRIER']);
  base.close();
  const store = new EnhancedVectorStore(project);
  await store.rebuildIndexes();
  store.close();
}

describe.skipIf(!sqliteAvailable)('pdfService.getIndexFreshness : l’appartenance aux collections du filtre', () => {
  beforeEach(async () => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-pdf-fraicheur-'));
    state.embed.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await seedProject();
    const warmups = state.embed.mock.calls.length;
    await pdfService.init(project, () => undefined);
    await vi.waitFor(() => expect(state.embed.mock.calls.length).toBe(warmups + 1));
  });

  afterEach(async () => {
    await pdfService.close();
    vi.restoreAllMocks();
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('sans filtre : rien sur les collections', () => {
    expect(pdfService.getIndexFreshness().collectionDocumentIds).toBeNull();
    expect(pdfService.getIndexFreshness([]).collectionDocumentIds).toBeNull();
  });

  it('avec un filtre : les documents qu’il retient, sous-collections comprises', () => {
    expect(pdfService.getIndexFreshness(['GUERRE']).collectionDocumentIds).toEqual(['doc1']);
    expect(pdfService.getIndexFreshness(['FRONT']).collectionDocumentIds).toEqual([]);
  });

  it('une synchronisation Zotero rattache un document à la collection : l’état change, le reste non', () => {
    const before = pdfService.getIndexFreshness(['GUERRE']);

    pdfService.getVectorStore()!.linkDocumentsToCollectionsByBibtexKey({ Jackson_1985: ['GUERRE'] });

    const after = pdfService.getIndexFreshness(['GUERRE']);
    expect(after.collectionDocumentIds).toEqual(['doc1', 'doc2']);
    // Ce que lisait l'empreinte seule : inchangé, d'où le défaut.
    const { collectionDocumentIds: _before, ...rest } = before;
    const { collectionDocumentIds: _after, ...restAfter } = after;
    expect(restAfter).toEqual(rest);
  });
});
