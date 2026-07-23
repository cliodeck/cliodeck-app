/**
 * Le renderer ne reçoit jamais une clé en clair : il reçoit son masque.
 * Quand il renvoie la section de configuration inchangée, ce masque ne doit
 * pas être écrit à la place de la clé — sans quoi enregistrer les réglages
 * détruirait toutes les clés d'API.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

const keys: Record<string, string> = {};
vi.mock('../../../services/config-manager.js', () => ({
  configManager: {
    getAPIKey: (path: string) => keys[path] ?? '',
    setAPIKey: vi.fn(),
    getLLMConfig: () => ({ backend: 'ollama' }),
  },
}));
vi.mock('../../../services/pdf-service.js', () => ({ pdfService: {} }));

const { stripUnchangedMaskedKeys } = await import('../config-handlers.js');
const { maskAPIKey } = await import('../../../services/secure-storage.js');

beforeEach(() => {
  for (const k of Object.keys(keys)) delete keys[k];
});

describe('stripUnchangedMaskedKeys', () => {
  it('retire le champ quand la valeur est le masque de la clé stockée', () => {
    keys['llm.openaiAPIKey'] = 'sk-la-vraie-cle-longue';
    const incoming = {
      backend: 'openai',
      openaiAPIKey: maskAPIKey(keys['llm.openaiAPIKey']),
    };
    const cleaned = stripUnchangedMaskedKeys('llm', incoming);
    expect('openaiAPIKey' in cleaned).toBe(false);
    expect(cleaned.backend).toBe('openai');
  });

  it('laisse passer une clé réellement modifiée', () => {
    keys['llm.openaiAPIKey'] = 'sk-ancienne-cle-longue';
    const cleaned = stripUnchangedMaskedKeys('llm', {
      openaiAPIKey: 'sk-nouvelle-cle-saisie',
    });
    expect(cleaned.openaiAPIKey).toBe('sk-nouvelle-cle-saisie');
  });

  it('laisse passer une valeur vide (effacement volontaire)', () => {
    keys['llm.openaiAPIKey'] = 'sk-ancienne-cle-longue';
    const cleaned = stripUnchangedMaskedKeys('llm', { openaiAPIKey: '' });
    expect(cleaned.openaiAPIKey).toBe('');
  });

  it('ne touche pas aux champs non sensibles', () => {
    const cleaned = stripUnchangedMaskedKeys('llm', {
      ollamaChatModel: 'qwen3:8b',
      temperature: 0.7,
    });
    expect(cleaned).toEqual({ ollamaChatModel: 'qwen3:8b', temperature: 0.7 });
  });

  it('ne s’applique qu’à la section demandée', () => {
    keys['zotero.apiKey'] = 'zot-cle-longue-ici';
    // Le champ `apiKey` d'une section `llm` n'est pas `zotero.apiKey`.
    const cleaned = stripUnchangedMaskedKeys('llm', {
      apiKey: maskAPIKey(keys['zotero.apiKey']),
    });
    expect(cleaned.apiKey).toBeDefined();
  });
});
