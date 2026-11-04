/**
 * Le renderer ne reçoit jamais une clé en clair : il reçoit son masque.
 * Quand il renvoie la section de configuration inchangée, ce masque ne doit
 * pas être écrit à la place de la clé — sans quoi enregistrer les réglages
 * détruirait toutes les clés d'API.
 *
 * Une valeur à forme de masque n'est jamais une clé, qu'une clé soit stockée
 * ou non : après « Révoquer toutes les clés », ou quand la clé a changé
 * entre-temps, le masque resté dans le formulaire passait pour une nouvelle
 * clé, et partait ensuite comme jeton vers le fournisseur (S17-1-29).
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

const keys: Record<string, string> = {};
const manager = vi.hoisted(() => ({
  setAPIKey: vi.fn(),
  setLLMConfig: vi.fn(),
  setZoteroConfig: vi.fn(),
  set: vi.fn(),
}));
vi.mock('../../../services/config-manager.js', () => ({
  configManager: {
    getAPIKey: (path: string) => keys[path] ?? '',
    setAPIKey: manager.setAPIKey,
    setLLMConfig: manager.setLLMConfig,
    setZoteroConfig: manager.setZoteroConfig,
    set: manager.set,
    getLLMConfig: () => ({ backend: 'ollama' }),
  },
}));
vi.mock('../../../services/pdf-service.js', () => ({
  pdfService: { getCurrentProjectPath: () => null, applyRagConfig: () => undefined },
}));

const { stripMaskedKeys, setupConfigHandlers } = await import('../config-handlers.js');
const { maskAPIKey, SENSITIVE_KEYS } = await import('../../../services/secure-storage.js');

setupConfigHandlers();
const configSet = (key: string, value: unknown) => handlers.get('config:set')?.({}, key, value);

/** Les deux formes que peut prendre un masque. */
const MASKS = ['sk-a...wXyZ', '****'];

beforeEach(() => {
  for (const k of Object.keys(keys)) delete keys[k];
  vi.clearAllMocks();
});

describe('stripMaskedKeys', () => {
  it('retire le champ quand la valeur est le masque de la clé stockée', () => {
    keys['llm.openaiAPIKey'] = 'sk-la-vraie-cle-longue';
    const incoming = {
      backend: 'openai',
      openaiAPIKey: maskAPIKey(keys['llm.openaiAPIKey']),
    };
    const cleaned = stripMaskedKeys('llm', incoming);
    expect('openaiAPIKey' in cleaned).toBe(false);
    expect(cleaned.backend).toBe('openai');
  });

  it('laisse passer une clé réellement modifiée', () => {
    keys['llm.openaiAPIKey'] = 'sk-ancienne-cle-longue';
    const cleaned = stripMaskedKeys('llm', {
      openaiAPIKey: 'sk-nouvelle-cle-saisie',
    });
    expect(cleaned.openaiAPIKey).toBe('sk-nouvelle-cle-saisie');
  });

  it('laisse passer une valeur vide (effacement volontaire)', () => {
    keys['llm.openaiAPIKey'] = 'sk-ancienne-cle-longue';
    const cleaned = stripMaskedKeys('llm', { openaiAPIKey: '' });
    expect(cleaned.openaiAPIKey).toBe('');
  });

  it('ne touche pas aux champs non sensibles', () => {
    const cleaned = stripMaskedKeys('llm', {
      ollamaChatModel: 'qwen3:8b',
      temperature: 0.7,
    });
    expect(cleaned).toEqual({ ollamaChatModel: 'qwen3:8b', temperature: 0.7 });
  });

  it('ne s’applique qu’à la section demandée', () => {
    keys['zotero.apiKey'] = 'zot-cle-longue-ici';
    // Le champ `apiKey` d'une section `llm` n'est pas `zotero.apiKey`.
    const cleaned = stripMaskedKeys('llm', {
      apiKey: maskAPIKey(keys['zotero.apiKey']),
    });
    expect(cleaned.apiKey).toBeDefined();
  });

  it.each(MASKS)('aucune clé stockée, valeur %s : champ retiré, pour llm et zotero', (mask) => {
    expect(stripMaskedKeys('llm', { backend: 'openai', openaiAPIKey: mask })).toEqual({ backend: 'openai' });
    expect(stripMaskedKeys('zotero', { userId: '1', apiKey: mask })).toEqual({ userId: '1' });
  });

  it('une valeur qui n’est pas le masque de la clé actuelle est retirée aussi : la clé a changé entre-temps', () => {
    keys['llm.openaiAPIKey'] = 'sk-la-cle-tapee-depuis';
    const cleaned = stripMaskedKeys('llm', { openaiAPIKey: maskAPIKey('sk-la-cle-d-avant-longue') });
    expect('openaiAPIKey' in cleaned).toBe(false);
  });

  it('un champ imbriqué : le masque de mcp.europeana.apiKey n’est pas écrit, sans modifier l’objet reçu', () => {
    const value = { europeana: { apiKey: 'abcd...wxyz', other: 1 }, keep: true };
    const cleaned = stripMaskedKeys('mcp', value);
    expect(cleaned).toEqual({ europeana: { other: 1 }, keep: true });
    expect(value.europeana.apiKey).toBe('abcd...wxyz');
  });

  it('un champ imbriqué : une vraie clé passe, et un chemin absent ne gêne pas', () => {
    expect(stripMaskedKeys('mcp', { europeana: { apiKey: 'la-vraie-cle-europeana' } })).toEqual({
      europeana: { apiKey: 'la-vraie-cle-europeana' },
    });
    expect(stripMaskedKeys('mcp', { autre: 1 })).toEqual({ autre: 1 });
    expect(stripMaskedKeys('mcp', { europeana: null })).toEqual({ europeana: null });
  });
});

