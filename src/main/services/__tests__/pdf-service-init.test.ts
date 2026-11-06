/**
 * Un registre de fournisseurs impossible à construire (backend cloud dont la clé est absente ou
 * illisible au trousseau) faisait échouer `init` : `project:load` refusait d'ouvrir le projet, et le
 * manuscrit devenait inaccessible à cause d'un réglage d'IA. Et un `init` qui échouait après avoir
 * fermé l'ancien magasin le laissait référencé : la bibliographie répondait « The database connection
 * is not open », et une reconstruction ultérieure bâtissait un indexeur dessus (S01-1-10).
 *
 * Vrai `pdfService` ; la configuration passe par la vraie validation de l'adaptateur (c'est elle qui
 * refuse le backend sans clé). Simulés : magasin, indexeur, recherche, et le registre construit — pour
 * qu'aucun fournisseur ne parte sur le réseau.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeStore {
  closed: boolean;
  close: () => void;
  countDuplicateDocuments: () => number;
  getAllDocuments: () => Promise<unknown[]>;
}

const state = vi.hoisted(() => ({
  llm: {} as Record<string, unknown>,
  stores: [] as FakeStore[],
  indexers: [] as Array<{ vectorStore: unknown; indexPDF: ReturnType<typeof vi.fn> }>,
  create: vi.fn(),
  clearRetrieval: vi.fn(),
}));

vi.mock('../config-manager.js', () => ({
  configManager: {
    getLLMConfig: () => ({ ...state.llm }),
    getRAGConfig: () => ({ chunkingConfig: 'cpuOptimized', topK: 10 }),
    get: () => ({}),
  },
}));
vi.mock('../../../../backend/core/llm/providers/cliodeck-config-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../../backend/core/llm/providers/cliodeck-config-adapter.js')
  >();
  return {
    createRegistryFromClioDeckConfig: (cfg: Parameters<typeof actual.clioDeckConfigToRegistryConfig>[0]) => {
      // La vraie validation : lève « Anthropic backend selected but no claudeAPIKey… ».
      actual.clioDeckConfigToRegistryConfig(cfg);
      return {
        getLLM: () => ({}),
        getEmbedding: () => ({ embed: async () => [[0.1]] }),
        dispose: async () => undefined,
      };
    },
  };
});
vi.mock('../pdf/PdfVectorStore.js', () => ({
  PdfVectorStore: {
    create: state.create,
    configureEnhanced: vi.fn(),
    maybeRebuild: async () => undefined,
  },
}));
vi.mock('../pdf/PdfIndexer.js', () => ({
  PdfIndexer: class {
    vectorStore: unknown;
    indexPDF = vi.fn(async () => ({ id: 'doc' }));
    constructor(deps: { vectorStore: unknown }) {
      this.vectorStore = deps.vectorStore;
      state.indexers.push(this);
    }
  },
}));
vi.mock('../pdf-extract-isolated.js', () => ({ extractPdfIsolated: vi.fn() }));
vi.mock('../retrieval-service.js', () => ({
  retrievalService: { configure: vi.fn(), clear: state.clearRetrieval },
}));

const { pdfService } = await import('../pdf-service.js');

/** Un magasin qui, fermé, répond comme better-sqlite3. */
function openStore(): FakeStore {
  const store: FakeStore = {
    closed: false,
    close: () => {
      store.closed = true;
    },
    countDuplicateDocuments: () => 0,
    getAllDocuments: async () => {
      if (store.closed) throw new TypeError('The database connection is not open');
      return [];
    },
  };
  state.stores.push(store);
  return store;
}

beforeEach(async () => {
  await pdfService.close();
  state.llm = { backend: 'ollama', ollamaChatModel: 'llama3.2', ollamaEmbeddingModel: 'nomic-embed-text' };
  state.stores.length = 0;
  state.indexers.length = 0;
  state.clearRetrieval.mockClear();
  state.create.mockReset();
  state.create.mockImplementation(() => ({ store: openStore(), useEnhanced: true, initPromise: undefined }));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('backend cloud sans clé à l’ouverture', () => {
  beforeEach(() => {
    state.llm = { backend: 'claude', claudeModel: 'claude-sonnet-4-6' };
  });

  it('le projet s’ouvre : le magasin répond, seule l’indexation dit pourquoi elle ne peut pas', async () => {
    await expect(pdfService.init('/projet')).resolves.toBeUndefined();

    expect(pdfService.getVectorStore()).not.toBeNull();
    expect(pdfService.getCurrentProjectPath()).toBe('/projet');
    await expect(pdfService.getAllDocuments()).resolves.toEqual([]);
    expect(pdfService.providersMissing()).toBe(true);
    await expect(pdfService.indexPDF('/projet/a.pdf')).rejects.toThrow(
      /Fournisseur d'embeddings indisponible : Anthropic backend selected but no claudeAPIKey/
    );
    expect(state.indexers).toHaveLength(0);
  });

  it('une reconstruction échoue toujours franchement (le panneau des réglages doit le savoir)', async () => {
    await pdfService.init('/projet');

    await expect(pdfService.refreshProviders({ embeddingChanged: true })).rejects.toThrow(/claudeAPIKey/);
    expect(pdfService.getVectorStore()).not.toBeNull();
  });

  it('la clé saisie ensuite : la reconstruction refait l’indexeur, sans rouvrir le projet', async () => {
    await pdfService.init('/projet');

    state.llm = { ...state.llm, claudeAPIKey: 'sk-ant-factice' };
    await pdfService.refreshProviders({ embeddingChanged: true });

    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.indexers).toHaveLength(1);
    await expect(pdfService.indexPDF('/projet/a.pdf')).resolves.toEqual({ id: 'doc' });
  });
});

describe('le nouveau magasin ne s’ouvre pas', () => {
  beforeEach(async () => {
    await pdfService.init('/projet-a');
    state.create.mockImplementation(() => {
      throw new Error('SQLITE_CANTOPEN');
    });
    await expect(pdfService.init('/projet-b')).rejects.toThrow('SQLITE_CANTOPEN');
  });

  it('l’ancien magasin, fermé, n’est plus référencé', async () => {
    expect(state.stores[0].closed).toBe(true);
    expect(pdfService.getVectorStore()).toBeNull();
    expect(pdfService.getCurrentProjectPath()).toBeNull();
    expect(state.clearRetrieval).toHaveBeenCalled();
    await expect(pdfService.getAllDocuments()).rejects.toThrow(/not initialized/);
    await expect(pdfService.indexPDF('/projet-b/a.pdf')).rejects.toThrow(/not initialized/);
  });

  it('une reconstruction des fournisseurs ne bâtit pas d’indexeur sur le magasin fermé', async () => {
    await pdfService.refreshProviders({ embeddingChanged: true });

    expect(state.indexers).toHaveLength(1);
    await expect(pdfService.indexPDF('/projet-b/a.pdf')).rejects.toThrow(/not initialized/);
  });
});
