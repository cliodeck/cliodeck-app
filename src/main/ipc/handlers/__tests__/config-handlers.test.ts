/**
 * `config:set` ne laisse passer aucun nombre non fini : le fichier est du JSON, où `NaN` devient
 * `null`. Il ne touche à rien d'autre : `undefined` y veut dire « efface » (`setLLMConfig` reçoit un
 * `Partial`), et un `null` n'est pas à lui d'en juger.
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
  setZoteroConfig: vi.fn(),
  setAPIKey: vi.fn(),
  set: vi.fn(),
  init: vi.fn(async (_path: string) => undefined),
  applyRagConfig: vi.fn(),
}));
vi.mock('../../../services/config-manager.js', () => ({
  configManager: {
    getAPIKey: () => '',
    setLLMConfig: mocks.setLLMConfig,
    setZoteroConfig: mocks.setZoteroConfig,
    setAPIKey: mocks.setAPIKey,
    set: mocks.set,
    getLLMConfig: () => ({ backend: 'ollama' }),
  },
}));
vi.mock('../../../services/pdf-service.js', () => ({
  pdfService: {
    getCurrentProjectPath: () => '/projet',
    init: mocks.init,
    applyRagConfig: mocks.applyRagConfig,
  },
}));

const { setupConfigHandlers, stripNonFinite } = await import('../config-handlers.js');
setupConfigHandlers();
const configSet = (key: string, value: unknown) => handlers.get('config:set')?.({}, key, value);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.init.mockImplementation(async () => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('stripNonFinite', () => {
  it('ne garde que ce qui s’écrit : un objet vidé par le nettoyage part avec son contenu', () => {
    expect(stripNonFinite({ topK: Number.NaN, a: { b: Number.POSITIVE_INFINITY }, c: 1 })).toEqual({ c: 1 });
  });

  it('ne touche ni à null, ni à undefined, ni aux nombres finis, ni à un objet déjà vide', () => {
    const value = { a: null, b: undefined, c: 0, d: -1.5, e: 'x', f: false, g: {}, h: [] };
    const stripped = stripNonFinite(value) as Record<string, unknown>;
    expect(stripped).toEqual(value);
    expect(Object.keys(stripped)).toEqual(Object.keys(value));
  });

  it('passe dans les objets, à toute profondeur, et ne modifie pas ce qu’il reçoit', () => {
    const value = { a: { b: { c: Number.NaN, d: 1 } } };
    expect(stripNonFinite(value)).toEqual({ a: { b: { d: 1 } } });
    expect(value.a.b.c).toBeNaN();
  });

  it('dans un tableau, un nombre non fini s’en va : `null` à sa place décalerait tout autant', () => {
    expect(stripNonFinite({ list: [1, Number.NaN, 3, Number.NEGATIVE_INFINITY] })).toEqual({ list: [1, 3] });
    expect(stripNonFinite({ list: [{ timeout: Number.NaN, name: 'x' }, null, 'y'] })).toEqual({
      list: [{ name: 'x' }, null, 'y'],
    });
  });

  it('laisse les valeurs seules : chaîne, booléen, null, undefined ; un nombre non fini seul ne vaut rien', () => {
    expect(stripNonFinite('fr')).toBe('fr');
    expect(stripNonFinite(true)).toBe(true);
    expect(stripNonFinite(null)).toBeNull();
    expect(stripNonFinite(undefined)).toBeUndefined();
    expect(stripNonFinite(Number.NaN)).toBeUndefined();
  });
});

describe('config:set', () => {
  it('rag : la section remplacée n’emporte aucun NaN', async () => {
    const response = await configSet('rag', { topK: Number.NaN, similarityThreshold: 0.2, chunkingConfig: 'large' });

    expect(mocks.set).toHaveBeenCalledWith('rag', { similarityThreshold: 0.2, chunkingConfig: 'large' });
    expect(JSON.stringify(mocks.set.mock.calls[0][1])).not.toContain('null');
    expect(response).toEqual({ success: true });
    expect(mocks.applyRagConfig).toHaveBeenCalled();
  });

  it('llm : un NaN ne passe pas, et `undefined` reste un effacement', async () => {
    await configSet('llm', { ollamaNumCtx: undefined, ollamaEmbeddingNumCtx: Number.NaN, ollamaChatModel: 'x' });

    const received = mocks.setLLMConfig.mock.calls[0][0] as Record<string, unknown>;
    expect(received).toHaveProperty('ollamaNumCtx', undefined);
    expect(received).not.toHaveProperty('ollamaEmbeddingNumCtx');
    expect(received.ollamaChatModel).toBe('x');
  });

  it('le masque d’une clé est toujours retiré : `stripMaskedKeys` passe sur le même objet', async () => {
    await configSet('llm', { claudeAPIKey: 'sk-a...wXyZ', ollamaNumCtx: Number.POSITIVE_INFINITY, backend: 'claude' });

    expect(mocks.setLLMConfig).toHaveBeenCalledWith({ backend: 'claude' });
  });

  it('écrit puis relance en échec : le contrat `written` ne change pas', async () => {
    mocks.init.mockRejectedValue(new Error('pas de clé'));

    const response = await configSet('llm', { topK: Number.NaN, backend: 'claude' });

    expect(mocks.setLLMConfig).toHaveBeenCalledWith({ backend: 'claude' });
    expect(response).toEqual({ success: false, written: true, error: 'pas de clé' });
  });

  it('un nombre non fini seul : rien n’est écrit, et c’est dit', async () => {
    const response = (await configSet('uneValeur', Number.NaN)) as { success: boolean; error?: string };

    expect(mocks.set).not.toHaveBeenCalled();
    expect(response.success).toBe(false);
    expect(response.error).toContain('uneValeur');
  });

  it('une valeur seule ordinaire passe telle quelle', async () => {
    await configSet('language', 'de');
    expect(mocks.set).toHaveBeenCalledWith('language', 'de');
  });
});
