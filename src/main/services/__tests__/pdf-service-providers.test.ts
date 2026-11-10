/**
 * L'indexeur PDF capture son fournisseur d'embeddings à la construction. Télécharger ou supprimer un
 * modèle embarqué refaisait le registre du service PDF, libérait l'ancien fournisseur, et laissait
 * l'indexeur avec : la réindexation demandée par l'interface réembarquait avec l'ancien modèle, ou
 * échouait sur « not initialized » jusqu'à la réouverture du projet (S04-1-12, S05-1-11).
 *
 * À l'inverse, un simple changement de génération (le modèle du chat) ne doit plus rouvrir le projet :
 * `config:set('llm')` appelait `init`, qui attend les indexations en vol et ferme le magasin.
 *
 * Vrai `pdfService`, vrais gestionnaires ; simulés : magasin, indexeur, registre, recherche, Tropy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  app: { commandLine: { hasSwitch: () => false }, getPath: () => '/tmp/userdata-de-test' },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

interface FakeEmbedding {
  tag: number;
  dispose: ReturnType<typeof vi.fn<() => Promise<void>>>;
  embed: () => Promise<number[][]>;
}

const state = vi.hoisted(() => ({
  llm: {} as Record<string, unknown>,
  built: 0,
  embeddings: [] as FakeEmbedding[],
  indexers: [] as Array<{ embeddingProvider: unknown; indexPDF: ReturnType<typeof vi.fn> }>,
  store: { close: vi.fn(), countDuplicateDocuments: () => 0 },
  create: vi.fn(),
}));

vi.mock('../config-manager.js', () => ({
  configManager: {
    getLLMConfig: () => ({ ...state.llm }),
    setLLMConfig: (partial: Record<string, unknown>) => {
      state.llm = { ...state.llm, ...partial };
    },
    get: () => ({ ...state.llm }),
    set: (_key: string, value: Record<string, unknown>) => {
      state.llm = { ...value };
    },
    getRAGConfig: () => ({ chunkingConfig: 'cpuOptimized', topK: 10 }),
    getAPIKey: () => '',
  },
}));
vi.mock('../../../../backend/core/llm/providers/cliodeck-config-adapter.js', () => ({
  createRegistryFromClioDeckConfig: () => {
    state.built++;
    let embedding: FakeEmbedding | null = null;
    return {
      getLLM: () => ({}),
      getEmbedding: () => {
        if (!embedding) {
          embedding = {
            tag: state.embeddings.length,
            dispose: vi.fn(async () => undefined),
            embed: async () => [[0.1]],
          };
          state.embeddings.push(embedding);
        }
        return embedding;
      },
      dispose: async () => {
        await embedding?.dispose();
      },
    };
  },
}));
vi.mock('../pdf/PdfVectorStore.js', () => ({
  PdfVectorStore: {
    create: state.create,
    configureEnhanced: vi.fn(),
    maybeRebuild: async () => undefined,
  },
}));
vi.mock('../pdf/PdfIndexer.js', () => ({
  PdfIndexer: class {
    embeddingProvider: unknown;
    indexPDF = vi.fn(async () => ({ id: 'doc' }));
    constructor(deps: { embeddingProvider: unknown }) {
      this.embeddingProvider = deps.embeddingProvider;
      state.indexers.push(this);
    }
  },
}));
vi.mock('../pdf-extract-isolated.js', () => ({ extractPdfIsolated: vi.fn() }));
vi.mock('../retrieval-service.js', () => ({
  retrievalService: { configure: vi.fn(), rebuildEmbeddingProvider: vi.fn(), drainSearches: vi.fn(async () => undefined) },
}));
vi.mock('../tropy-service.js', () => ({
  tropyService: { rebuildProviders: vi.fn(async () => undefined) },
}));
vi.mock('../../../../backend/core/llm/ModelDownloader.js', () => ({
  ModelDownloader: class {
    isDownloadInProgress = () => false;
    downloadModel = async () => '/modeles/nomic-v2.gguf';
    deleteCorruptedModel = () => undefined;
    deleteModel = () => true;
  },
}));
vi.mock('../../../../backend/core/llm/EmbeddedLLMClient.js', () => ({
  EMBEDDED_MODELS: {},
  DEFAULT_EMBEDDED_MODEL: 'qwen',
  EMBEDDED_EMBEDDING_MODELS: {},
  DEFAULT_EMBEDDED_EMBEDDING_MODEL: 'nomic-embed-text-v2',
}));

const { pdfService } = await import('../pdf-service.js');
const { setupEmbeddedLLMHandlers } = await import('../../ipc/handlers/embedded-llm-handlers.js');
const { setupConfigHandlers } = await import('../../ipc/handlers/config-handlers.js');
setupEmbeddedLLMHandlers();
setupConfigHandlers();
const event = { sender: { send: () => undefined } };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  await pdfService.close();
  state.llm = { backend: 'ollama', ollamaChatModel: 'llama3.2', ollamaEmbeddingModel: 'nomic-embed-text' };
  state.built = 0;
  state.embeddings.length = 0;
  state.indexers.length = 0;
  state.store.close.mockClear();
  state.create.mockClear();
  state.create.mockImplementation(() => ({ store: state.store, useEnhanced: true, initPromise: undefined }));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await pdfService.init('/projet');
});

describe('changer de modèle d’embeddings, projet ouvert', () => {
  it('un nouvel indexeur, avec le fournisseur courant, après l’indexation en vol', async () => {
    let finish = (_value: { id: string }): void => undefined;
    state.indexers[0].indexPDF.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const job = pdfService.indexPDF('/projet/a.pdf');

    const download = handlers.get('embedded-embedding:download')?.(event, 'nomic-embed-text-v2');
    await tick();
    // L'indexation en vol finit avec l'indexeur qu'elle a : rien n'est refait sous elle.
    expect(state.indexers).toHaveLength(1);

    finish({ id: 'a' });
    await job;
    await expect(download).resolves.toMatchObject({ success: true });

    expect(state.indexers).toHaveLength(2);
    const current = pdfService.getEmbeddingProvider();
    expect(state.indexers[1].embeddingProvider).toBe(current);
    expect(current).not.toBe(state.indexers[0].embeddingProvider);
  });

  it('une indexation lancée pendant l’attente passe par le nouvel indexeur', async () => {
    // L'attente ne porte que sur les indexations déjà en vol. Une indexation lancée pendant cette
    // attente prenait l'ancien indexeur, dont le fournisseur est libéré juste après : un embarqué
    // libéré se recharge alors hors de tout registre, et écrit les vecteurs de l'ancien modèle.
    let finish = (_value: { id: string }): void => undefined;
    state.indexers[0].indexPDF.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const first = pdfService.indexPDF('/projet/a.pdf');
    const download = handlers.get('embedded-embedding:download')?.(event, 'nomic-embed-text-v2');
    await tick();

    const second = pdfService.indexPDF('/projet/b.pdf');
    await tick();
    expect(state.indexers[0].indexPDF).toHaveBeenCalledTimes(1);

    finish({ id: 'a' });
    await first;
    await expect(download).resolves.toMatchObject({ success: true });
    await expect(second).resolves.toEqual({ id: 'doc' });

    expect(state.indexers).toHaveLength(2);
    expect(state.indexers[1].indexPDF).toHaveBeenCalledWith('/projet/b.pdf', undefined, undefined, undefined, undefined);
  });

  it('supprimer le modèle embarqué : l’indexeur ne garde pas le fournisseur libéré', async () => {
    state.llm = { ...state.llm, embeddedEmbeddingModelId: 'nomic-embed-text-v2' };
    const first = state.indexers[0].embeddingProvider as FakeEmbedding;

    await handlers.get('embedded-embedding:delete-model')?.(event, 'nomic-embed-text-v2');

    expect(first.dispose).toHaveBeenCalled();
    expect(state.indexers.at(-1)?.embeddingProvider).toBe(pdfService.getEmbeddingProvider());
    expect(state.indexers.at(-1)?.embeddingProvider).not.toBe(first);
  });
});

describe('changer seulement la génération (A3)', () => {
  it('ni magasin fermé, ni indexeur refait, ni fournisseur d’embeddings libéré', async () => {
    const embedding = state.indexers[0].embeddingProvider as FakeEmbedding;

    const response = await handlers.get('config:set')?.({}, 'llm', { ...state.llm, ollamaChatModel: 'qwen3:8b' });

    expect(response).toEqual({ success: true });
    expect(state.store.close).not.toHaveBeenCalled();
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.indexers).toHaveLength(1);
    expect(embedding.dispose).not.toHaveBeenCalled();
    expect(pdfService.getEmbeddingProvider()).toBe(embedding);
  });

  it('un réglage lu à chaque tour (num_ctx) ne refait rien du tout', async () => {
    const builtBefore = state.built;

    await handlers.get('config:set')?.({}, 'llm', { ...state.llm, ollamaNumCtx: 32768 });

    expect(state.built).toBe(builtBefore);
    expect(state.store.close).not.toHaveBeenCalled();
    expect(state.indexers).toHaveLength(1);
  });

  it('les embeddings changent par config:set : magasin gardé, indexeur refait', async () => {
    await handlers.get('config:set')?.({}, 'llm', { ...state.llm, ollamaEmbeddingModel: 'bge-m3' });

    expect(state.store.close).not.toHaveBeenCalled();
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.indexers).toHaveLength(2);
    expect(state.indexers[1].embeddingProvider).toBe(pdfService.getEmbeddingProvider());
  });
});
