/**
 * Les handlers Zotero reçoivent du renderer le champ `apiKey` du formulaire, donc un masque. Il
 * n'était remplacé que s'il valait le masque de la clé stockée : après une révocation, ou une clé
 * changée entre-temps, le masque partait tel quel vers l'API de Zotero comme jeton (S17-1-29).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));

const keys: Record<string, string> = {};
const testConnection = vi.hoisted(() => vi.fn(async () => ({ success: true })));
vi.mock('../../../services/config-manager.js', () => ({
  configManager: { getAPIKey: (path: string) => keys[path] ?? '' },
}));
vi.mock('../../../services/zotero-service.js', () => ({ zoteroService: { testConnection } }));
vi.mock('../../../services/pdf-service.js', () => ({ pdfService: {} }));
vi.mock('../../../services/project-manager.js', () => ({ projectManager: {} }));

const { setupZoteroHandlers } = await import('../zotero-handlers.js');
const { maskAPIKey } = await import('../../../services/secure-storage.js');
setupZoteroHandlers();

const test = (apiKey: string) =>
  handlers.get('zotero:test-connection')?.({}, { mode: 'api', userId: '12345', apiKey });
const sentKey = () => (testConnection.mock.calls[0] as unknown as [{ apiKey: string }])[0].apiKey;

beforeEach(() => {
  for (const k of Object.keys(keys)) delete keys[k];
  testConnection.mockClear();
});

describe('zotero : une valeur à forme de masque n’est jamais une clé', () => {
  it('le masque de la clé stockée : c’est la vraie clé qui part', async () => {
    keys['zotero.apiKey'] = 'zot-la-vraie-cle-longue';
    await test(maskAPIKey(keys['zotero.apiKey']));
    expect(sentKey()).toBe('zot-la-vraie-cle-longue');
  });

  it('une clé changée entre-temps : le masque périmé ne part pas, la clé actuelle si', async () => {
    keys['zotero.apiKey'] = 'zot-la-cle-tapee-depuis';
    await test(maskAPIKey('zot-la-cle-d-avant-longue'));
    expect(sentKey()).toBe('zot-la-cle-tapee-depuis');
  });

  it.each(['abcd...wxyz', '****'])('aucune clé stockée, %s : le masque ne part pas vers Zotero', async (mask) => {
    await test(mask);
    expect(sentKey()).toBe('');
  });

  it('une vraie clé tapée dans le formulaire part telle quelle', async () => {
    keys['zotero.apiKey'] = 'zot-la-vraie-cle-longue';
    await test('zot-une-autre-cle-tapee');
    expect(sentKey()).toBe('zot-une-autre-cle-tapee');
  });
});