describe('config:set, toutes les portes', () => {
  it.each(SENSITIVE_KEYS.flatMap((key) => MASKS.map((mask) => [key, mask] as const)))(
    'la voie directe %s ne prend pas %s pour une clé, sans clé stockée',
    async (key, mask) => {
      const res = await configSet(key, mask);
      expect(manager.setAPIKey).not.toHaveBeenCalled();
      expect(res).toMatchObject({ success: true });
    }
  );

  it('la voie directe : un masque périmé ne remplace pas la clé stockée', async () => {
    keys['llm.openaiAPIKey'] = 'sk-la-cle-tapee-depuis';
    await configSet('llm.openaiAPIKey', maskAPIKey('sk-la-cle-d-avant-longue'));
    expect(manager.setAPIKey).not.toHaveBeenCalled();
  });

  it('une clé illisible : getAPIKey rend vide, et le masque ne l’écrase pas', async () => {
    // `secureStorage.getKey` rend '' pour un chiffré d'une autre clé de trousseau.
    keys['llm.claudeAPIKey'] = '';
    await configSet('llm.claudeAPIKey', 'sk-a...wXyZ');
    await configSet('llm', { backend: 'claude', claudeAPIKey: 'sk-a...wXyZ' });
    expect(manager.setAPIKey).not.toHaveBeenCalled();
    expect(manager.setLLMConfig).toHaveBeenCalledWith({ backend: 'claude' });
  });

  it('la voie directe : une vraie clé s’écrit, et une valeur vide efface (Réglages → Sécurité)', async () => {
    await configSet('llm.openaiAPIKey', 'sk-une-vraie-cle-saisie');
    expect(manager.setAPIKey).toHaveBeenCalledWith('llm.openaiAPIKey', 'sk-une-vraie-cle-saisie');
    await configSet('llm.openaiAPIKey', '');
    expect(manager.setAPIKey).toHaveBeenCalledWith('llm.openaiAPIKey', '');
  });

  it('les sections : llm et zotero ne reçoivent pas le masque, sans clé stockée', async () => {
    await configSet('llm', { backend: 'openai', openaiAPIKey: 'sk-a...wXyZ' });
    await configSet('zotero', { userId: '1', apiKey: '****' });
    expect(manager.setLLMConfig).toHaveBeenCalledWith({ backend: 'openai' });
    expect(manager.setZoteroConfig).toHaveBeenCalledWith({ userId: '1' });
  });

  it('la section mcp, par la voie générale : pas de masque dans le fichier de configuration', async () => {
    await configSet('mcp', { europeana: { apiKey: 'abcd...wxyz' } });
    await configSet('mcp.europeana', { apiKey: 'abcd...wxyz' });
    expect(manager.set).toHaveBeenCalledWith('mcp', { europeana: {} });
    expect(manager.set).toHaveBeenCalledWith('mcp.europeana', {});
  });

  it('une valeur simple et une section sans clé passent telles quelles', async () => {
    await configSet('language', 'en');
    await configSet('rag', { topK: 7 });
    expect(manager.set).toHaveBeenCalledWith('language', 'en');
    expect(manager.set).toHaveBeenCalledWith('rag', { topK: 7 });
  });
});
