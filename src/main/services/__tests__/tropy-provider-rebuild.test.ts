/**
 * Le service Tropy ne construisait son registre de fournisseurs qu'à l'ouverture du projet. Décocher
 * les embeddings cloud et enregistrer ne changeait rien pour les archives : les transcriptions
 * entières (synchro, réindexation après un OCR) et les requêtes partaient encore vers
 * api.openai.com, avec l'ancienne clé, jusqu'à la réouverture du projet (S08-1-21).
 *
 * Vrai `tropyService`, vrai gestionnaire `config:set`, vrais adaptateur et fournisseurs ; un faux
 * `fetch` note chaque URL et répond comme le service. Simulés : le magasin SQLite des sources
 * primaires, la synchro, le watcher, l'OCR, la configuration, et les services PDF et recherche.
 * Aucun appel réseau réel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const config = vi.hoisted(() => ({ llm: {} as Record<string, unknown> }));
vi.mock('../config-manager.js', () => ({
  configManager: {
    getLLMConfig: () => ({ ...config.llm }),
    setLLMConfig: (partial: Record<string, unknown>) => {
      config.llm = { ...config.llm, ...partial };
    },
    getRAGConfig: () => ({ similarityThreshold: 0 }),
    getAPIKey: () => '',
    get: () => undefined,
    set: () => undefined,
  },
}));

const saved = vi.hoisted(() => [] as Array<{ sourceId: string; dimension: number }>);
vi.mock('../../../../backend/core/vector-store/PrimarySourcesVectorStore.js', () => ({
  PrimarySourcesVectorStore: class {
    getTropyProject = () => null;
    // Des archives déjà indexées : sans extrait, la recherche n'embarque pas la question (E2).
    getEmbeddingDimension = () => 768;
    getIndexStats = () => ({ hnswSize: 0, bm25Size: 0, hnswDimension: 0 });
    search = () => [];
    getSource = (id: string) => ({
      id,
      title: 'Lettre du préfet',
      transcription:
        'Le préfet signale au ministre que les ouvriers du port réclament une hausse des salaires. ' +
        'Monsieur Durand, demeurant rue des Remparts, est désigné comme meneur de la grève de mars.',
    });
    deleteChunks = () => undefined;
    // Les extraits d'une source s'écrivent d'un bloc, une fois tous embarqués (L06-7).
    replaceSourceChunks = (sourceId: string, items: Array<{ embedding: Float32Array }>) => {
      for (const { embedding } of items) saved.push({ sourceId, dimension: embedding.length });
    };
    // Une source réindexée écrit l'index sur disque (L06-6).
    saveHNSWIndex = () => undefined;
    close = () => undefined;
  },
}));
vi.mock('../../../../backend/integrations/tropy/TropySync.js', () => ({
  TropySync: class {
    dispose = async () => undefined;
  },
}));
vi.mock('../../../../backend/integrations/tropy/TropyWatcher.js', () => ({
  TropyWatcher: class {
    removeAllListeners = () => undefined;
    unwatch = () => undefined;
  },
}));
vi.mock('../../../../backend/integrations/tropy/TropyOCRPipeline.js', () => ({
  TropyOCRPipeline: class {
    dispose = async () => undefined;
  },
  SUPPORTED_OCR_LANGUAGES: [],
}));
vi.mock('../pdf-service.js', () => ({
  pdfService: {
    getCurrentProjectPath: () => '/projet',
    providersMissing: () => false,
    init: vi.fn(async () => undefined),
    refreshProviders: vi.fn(async () => undefined),
    applyRagConfig: vi.fn(),
  },
}));
vi.mock('../retrieval-service.js', () => ({
  retrievalService: { rebuildEmbeddingProvider: vi.fn() },
}));

const calls: string[] = [];
function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  calls.push(url);
  if (url.endsWith('/v1/embeddings')) {
    return Promise.resolve(
      new Response(JSON.stringify({ data: [{ index: 0, embedding: Array(1536).fill(0.01) }] }), { status: 200 })
    );
  }
  if (url.endsWith('/api/embed')) {
    return Promise.resolve(new Response(JSON.stringify({ embeddings: [Array(768).fill(0.01)] }), { status: 200 }));
  }
  return Promise.resolve(new Response('{}', { status: 404 }));
}

const { tropyService } = await import('../tropy-service.js');
const { pdfService } = await import('../pdf-service.js');
const { retrievalService } = await import('../retrieval-service.js');
const { setupConfigHandlers } = await import('../../ipc/handlers/config-handlers.js');
setupConfigHandlers();
const configSet = (key: string, value: unknown) => handlers.get('config:set')?.({}, key, value);

const toOpenAI = (): number => calls.filter((u) => u.startsWith('https://api.openai.com')).length;

beforeEach(async () => {
  calls.length = 0;
  saved.length = 0;
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  config.llm = {
    backend: 'openai',
    openaiAPIKey: 'sk-test-pas-une-vraie-cle',
    useCloudEmbeddings: true,
    ollamaURL: 'http://127.0.0.1:11434',
    ollamaEmbeddingModel: 'nomic-embed-text',
    ollamaChatModel: 'llama3.2',
  };
  await tropyService.init('/projet');
});

afterEach(async () => {
  await tropyService.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('retirer le consentement aux embeddings cloud', () => {
  it('témoin : avant, les requêtes partent bien vers OpenAI', async () => {
    await tropyService.search('grève du port');
    expect(toOpenAI()).toBe(1);
  });

  it('après l’enregistrement, ni la recherche ni la réindexation ne partent vers api.openai.com', async () => {
    const response = await configSet('llm', { ...config.llm, useCloudEmbeddings: false });
    expect(response).toEqual({ success: true });
    calls.length = 0;

    await tropyService.search('grève du port');
    const reindexed = await tropyService.reindexSource('s1');

    expect(reindexed).toEqual({ success: true });
    expect(toOpenAI()).toBe(0);
    expect(calls.some((u) => u === 'http://127.0.0.1:11434/api/embed')).toBe(true);
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.every((s) => s.dimension === 768)).toBe(true);
  });

  it('une indexation PDF en vol ne retarde pas Tropy ni la recherche', async () => {
    // Le service PDF attend ses indexations en vol (jusqu'à 30 s) avant de refaire son indexeur.
    // Tropy et la recherche n'ont rien à attendre : dès l'enregistrement, plus rien ne doit partir
    // vers l'ancien hôte, même pendant cette vidange.
    let releasePdf: () => void = () => undefined;
    vi.mocked(pdfService.refreshProviders).mockImplementationOnce(
      () => new Promise<void>((resolve) => (releasePdf = resolve))
    );
    vi.mocked(retrievalService.rebuildEmbeddingProvider).mockClear();
    const tropyRebuilt = vi.spyOn(tropyService, 'rebuildProviders');
    const saving = configSet('llm', { ...config.llm, useCloudEmbeddings: false });
    // Attend le résultat, pas un délai : la reconstruction de Tropy doit partir sans le service PDF.
    await vi.waitFor(() => expect(tropyRebuilt).toHaveBeenCalled());
    await tropyRebuilt.mock.results[0].value;
    expect(retrievalService.rebuildEmbeddingProvider).toHaveBeenCalledOnce();
    calls.length = 0;

    await tropyService.search('grève du port');
    expect(toOpenAI()).toBe(0);
    expect(calls).toContain('http://127.0.0.1:11434/api/embed');

    releasePdf();
    expect(await saving).toEqual({ success: true });
  });

  it('configuration invalide : plus rien ne part, surtout pas vers l’ancien hôte', async () => {
    // Claude sans clé : le registre ne se construit pas. L'ancien fournisseur ne doit pas servir de
    // repli — il porte justement le consentement qu'on vient de retirer. Le service PDF échoue le
    // premier, comme dans l'app : Tropy doit être refait quand même.
    const refused = new Error('Anthropic backend selected but no claudeAPIKey set in config.');
    vi.mocked(pdfService.init).mockRejectedValueOnce(refused);
    vi.mocked(pdfService.refreshProviders).mockRejectedValueOnce(refused);
    const response = await configSet('llm', { ...config.llm, backend: 'claude', useCloudEmbeddings: false });
    expect(response).toMatchObject({ success: false, written: true });
    calls.length = 0;

    // Des archives indexées et plus de fournisseur : la recherche le dit au lieu de rendre [] (E2).
    await expect(tropyService.search('grève du port')).rejects.toThrow('embedding provider not configured');
    await tropyService.reindexSource('s1');

    expect(calls).toEqual([]);
    expect(saved).toEqual([]);
  });
});
