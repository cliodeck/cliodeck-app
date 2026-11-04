/**
 * `config.json` illisible, vu des handlers `fusion:*`. Ils le remplaçaient par une configuration
 * vide : le coffre lié et les serveurs MCP disparaissaient au premier clic dans les Réglages, et
 * même à la simple lecture de l'état du serveur MCP (S11-1-8).
 *
 * Les vrais handlers sur un vrai dossier ; seuls les services voisins sont simulés.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  projectPath: '' as string,
  setInspectorMode: vi.fn(),
  purge: vi.fn(),
  addClient: vi.fn(),
  dialogShown: vi.fn(),
}));

vi.mock('electron', () => {
  const win = { webContents: { send: vi.fn() }, isDestroyed: () => false };
  return {
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
        h.handlers.set(channel, fn);
      },
    },
    dialog: {
      showMessageBox: async () => {
        h.dialogShown();
        return { response: 0 };
      },
    },
    BrowserWindow: { fromWebContents: () => win, getFocusedWindow: () => win, getAllWindows: () => [win] },
    // Le dossier personnel, pour `configureClaudeDesktop` : surtout pas le vrai.
    app: { isPackaged: false, getPath: () => h.projectPath },
    shell: {},
    safeStorage: { isEncryptionAvailable: () => false },
  };
});

vi.mock('../../../services/config-manager.js', () => ({
  configManager: { getLLMConfig: () => ({ backend: 'claude' }) },
}));
vi.mock('../../../services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => h.projectPath },
}));
vi.mock('../../../services/fusion-chat-service.js', () => ({ fusionChatService: {} }));
vi.mock('../../../services/retrieval-service.js', () => ({
  retrievalService: { setInspectorMode: h.setInspectorMode, getInspectorMode: () => 'warn' },
}));
vi.mock('../../../services/secure-storage.js', () => ({ secureStorage: {}, SENSITIVE_KEYS: [] }));
vi.mock('../../../services/recipe-step-handlers.js', () => ({ recipeStepHandlers: {} }));
vi.mock('../../../services/mcp-clients-service.js', () => ({
  mcpClientsService: { subscribe: () => () => undefined, addClient: h.addClient },
}));
vi.mock('../../../../../backend/integrations/obsidian/ObsidianVaultStore.js', () => ({
  ObsidianVaultStore: { purgeObsidianData: h.purge },
}));
vi.mock('../../../services/tropy-service.js', () => ({ tropyService: {} }));
vi.mock('../../../services/pdf-service.js', () => ({ pdfService: {} }));

import { __resetConsentedPaths, rememberConsentedPath } from '../../utils/user-consented-paths.js';
import { setupFusionHandlers } from '../fusion-handlers.js';
import { setupSourcesHandlers } from '../sources-handlers.js';

const VAULT_ON_DISK = {
  schema_version: 2,
  name: 'Thèse',
  vault: { path: '/Volumes/Notes' },
  mcpClients: [{ name: 'europeana', transport: 'sse', url: 'http://127.0.0.1:9/sse' }],
  mcpServer: { enabled: true, serverName: 'these', tools: { search_documents: false } },
  security: { sourceInspectorMode: 'block' },
};
const VALID = JSON.stringify(VAULT_ON_DISK, null, 2);

let root: string;
let configFile: string;
let vaultDir: string;

function call<T = Record<string, unknown>>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`canal non enregistré : ${channel}`);
  return handler({ sender: { isDestroyed: () => false, send: () => undefined } }, ...args) as Promise<T>;
}

const disk = () => JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<string, unknown>;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-fusion-config-'));
  fs.mkdirSync(path.join(root, '.cliodeck'), { recursive: true });
  configFile = path.join(root, '.cliodeck', 'config.json');
  vaultDir = path.join(root, 'coffre');
  fs.mkdirSync(vaultDir);
  __resetConsentedPaths();
  await rememberConsentedPath(vaultDir);
  h.projectPath = root;
  h.setInspectorMode.mockClear();
  h.purge.mockClear();
  h.addClient.mockReset();
  h.dialogShown.mockClear();
  setupFusionHandlers();
  setupSourcesHandlers();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const BROKEN: Array<[string, string, string]> = [
  ['virgule en trop', `${VALID.slice(0, -2)},\n}`, 'ne se lit pas'],
  ['format plus récent', VALID.replace('"schema_version": 2', '"schema_version": 3'), 'Mettez ClioDeck à jour'],
];

describe.each(BROKEN)('%s', (_label, content, wording) => {
  beforeEach(() => {
    fs.writeFileSync(configFile, content);
  });

  it.each<[string, () => Promise<Record<string, unknown>>]>([
    ['fusion:vault:status', () => call('fusion:vault:status')],
    ['fusion:vault:set-path', () => call('fusion:vault:set-path', vaultDir)],
    ['fusion:vault:unlink', () => call('fusion:vault:unlink')],
    ['fusion:vault:index', () => call('fusion:vault:index')],
    ['fusion:vault:import-as-ideas', () => call('fusion:vault:import-as-ideas')],
    ['fusion:mcpServer:get', () => call('fusion:mcpServer:get')],
    ['fusion:mcpServer:set', () => call('fusion:mcpServer:set', { enabled: false })],
    ['fusion:mcpServer:configureClaudeDesktop', () => call('fusion:mcpServer:configureClaudeDesktop')],
    ['fusion:security:set-mode', () => call('fusion:security:set-mode', 'audit')],
    ['fusion:mcp:add', () => call('fusion:mcp:add', { name: 'x', transport: 'sse', url: 'http://127.0.0.1:9/sse' })],
  ])('%s : une erreur lisible, et le fichier reste identique à l’octet', async (channel, run) => {
    const response = await run();

    // Claude Desktop n'existe pas partout, et son binaire peut manquer : ces refus-là passent avant.
    if (channel === 'fusion:mcpServer:configureClaudeDesktop') {
      expect(response.success).toBe(false);
    } else {
      expect(response.success).toBe(false);
      expect(String(response.error)).toContain('.cliodeck/config.json');
      expect(String(response.error)).toContain(wording);
    }
    expect(fs.readFileSync(configFile, 'utf8')).toBe(content);
  });

  it('unlink refusé : l’index du coffre n’est pas purgé', async () => {
    await call('fusion:vault:unlink');
    expect(h.purge).not.toHaveBeenCalled();
  });

  it('set-mode refusé : le mode en mémoire ne bouge pas', async () => {
    await call('fusion:security:set-mode', 'audit');
    expect(h.setInspectorMode).not.toHaveBeenCalled();
  });

  it('mcp:add refusé avant la question : l’auteur ne confirme pas un ajout voué au refus', async () => {
    await call('fusion:mcp:add', {
      name: 'x',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-x'],
    });
    expect(h.dialogShown).not.toHaveBeenCalled();
    expect(h.addClient).not.toHaveBeenCalled();
  });
});

describe('sources:open-note lit config.json sans jamais l’écrire', () => {
  it.each(BROKEN)('%s : le motif, fichier intact', async (_label, content, wording) => {
    fs.writeFileSync(configFile, content);
    const res = await call('sources:open-note', 'note.md');
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain(wording);
    expect(fs.readFileSync(configFile, 'utf8')).toBe(content);
  });

  it('schéma inférieur : accepté, le coffre se lit', async () => {
    fs.writeFileSync(configFile, JSON.stringify({ schema_version: 1, vault: { path: vaultDir } }));
    expect(await call('sources:open-note', 'absente.md')).toMatchObject({ success: false, error: 'note_not_found' });
  });
});

describe('config.json lisible', () => {
  it('absent : l’état du coffre répond « aucun coffre », sans erreur', async () => {
    const status = await call('fusion:vault:status');
    expect(status).toMatchObject({ success: true, vaultPath: null });
  });

  it('coffre lié : l’état le rend', async () => {
    fs.writeFileSync(configFile, VALID);
    expect(await call('fusion:vault:status')).toMatchObject({ success: true, vaultPath: '/Volumes/Notes' });
  });

  it('unlink réussi : le coffre part, le reste reste, puis l’index est purgé', async () => {
    fs.writeFileSync(configFile, VALID);
    expect(await call('fusion:vault:unlink')).toMatchObject({ success: true });
    const after = disk();
    expect(after.vault).toBeUndefined();
    expect(after.mcpClients).toEqual(VAULT_ON_DISK.mcpClients);
    expect(after.mcpServer).toEqual(VAULT_ON_DISK.mcpServer);
    expect(after.security).toEqual(VAULT_ON_DISK.security);
    expect(h.purge).toHaveBeenCalledTimes(1);
  });

  it('mcpServer:set fusionne les outils, garde le nom, et rend le résultat', async () => {
    fs.writeFileSync(configFile, VALID);
    const res = await call('fusion:mcpServer:set', { tools: { read_manuscript: true } });
    expect(res).toMatchObject({
      success: true,
      enabled: true,
      tools: { search_documents: false, read_manuscript: true },
    });
    const server = disk().mcpServer as { serverName: string; tools: Record<string, boolean> };
    expect(server.serverName).toBe('these');
    expect(server.tools).toEqual({ search_documents: false, read_manuscript: true });
  });

  it('set-mode : écrit, puis le mode en mémoire suit', async () => {
    fs.writeFileSync(configFile, VALID);
    expect(await call('fusion:security:set-mode', 'audit')).toMatchObject({ success: true, mode: 'audit' });
    expect((disk().security as { sourceInspectorMode: string }).sourceInspectorMode).toBe('audit');
    expect(h.setInspectorMode).toHaveBeenCalledWith('audit');
  });

  it('lecture puis écriture concurrentes, 10 fois : aucun réglage ne perd celui d’à côté', async () => {
    fs.writeFileSync(configFile, VALID);
    for (let round = 0; round < 10; round += 1) {
      const responses = await Promise.all([
        call('fusion:vault:set-path', vaultDir),
        call('fusion:security:set-mode', round % 2 === 0 ? 'audit' : 'warn'),
        call('fusion:mcpServer:set', { enabled: round % 2 === 0 }),
        call('fusion:mcpServer:set', { tools: { [`outil${round}`]: true } }),
      ]);
      expect(responses.every((r) => r.success === true)).toBe(true);
      const after = disk();
      expect(after.vault).toEqual({ path: vaultDir });
      expect((after.security as { sourceInspectorMode: string }).sourceInspectorMode).toBe(
        round % 2 === 0 ? 'audit' : 'warn'
      );
      const server = after.mcpServer as { enabled: boolean; tools: Record<string, boolean> };
      expect(server.enabled).toBe(round % 2 === 0);
      expect(server.tools[`outil${round}`]).toBe(true);
      expect(after.mcpClients).toEqual(VAULT_ON_DISK.mcpClients);
    }
  });
});
