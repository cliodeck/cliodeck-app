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
import { ProjectChangedError, type ProjectHandle } from '../../../../backend/types/project-handle.js';

interface FakeStore {
  closed: boolean;
  close: () => void;
  countDuplicateDocuments: () => number;
  getAllDocuments: () => Promise<unknown[]>;
  deleteDocument: () => boolean;
}

const state = vi.hoisted(() => ({
  llm: {} as Record<string, unknown>,
  stores: [] as FakeStore[],
  indexers: [] as Array<{ vectorStore: unknown; indexPDF: ReturnType<typeof vi.fn> }>,
  create: vi.fn(),
  clearRetrieval: vi.fn(),
  maybeRebuild: vi.fn(async (_store: unknown) => undefined),
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
    maybeRebuild: state.maybeRebuild,
  },
}));
vi.mock('../pdf/PdfIndexer.js', () => ({
  PdfIndexer: class {
    vectorStore: unknown;
    // Comme le vrai : un indexeur dont le magasin est fermé écrit sur une base fermée.
    indexPDF = vi.fn(async () => {
      if ((this.vectorStore as { closed?: boolean }).closed) {
        throw new TypeError('The database connection is not open');
      }
      return { id: 'doc' };
    });
    constructor(deps: { vectorStore: unknown }) {
      this.vectorStore = deps.vectorStore;
      state.indexers.push(this);
    }
  },
}));
vi.mock('../pdf-extract-isolated.js', () => ({ extractPdfIsolated: vi.fn() }));
vi.mock('../retrieval-service.js', () => ({
  retrievalService: { configure: vi.fn(), clear: state.clearRetrieval, drainSearches: vi.fn(async () => undefined) },
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
    deleteDocument: () => true,
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
  state.maybeRebuild.mockClear();
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

describe('le nouveau magasin s’ouvre mais son initialisation échoue', () => {
  it('le magasin ouvert par cet init est fermé, pas abandonné ouvert', async () => {
    await pdfService.init('/projet-a');
    state.create.mockImplementation(() => ({
      store: openStore(),
      useEnhanced: true,
      initPromise: Promise.reject(new Error('HNSW illisible')),
    }));

    await expect(pdfService.init('/projet-b')).rejects.toThrow('HNSW illisible');

    expect(state.stores).toHaveLength(2);
    expect(state.stores[0].closed).toBe(true);
    // Plus rien ne le référence : resté ouvert, sa poignée sur brain.db ne serait jamais rendue.
    expect(state.stores[1].closed).toBe(true);
    expect(pdfService.getVectorStore()).toBeNull();
  });
});

/**
 * Une ouverture abandonnée (délai tombé, autre service en panne) continue pendant que la séquence
 * referme ce projet et rouvre le précédent, sur ce même singleton. Elle ne s'installe pas : sinon le
 * magasin de B remplacerait celui de A rouvert entre-temps, et la recherche répondrait avec B.
 */
describe('une ouverture dont le handle n’est plus courant', () => {
  function handleFor(projectPath: string): ProjectHandle & { end: () => void } {
    const controller = new AbortController();
    return {
      path: projectPath,
      epoch: 1,
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
      assertCurrent: () => {
        if (controller.signal.aborted) throw new ProjectChangedError();
      },
      end: () => controller.abort(),
    };
  }

  it('s’arrête après l’attente de son index : son magasin est fermé, celui de A reste installé', async () => {
    let finishB!: () => void;
    state.create.mockImplementationOnce(() => ({
      store: openStore(),
      useEnhanced: true,
      initPromise: new Promise<void>((resolve) => {
        finishB = resolve;
      }),
    }));
    const handleB = handleFor('/projet-b');
    const openingB = pdfService.init('/projet-b', undefined, handleB);
    await new Promise((r) => setImmediate(r));

    // La séquence abandonne B et rouvre A pendant que l'index de B se charge encore.
    handleB.end();
    await pdfService.close();
    await pdfService.init('/projet-a', undefined, handleFor('/projet-a'));
    finishB();
    await openingB.catch(() => undefined);

    const [storeB, storeA] = state.stores;
    expect(storeB.closed).toBe(true);
    expect(storeA.closed).toBe(false);
    expect(pdfService.getVectorStore()).toBe(storeA);
    expect(pdfService.getCurrentProjectPath()).toBe('/projet-a');
  });
});

describe('une ouverture abandonnée qui échoue ensuite', () => {
  it('son échec ne défait pas le projet ouvert entre-temps', async () => {
    let failB!: (error: Error) => void;
    state.create.mockImplementationOnce(() => ({
      store: openStore(),
      useEnhanced: true,
      initPromise: new Promise<void>((_resolve, reject) => {
        failB = reject;
      }),
    }));
    const controller = new AbortController();
    const handleB: ProjectHandle = {
      path: '/projet-b',
      epoch: 1,
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
      assertCurrent: () => undefined,
    };
    const openingB = pdfService.init('/projet-b', undefined, handleB);
    await new Promise((r) => setImmediate(r));

    controller.abort();
    await pdfService.close();
    await pdfService.init('/projet-a');
    state.clearRetrieval.mockClear();
    failB(new Error('HNSW illisible'));
    await openingB.catch(() => undefined);

    const [storeB, storeA] = state.stores;
    expect(storeB.closed).toBe(true);
    expect(pdfService.getVectorStore()).toBe(storeA);
    expect(pdfService.getCurrentProjectPath()).toBe('/projet-a');
    expect(state.clearRetrieval).not.toHaveBeenCalled();
  });
});

/**
 * Supprimer un document programme une reconstruction de l'index deux secondes plus tard. Le minuteur
 * survivait à la fermeture : il partait ensuite sur `this.vectorStore`, le magasin du projet ouvert
 * entre-temps.
 */
describe('la reconstruction programmée et la fermeture', () => {
  it('fermer l’annule : elle ne part pas sur le magasin du projet suivant', async () => {
    await pdfService.init('/projet-a');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await pdfService.deleteDocument('doc');
      await pdfService.close();
      await pdfService.init('/projet-b');
      await vi.advanceTimersByTimeAsync(2_000);

      const [storeA, storeB] = state.stores;
      const callsOn = (store: FakeStore): number => state.maybeRebuild.mock.calls.filter(([s]) => s === store).length;
      // Une pour chacun : celle que l'ouverture lance d'elle-même, après le préchauffage.
      expect(callsOn(storeA)).toBe(1);
      expect(callsOn(storeB)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * `init` n'était pas transactionnel (S03-1-19) : le nouveau magasin était publié avant l'attente de son
 * index, avec l'ancien indexeur, branché sur le magasin fermé. Garde-fous : le magasin ne s'installe
 * qu'une fois prêt (#273), et un échec remet tout à null (#222, cas « le nouveau magasin ne s'ouvre
 * pas » plus haut).
 */
describe('pendant l’ouverture de B (S03-1-19)', () => {
  it('une indexation dit « not initialized », jamais « database connection is not open »', async () => {
    await pdfService.init('/projet-a');
    let finishB!: () => void;
    state.create.mockImplementationOnce(() => ({
      store: openStore(),
      useEnhanced: true,
      initPromise: new Promise<void>((resolve) => {
        finishB = resolve;
      }),
    }));
    const openingB = pdfService.init('/projet-b');
    await new Promise((r) => setImmediate(r));

    await expect(pdfService.indexPDF('/projet-b/a.pdf')).rejects.toThrow(/not initialized/);
    await expect(pdfService.getAllDocuments()).rejects.toThrow(/not initialized/);

    finishB();
    await openingB;
    await expect(pdfService.indexPDF('/projet-b/a.pdf')).resolves.toEqual({ id: 'doc' });
    expect(state.indexers.at(-1)?.vectorStore).toBe(state.stores[1]);
  });
});

/**
 * La fiche voulait qu'un registre qui ne se construit plus laisse A « utilisable ». La règle de L04-2
 * l'emporte : un registre en échec libère tout, l'indexeur compris (il tiendrait un fournisseur
 * libéré). A reste ouvert et lisible ; seule l'indexation refuse, en disant pourquoi.
 */
describe('A ouvert, puis une configuration qui ne se construit plus', () => {
  it('les lectures restent, l’indexation dit pourquoi elle refuse', async () => {
    await pdfService.init('/projet');
    state.llm = { backend: 'claude', claudeModel: 'claude-sonnet-4-6' };

    await expect(pdfService.refreshProviders({ embeddingChanged: true })).rejects.toThrow(/claudeAPIKey/);

    expect(state.stores[0].closed).toBe(false);
    expect(pdfService.getCurrentProjectPath()).toBe('/projet');
    await expect(pdfService.getAllDocuments()).resolves.toEqual([]);
    await expect(pdfService.indexPDF('/projet/a.pdf')).rejects.toThrow(
      /Fournisseur d'embeddings indisponible : Anthropic backend selected but no claudeAPIKey/
    );
  });
});
