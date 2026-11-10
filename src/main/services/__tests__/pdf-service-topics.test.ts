/**
 * Ce que l'Explorer reçoit juste après « Analyser les topics » (L02-10).
 *
 * `saveTopicAnalysis` enregistre l'analyse sans les documents retirés pendant le calcul, ses thèmes
 * recomptés, un thème vidé non enregistré. `analyzeTopics` renvoyait pourtant le résultat brut du
 * calcul : les cartes gardaient la taille d'avant, un thème vidé restait affiché, et les exports
 * contenaient l'id disparu, alors que la frise, relue dans brain.db, était déjà filtrée. Le même écran
 * montrait deux analyses jusqu'au prochain chargement.
 *
 * Vrai `pdfService`, vrai `VectorStore` sur un vrai brain.db dans un dossier temporaire. Simulés : le
 * service Python des thèmes (aucun venv touché), la configuration, le registre des fournisseurs (rien
 * ne part sur le réseau) et la recherche.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sqliteAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';
import { VectorStore } from '../../../../backend/core/vector-store/VectorStore.js';
import type { PDFDocument } from '../../../../backend/types/pdf-document.js';
import type { TopicAnalysisResult } from '../../../../backend/core/analysis/TopicModelingService.js';

const state = vi.hoisted(() => ({
  store: null as VectorStore | null,
  /** Ce que fait le calcul pendant qu'il tourne, avant de rendre son résultat. */
  duringAnalysis: (() => undefined) as () => void,
  result: null as TopicAnalysisResult | null,
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
    getEmbedding: () => ({ embed: async () => [[0.1]] }),
    dispose: async () => undefined,
  }),
}));
vi.mock('../pdf/PdfVectorStore.js', () => ({
  PdfVectorStore: {
    create: () => ({ store: state.store, useEnhanced: false, initPromise: undefined }),
    configureEnhanced: vi.fn(),
    maybeRebuild: async () => undefined,
  },
}));
vi.mock('../pdf/PdfIndexer.js', () => ({
  PdfIndexer: class {
    indexPDF = vi.fn();
  },
}));
vi.mock('../pdf-extract-isolated.js', () => ({ extractPdfIsolated: vi.fn() }));
vi.mock('../retrieval-service.js', () => ({
  retrievalService: { configure: vi.fn(), clear: vi.fn() },
}));
vi.mock('../topic-modeling-service.js', () => ({
  topicModelingService: {
    getStatus: () => ({ isRunning: true, isStarting: false }),
    start: vi.fn(),
    analyzeTopics: async () => {
      state.duringAnalysis();
      return structuredClone(state.result);
    },
  },
}));

const { pdfService } = await import('../pdf-service.js');

function doc(id: string, year: string): PDFDocument {
  const date = new Date('2026-11-01T10:00:00Z');
  return {
    id,
    fileURL: `/projet/PDFs/${id}.pdf`,
    title: `Titre ${id}`,
    year,
    pageCount: 1,
    metadata: {},
    createdAt: date,
    indexedAt: date,
    lastAccessedAt: date,
    get displayString() {
      return this.title;
    },
  };
}

/** Résultat tel que le rend le service Python : thèmes triés par taille, `size` = nombre de documents. */
const computed: TopicAnalysisResult = {
  topics: [
    { id: 1, label: 'forge - archives', keywords: ['forge', 'archives'], documents: ['c', 'd', 'e'], size: 3 },
    { id: 0, label: 'palimpseste - source', keywords: ['palimpseste', 'source'], documents: ['a', 'b'], size: 2 },
    { id: 2, label: 'presse - image', keywords: ['presse', 'image'], documents: ['f'], size: 1 },
  ],
  topicAssignments: { a: 0, b: 0, c: 1, d: 1, e: 1, f: 2 },
  outliers: ['g'],
  statistics: { totalDocuments: 7, numTopics: 3, numOutliers: 1, numDocumentsInTopics: 6 },
};

describe.skipIf(!sqliteAvailable)('pdfService.analyzeTopics : ce que reçoit l’Explorer', () => {
  let dir: string;

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-service-topics-'));
    const store = new VectorStore(dir);
    state.store = store;
    state.result = computed;
    state.duringAnalysis = () => undefined;
    ['a', 'b', 'c', 'd', 'e', 'f', 'g'].forEach((id, i) => {
      store.saveDocument(doc(id, String(2010 + i)));
      store.saveChunk(
        { id: `${id}-0`, documentId: id, content: `texte ${id}`, pageNumber: 1, chunkIndex: 0, startPosition: 0, endPosition: 7 },
        new Float32Array(8).fill(i + 1)
      );
    });
    await pdfService.init(dir);
  });

  afterEach(async () => {
    await pdfService.close();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('des documents retirés pendant le calcul : l’Explorer reçoit l’analyse enregistrée, pas le résultat brut', async () => {
    // e et f retirés (« Ré-indexer », suppression) pendant le calcul, juste avant l'enregistrement.
    state.duringAnalysis = () => {
      state.store!.deleteDocument('e');
      state.store!.deleteDocument('f');
    };

    const shown = await pdfService.analyzeTopics();

    // Ce que montrent les cartes, le filtre par thème et les exports JSON, CSV et MD.
    expect(shown.topicAssignments).toEqual({ a: 0, b: 0, c: 1, d: 1 });
    expect(shown.outliers).toEqual(['g']);
    expect(shown.topics.map((t) => ({ id: t.id, size: t.size, documents: [...t.documents].sort() }))).toEqual([
      { id: 0, size: 2, documents: ['a', 'b'] },
      { id: 1, size: 2, documents: ['c', 'd'] },
    ]);
    // Et c'est bien l'analyse que rouvrira le projet.
    expect(shown).toEqual(pdfService.loadTopicAnalysis());
  });

  it('témoin : sans document retiré, l’Explorer reçoit les mêmes thèmes, affectations et statistiques', async () => {
    const shown = await pdfService.analyzeTopics();

    expect(shown.topicAssignments).toEqual(computed.topicAssignments);
    expect(shown.outliers).toEqual(computed.outliers);
    expect(shown.statistics).toEqual(computed.statistics);
    const byId = (topics: TopicAnalysisResult['topics']) =>
      [...topics]
        .sort((x, y) => x.id - y.id)
        .map((t) => ({ ...t, documents: [...t.documents].sort() }));
    expect(byId(shown.topics)).toEqual(byId(computed.topics));
  });
});
