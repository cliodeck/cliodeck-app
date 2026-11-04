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
  init: vi.fn(async (_path: string) => undefined),
  applyRagConfig: vi.fn(),
  projectPath: null as string | null,
}));
vi.mock('../../../services/config-manager.js', () => ({
  configManager: {
    getAPIKey: () => '',
    setLLMConfig: mocks.setLLMConfig,
    setZoteroConfig: vi.fn(),
    setAPIKey: vi.fn(),
    set: mocks.set,
    getLLMConfig: () => ({ backend: 'ollama' }),
  },
}));
vi.mock('../../../services/pdf-service.js', () => ({
  pdfService: {
    getCurrentProjectPath: () => mocks.projectPath,
    init: mocks.init,
    applyRagConfig: mocks.applyRagConfig,
  },
}));

const { setupConfigHandlers } = await import('../config-handlers.js');
setupConfigHandlers();
const configSet = (key: string, value: unknown) => handlers.get('config:set')?.({}, key, value);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projectPath = '/projet';
  mocks.init.mockImplementation(async () => undefined);
  mocks.setLLMConfig.mockImplementation(() => undefined);
  mocks.set.mockImplementation(() => undefined);
  mocks.applyRagConfig.mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('config:set dit ce qui a échoué', () => {
  it('une relance échouée après l’écriture : `written`, et le motif', async () => {
    mocks.init.mockRejectedValue(new Error('Anthropic backend selected but no claudeAPIKey set in config.'));

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

    expect(mocks.init).not.toHaveBeenCalled();
    expect(response).toEqual({ success: false, error: 'disque plein' });
  });

  it('écriture et relance réussies : une seule relance', async () => {
    await expect(configSet('llm', { backend: 'ollama' })).resolves.toEqual({ success: true });
    expect(mocks.init).toHaveBeenCalledTimes(1);
    expect(mocks.init).toHaveBeenCalledWith('/projet');
  });

  it('sans projet ouvert : rien à relancer', async () => {
    mocks.projectPath = null;
    await expect(configSet('llm', { backend: 'ollama' })).resolves.toEqual({ success: true });
    expect(mocks.init).not.toHaveBeenCalled();
  });
});

describe('config:set(`rag`) atteint l’indexeur sans relancer les services', () => {
  it('écrire la section la répercute, et ne passe pas par `init`', async () => {
    await expect(configSet('rag', { chunkingConfig: 'large' })).resolves.toEqual({ success: true });

    expect(mocks.set).toHaveBeenCalledWith('rag', { chunkingConfig: 'large' });
    expect(mocks.applyRagConfig).toHaveBeenCalledTimes(1);
    expect(mocks.init).not.toHaveBeenCalled();
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
    expect(mocks.init).not.toHaveBeenCalled();
  });
});
