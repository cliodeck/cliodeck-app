/**
 * Choisir « embarqué » pour les embeddings ne reconstruisait que le fournisseur de la recherche :
 * l'indexeur PDF et Tropy gardaient l'ancien. L'alerte demande ensuite de tout réindexer, et la
 * réindexation écrivait dans un autre espace vectoriel que celui des requêtes, sans erreur (S04-1-12).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
  app: { getPath: () => '/tmp/userdata-de-test' },
  BrowserWindow: { getAllWindows: () => [] },
}));

const store = vi.hoisted(() => ({ llm: {} as Record<string, unknown> }));
vi.mock('../../../services/config-manager.js', () => ({
  configManager: {
    get: () => store.llm,
    set: (_key: string, value: Record<string, unknown>) => {
      store.llm = value;
    },
    getLLMConfig: () => store.llm,
  },
}));

const services = vi.hoisted(() => ({
  pdf: vi.fn(async (_opts?: { embeddingChanged: boolean }) => undefined),
  retrieval: vi.fn(),
  tropy: vi.fn(async (_opts?: { embeddingChanged: boolean }) => undefined),
}));
vi.mock('../../../services/pdf-service.js', () => ({
  pdfService: {
    refreshProviders: services.pdf,
    updateEmbeddedModel: async () => true,
    updateEmbeddedEmbeddingModel: async () => true,
    disableEmbeddedModel: async () => undefined,
    disableEmbeddedEmbeddingModel: async () => undefined,
  },
}));
vi.mock('../../../services/retrieval-service.js', () => ({
  retrievalService: { rebuildEmbeddingProvider: services.retrieval },
}));
vi.mock('../../../services/tropy-service.js', () => ({
  tropyService: { rebuildProviders: services.tropy },
}));
vi.mock('../../../../../backend/core/llm/ModelDownloader.js', () => ({ ModelDownloader: class {} }));
vi.mock('../../../../../backend/core/llm/EmbeddedLLMClient.js', () => ({
  EMBEDDED_MODELS: {},
  DEFAULT_EMBEDDED_MODEL: 'qwen',
  EMBEDDED_EMBEDDING_MODELS: {},
  DEFAULT_EMBEDDED_EMBEDDING_MODEL: 'nomic',
}));

const { setupEmbeddedLLMHandlers } = await import('../embedded-llm-handlers.js');
setupEmbeddedLLMHandlers();

beforeEach(() => {
  vi.clearAllMocks();
  store.llm = { embeddingProvider: 'ollama' };
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('embedded-embedding:set-provider', () => {
  it('reconstruit le PDF, la recherche et Tropy, après l’écriture', async () => {
    const order: string[] = [];
    services.pdf.mockImplementation(async () => {
      order.push(`pdf:${String(store.llm.embeddingProvider)}`);
    });
    services.tropy.mockImplementation(async () => {
      order.push(`tropy:${String(store.llm.embeddingProvider)}`);
    });

    const res = await handlers.get('embedded-embedding:set-provider')?.({}, 'embedded');

    expect(res).toMatchObject({ success: true, provider: 'embedded', reindexRequired: true });
    // Chacun lit la configuration déjà écrite ; leur ordre entre eux n'est pas un contrat.
    expect([...order].sort()).toEqual(['pdf:embedded', 'tropy:embedded']);
    expect(services.pdf).toHaveBeenCalledWith({ embeddingChanged: true });
    expect(services.retrieval).toHaveBeenCalledTimes(1);
    expect(services.tropy).toHaveBeenCalledWith({ embeddingChanged: true });
  });
});
