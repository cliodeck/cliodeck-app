/**
 * Un PDF dont l'index de recherche (HNSW, BM25) ne s'écrit pas, une fois sa transaction validée,
 * est complet en base : la reconstruction planifiée après chaque indexation remettra ses extraits
 * dans l'index, depuis SQLite. L'indexeur rendait pourtant un échec au main, qui sautait alors ce
 * qui suit : le rattachement aux collections Zotero (#130), l'avertissement des PDF image (#132) et
 * le journal. Le lot suivant compte ce document indexé et ne le repropose plus : il restait hors de
 * sa collection, et le filtre par collection de l'assistant ne le trouvait pas, jusqu'à la prochaine
 * synchronisation Zotero.
 *
 * Le vrai `PdfIndexer` du main sur un vrai store de l'app ; seuls l'extraction isolée et les
 * embeddings sont simulés.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sqliteAvailable } from '../../../../backend/__tests__/helpers/native-guards';
import { EnhancedVectorStore } from '../../../../backend/core/vector-store/EnhancedVectorStore';
import type { EmbeddingProvider } from '../../../../backend/core/llm/providers/base';
import type { RAGConfig } from '../../../../backend/types/config';
import { PdfIndexer } from '../pdf/PdfIndexer';

const TITLE = 'Digital Doping for Historians';

vi.mock('../pdf-extract-isolated.js', () => {
  const text =
    'Digital history requires historians to reflect on the transformations their tools impose on sources. ' +
    'Each software layer rewrites the source like a palimpsest, and the historian must document every layer carefully. ';
  return {
    extractPdfIsolated: async () => ({
      ok: true,
      pages: [{ pageNumber: 1, text: text.repeat(8) }],
      metadata: {},
      title: 'Digital Doping for Historians',
    }),
  };
});

const FILE = '/projet/PDFs/Kansteiner_2022.pdf';
const KEY = 'Kansteiner_2022';

/** 768 : la dimension par défaut de l'index HNSW d'un projet neuf. */
function vector(content: string): number[] {
  const v = new Array<number>(768).fill(0);
  for (let i = 0; i < content.length; i++) v[i % 768] += content.charCodeAt(i) / 1000;
  return v;
}

const embeddingProvider: EmbeddingProvider = {
  id: 'faux',
  name: 'Faux fournisseur',
  dimension: 768,
  model: 'faux',
  getStatus: () => ({ state: 'ready' }),
  healthCheck: async () => ({ state: 'ready' }),
  embed: async (texts) => texts.map(vector),
  dispose: async () => undefined,
};

/** Filtres coupés : le texte répété donne alors plusieurs extraits. */
const ragConfig: RAGConfig = {
  topK: 10,
  similarityThreshold: 0.12,
  chunkingConfig: 'cpuOptimized',
  useAdaptiveChunking: false,
  enablePreprocessing: false,
  enableQualityFiltering: false,
  enableDeduplication: false,
};

describe.skipIf(!sqliteAvailable)('PDF : l’index de recherche ne s’écrit pas après la transaction', () => {
  let dir: string;
  let store: EnhancedVectorStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-index-collections-'));
    store = new EnhancedVectorStore(dir);
    await store.initialize();
    // La dernière synchronisation Zotero : la référence est dans la collection C1.
    store.saveCollections([{ key: 'C1', name: 'Mémoire numérique' }]);
    store.replaceCollectionMemberships({ [KEY]: ['C1'] });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('première indexation : la passe réussit, et le document rejoint sa collection', async () => {
    // Une écriture de l'index rendue impossible, comme sur un disque réel.
    fs.mkdirSync(path.join(dir, '.cliodeck', 'hnsw.index.meta.json.tmp'), { recursive: true });
    const indexer = new PdfIndexer({
      vectorStore: store,
      embeddingProvider,
      ragConfig,
      summarizerConfig: { enabled: false, method: 'extractive', maxLength: 250 },
    });

    const document = await indexer.indexPDF(FILE, KEY, undefined, { title: TITLE, author: 'Kansteiner, Wulf', year: '2022' });

    expect(store.getChunksForDocument(document.id).length).toBeGreaterThan(0);
    expect(store.getDocumentIdsInCollections(['C1'])).toEqual([document.id]);
    expect(store.needsRebuild()).toBe(true);
  });
});
