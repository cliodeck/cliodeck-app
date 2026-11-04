/**
 * Un modèle téléchargé mais impossible à charger est oublié de la configuration. Le gestionnaire
 * réécrivait pour cela la section `llm` lue AVANT le chargement, qui peut durer : ce qu'un
 * Enregistrer avait posé entre-temps était annulé. Même défaut que S17-1-1, en miroir, côté main.
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
  },
}));

/** Le chargement échoue, et un Enregistrer a eu le temps de passer. */
const failAfterASave = vi.hoisted(() => async () => {
  store.llm = { ...store.llm, ollamaChatModel: 'choisi-pendant-le-chargement' };
  return false;
});
vi.mock('../../../services/pdf-service.js', () => ({
  pdfService: { updateEmbeddedModel: failAfterASave, updateEmbeddedEmbeddingModel: failAfterASave },
}));
vi.mock('../../../services/retrieval-service.js', () => ({ retrievalService: {} }));
vi.mock('../../../../../backend/core/llm/ModelDownloader.js', () => ({
  ModelDownloader: class {
    isDownloadInProgress = () => false;
    downloadModel = async () => '/modeles/corrompu.gguf';
    deleteCorruptedModel = () => undefined;
  },
}));
vi.mock('../../../../../backend/core/llm/EmbeddedLLMClient.js', () => ({
  EMBEDDED_MODELS: {},
  DEFAULT_EMBEDDED_MODEL: 'qwen',
  EMBEDDED_EMBEDDING_MODELS: {},
  DEFAULT_EMBEDDED_EMBEDDING_MODEL: 'nomic',
}));

const { setupEmbeddedLLMHandlers } = await import('../embedded-llm-handlers.js');
setupEmbeddedLLMHandlers();
const event = { sender: { send: () => undefined } };

beforeEach(() => {
  store.llm = { ollamaChatModel: 'modele-d-avant', embeddingProvider: 'auto' };
});

describe('un modèle qui ne se charge pas', () => {
  it('génération : l’enregistrement passé pendant le chargement n’est pas annulé', async () => {
    const res = await handlers.get('embedded-llm:download')?.(event, 'qwen');
    expect(res).toMatchObject({ success: false });
    expect(store.llm.ollamaChatModel).toBe('choisi-pendant-le-chargement');
    expect(store.llm.embeddedModelPath).toBeUndefined();
    expect(store.llm.embeddedModelId).toBeUndefined();
  });

  it('embeddings : même chose', async () => {
    const res = await handlers.get('embedded-embedding:download')?.(event, 'nomic');
    expect(res).toMatchObject({ success: false });
    expect(store.llm.ollamaChatModel).toBe('choisi-pendant-le-chargement');
    expect(store.llm.embeddedEmbeddingModelPath).toBeUndefined();
    expect(store.llm.embeddedEmbeddingModelId).toBeUndefined();
  });
});
