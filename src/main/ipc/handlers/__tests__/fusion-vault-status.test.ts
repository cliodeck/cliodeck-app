/**
 * Le statut du vault dit ce que l'index contient (S09-1-14, S17-1-10).
 *
 * `fusion:vault:status` répondait `indexed: true` dès que `.cliodeck/brain.db` existait. Or ce
 * fichier est partagé (PDF, Tropy, journal) et naît à l'ouverture de tout projet : les Réglages
 * affichaient « Index : prêt » pour un vault jamais indexé, ou détaché. Et la barre d'état lisait
 * un `noteCount` que personne ne répondait.
 *
 * Le vrai handler, le vrai magasin, un vrai `brain.db` ; seuls les services voisins sont simulés.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sqliteAvailable } from '../../../../../backend/__tests__/helpers/native-guards.js';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  /** Le projet ouvert, lu par le handler à chaque appel de `getCurrentProjectPath`. */
  current: vi.fn<() => string | null>(),
}));

vi.mock('electron', () => {
  const win = { webContents: { send: vi.fn() }, isDestroyed: () => false };
  return {
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
        h.handlers.set(channel, fn);
      },
    },
    dialog: {},
    BrowserWindow: { fromWebContents: () => win, getFocusedWindow: () => win, getAllWindows: () => [win] },
    app: { isPackaged: false, getPath: () => os.tmpdir() },
    shell: {},
    safeStorage: { isEncryptionAvailable: () => false },
  };
});

vi.mock('../../../services/config-manager.js', () => ({
  configManager: { getLLMConfig: () => ({ backend: 'ollama' }) },
}));
vi.mock('../../../services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => h.current() },
}));
vi.mock('../../../services/fusion-chat-service.js', () => ({ fusionChatService: {} }));
vi.mock('../../../services/retrieval-service.js', () => ({
  retrievalService: { setInspectorMode: vi.fn(), getInspectorMode: () => 'warn' },
}));
vi.mock('../../../services/secure-storage.js', () => ({ secureStorage: {}, SENSITIVE_KEYS: [] }));
vi.mock('../../../services/recipe-step-handlers.js', () => ({ recipeStepHandlers: {} }));
vi.mock('../../../services/mcp-clients-service.js', () => ({
  mcpClientsService: { subscribe: () => () => undefined, list: () => [] },
}));
vi.mock('../../../services/tropy-service.js', () => ({ tropyService: {} }));
vi.mock('../../../services/pdf-service.js', () => ({ pdfService: {} }));

import { setupFusionHandlers } from '../fusion-handlers.js';
import { ObsidianVaultStore } from '../../../../../backend/integrations/obsidian/ObsidianVaultStore.js';
import { obsidianStorePath } from '../../../../../backend/integrations/obsidian/ObsidianVaultIndexer.js';

let tmp: string;
let projectA: string;
let projectB: string;
let vaultDir: string;

function call<T = Record<string, unknown>>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`canal non enregistré : ${channel}`);
  return handler({ sender: { isDestroyed: () => false, send: () => undefined } }, ...args) as Promise<T>;
}

function makeProject(name: string, vault: string | null): string {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, '.cliodeck'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.cliodeck', 'config.json'),
    JSON.stringify({ schema_version: 2, name, ...(vault ? { vault: { path: vault } } : {}) })
  );
  return root;
}

function note(id: string) {
  return {
    id,
    relativePath: `${id}.md`,
    vaultPath: vaultDir,
    title: id,
    tags: [],
    frontmatter: {},
    wikilinks: [],
    fileHash: `hash-${id}`,
    fileMtime: 0,
    indexedAt: '2026-11-13T10:00:00.000Z',
  };
}

/** Un index du vault comme l'indexeur l'écrit, ses notes comprises. */
function indexNotes(root: string, ids: string[]): ObsidianVaultStore {
  const store = new ObsidianVaultStore({ dbPath: obsidianStorePath(root), dimension: 4 });
  for (const id of ids) store.upsertNote(note(id));
  return store;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-vault-status-')));
  vaultDir = path.join(tmp, 'coffre');
  fs.mkdirSync(vaultDir);
  projectA = makeProject('A', vaultDir);
  projectB = makeProject('B', vaultDir);
  h.handlers.clear();
  h.current.mockReset();
  h.current.mockReturnValue(projectA);
  setupFusionHandlers();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('fusion:vault:status : indexed et noteCount lus dans brain.db', () => {
  it('brain.db présent sans table obsidian : indexed=false et noteCount=0', async () => {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(obsidianStorePath(projectA));
    db.exec('CREATE TABLE pdf_documents (id TEXT PRIMARY KEY)');
    db.close();

    const status = await call('fusion:vault:status');

    expect(status).toMatchObject({ success: true, indexed: false, noteCount: 0, vaultPath: vaultDir });
  });

  it('deux notes indexées, magasin de l’indexeur encore ouvert : indexed=true et noteCount=2', async () => {
    const store = indexNotes(projectA, ['gdansk', 'port-franc']);
    try {
      const status = await call('fusion:vault:status');

      expect(status).toMatchObject({ success: true, indexed: true, noteCount: 2 });
      // La lecture n'a rien retenu : l'indexeur écrit encore.
      store.upsertNote(note('senat'));
    } finally {
      store.close();
    }
    expect(await call('fusion:vault:status')).toMatchObject({ noteCount: 3 });
  });

  it('après « Détacher » : les tables obsidian_* sont parties, le statut le dit', async () => {
    indexNotes(projectA, ['gdansk']).close();
    ObsidianVaultStore.purgeObsidianData(obsidianStorePath(projectA));

    expect(await call('fusion:vault:status')).toMatchObject({ success: true, indexed: false, noteCount: 0 });
  });

  it('pas de brain.db : 0 note, et la lecture ne le crée pas', async () => {
    const status = await call('fusion:vault:status');

    expect(status).toMatchObject({ success: true, indexed: false, noteCount: 0 });
    expect(fs.existsSync(obsidianStorePath(projectA))).toBe(false);
  });

  it('le projet change pendant la lecture : refus project-changed, et aucune base n’est ouverte', async () => {
    indexNotes(projectA, ['gdansk']).close();
    indexNotes(projectB, ['senat', 'port-franc', 'douane']).close();
    const count = vi.spyOn(ObsidianVaultStore, 'countNotes');
    // A à l'entrée du handler, B dès la première attente passée.
    h.current.mockReset();
    h.current.mockReturnValueOnce(projectA).mockReturnValue(projectB);

    const status = await call('fusion:vault:status');

    expect(status).toMatchObject({ success: false, error: 'project-changed' });
    expect(count).not.toHaveBeenCalled();
  });

  it('témoin : le projet B ouvert, ses notes à lui', async () => {
    indexNotes(projectA, ['gdansk']).close();
    indexNotes(projectB, ['senat', 'port-franc', 'douane']).close();
    h.current.mockReturnValue(projectB);

    expect(await call('fusion:vault:status')).toMatchObject({ success: true, noteCount: 3 });
  });
});
