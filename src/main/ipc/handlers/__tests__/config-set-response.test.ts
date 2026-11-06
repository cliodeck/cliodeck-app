/**
 * `{ success: false }` ne veut pas dire « non écrit » : `config:set('llm')` écrit d'abord, puis
 * relance les services. Le panneau doit savoir lequel des deux a échoué, sinon il garde pour non écrit
 * ce que le disque contient déjà, et un retour à la valeur précédente passe pour « rien à faire » :
 * le disque garde la valeur refusée, et le projet ne s'ouvre plus au lancement suivant.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  app: { commandLine: { hasSwitch: () => false } },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));

const mocks = vi.hoisted(() => ({
  setLLMConfig: vi.fn(),
  set: vi.fn(),
  refresh: vi.fn(async (_opts: { embeddingChanged: boolean }) => undefined),
  applyRagConfig: vi.fn(),
  projectPath: null as string | null,
  missing: false,
  llm: { backend: 'ollama' } as Record<string, unknown>,
}));
vi.mock('../../../services/config-manager.js', () => ({
  configManager: {
    getAPIKey: () => '',
    setLLMConfig: (partial: Record<string, unknown>) => {
      mocks.setLLMConfig(partial);
      mocks.llm = { ...mocks.llm, ...partial };
    },
    setZoteroConfig: vi.fn(),
    setAPIKey: vi.fn(),
    set: mocks.set,
    getLLMConfig: () => ({ ...mocks.llm }),
  },
}));
vi.mock('../../../services/pdf-service.js', () => ({
  pdfService: {
    getCurrentProjectPath: () => mocks.projectPath,
    providersMissing: () => mocks.missing,
    applyRagConfig: mocks.applyRagConfig,
  },
}));
vi.mock('../../../services/provider-refresh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/provider-refresh.js')>()),
  refreshProviders: mocks.refresh,
}));

const { setupConfigHandlers } = await import('../config-handlers.js');
setupConfigHandlers();
const configSet = (key: string, value: unknown) => handlers.get('config:set')?.({}, key, value);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projectPath = '/projet';
  mocks.llm = { backend: 'ollama' };
  mocks.missing = false;
  mocks.refresh.mockImplementation(async () => undefined);
  mocks.setLLMConfig.mockImplementation(() => undefined);
  mocks.set.mockImplementation(() => undefined);
  mocks.applyRagConfig.mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('config:set dit ce qui a échoué', () => {
  it('une relance échouée après l’écriture : `written`, et le motif', async () => {
    mocks.refresh.mockRejectedValue(new Error('Anthropic backend selected but no claudeAPIKey set in config.'));

    const response = await configSet('llm', { backend: 'claude' });

    expect(mocks.setLLMConfig).toHaveBeenCalledWith({ backend: 'claude' });
    expect(response).toEqual({
      success: false,
      written: true,
      error: 'Anthropic backend selected but no claudeAPIKey set in config.',
    });
  });

  it('une écriture refusée : pas de `written`, et pas de relance', async () => {
    mocks.setLLMConfig.mockImplementation(() => {
      throw new Error('disque plein');
    });

    const response = await configSet('llm', { backend: 'claude' });

    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(response).toEqual({ success: false, error: 'disque plein' });
  });

  it('écriture et relance réussies : une seule relance, sans rouvrir le projet', async () => {
    await expect(configSet('llm', { backend: 'claude', claudeAPIKey: 'sk-test' })).resolves.toEqual({ success: true });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenCalledWith({ embeddingChanged: true });
  });

  it('rien qui touche un fournisseur : aucune relance', async () => {
    await expect(configSet('llm', { backend: 'ollama', ollamaNumCtx: 8192 })).resolves.toEqual({ success: true });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('rien à écrire, mais les fournisseurs manquent : on retente, embeddings compris', async () => {
    mocks.missing = true;
    mocks.refresh.mockRejectedValue(new Error('Anthropic backend selected but no claudeAPIKey set in config.'));

    const response = await configSet('llm', { backend: 'ollama' });

    expect(mocks.refresh).toHaveBeenCalledWith({ embeddingChanged: true });
    expect(response).toMatchObject({ success: false, written: true });
  });

  it('sans projet ouvert : rien à relancer', async () => {
    mocks.projectPath = null;
    await expect(configSet('llm', { backend: 'ollama' })).resolves.toEqual({ success: true });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});

describe('config:set(`rag`) atteint l’indexeur sans relancer les services', () => {
  it('écrire la section la répercute, et ne passe pas par `init`', async () => {
    await expect(configSet('rag', { chunkingConfig: 'large' })).resolves.toEqual({ success: true });

    expect(mocks.set).toHaveBeenCalledWith('rag', { chunkingConfig: 'large' });
    expect(mocks.applyRagConfig).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('une écriture refusée ne se répercute pas', async () => {
    mocks.set.mockImplementation(() => {
      throw new Error('disque plein');
    });

    await expect(configSet('rag', { topK: 7 })).resolves.toEqual({ success: false, error: 'disque plein' });
    expect(mocks.applyRagConfig).not.toHaveBeenCalled();
  });

  it('une répercussion ratée après l’écriture : `written`', async () => {
    mocks.applyRagConfig.mockImplementation(() => {
      throw new Error('indexeur');
    });

    await expect(configSet('rag', { topK: 7 })).resolves.toEqual({
      success: false,
      written: true,
      error: 'indexeur',
    });
  });

  it('les autres sections n’y touchent pas', async () => {
    await configSet('editor', { fontSize: 18 });
    expect(mocks.applyRagConfig).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
