/**
 * Surveillance du projet Tropy : le main ne suit que le projet lié au projet courant.
 *
 * `tropy:start-watching` adoptait le chemin que lui passait le renderer comme
 * `currentTPYPath` : un `tpyPath` resté du projet A dans le panneau du projet B,
 * qui n'a pas de Tropy, devenait le projet Tropy de B, et la synchro suivante y
 * importait l'archive de A (S18-1-30). La purge, elle, vidait les tables sans
 * arrêter la surveillance (S08-2-9).
 *
 * Vrais handlers IPC, vrai `tropyService`, vrais `TropySync`, `TropyReader` et
 * `TropyWatcher`, vrai brain.db par projet, .tpy écrits par `makeTpy`.
 * Simulés : Electron, la configuration, le fournisseur d'embeddings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sqliteAvailable } from '../../../../../backend/__tests__/helpers/native-guards';
import { makeTpy } from '../../../../../backend/integrations/tropy/__tests__/helpers/make-tpy';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = vi.hoisted(() => new Map<string, Handler>());

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
  BrowserWindow: { getAllWindows: () => [] },
  app: { commandLine: { hasSwitch: () => false }, getPath: () => os.tmpdir() },
}));

vi.mock('../../../services/config-manager.js', () => ({
  configManager: {
    getLLMConfig: () => ({ backend: 'ollama', ollamaURL: 'http://127.0.0.1:1' }),
    getRAGConfig: () => ({ similarityThreshold: 0 }),
    getAPIKey: () => '',
    get: () => undefined,
    set: () => undefined,
  },
}));

vi.mock('../../../../../backend/core/llm/providers/cliodeck-config-adapter.js', () => ({
  createRegistryFromClioDeckConfig: () => ({
    getLLM: () => null,
    getEmbedding: () => ({
      id: 'local-test',
      name: 'local-test',
      model: 'constant',
      dimension: 8,
      getStatus: () => ({ state: 'ready' }),
      healthCheck: async () => ({ state: 'ready' }),
      embed: async (texts: string[]) => texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]),
      dispose: async () => undefined,
    }),
    dispose: async () => undefined,
  }),
}));

const { setupTropyHandlers } = await import('../tropy-handlers.js');
const { tropyService } = await import('../../../services/tropy-service.js');
setupTropyHandlers();

function invoke<T = { success: boolean; error?: string }>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`canal non enregistré : ${channel}`);
  return Promise.resolve(handler({ sender: null }, ...args) as T);
}

function tropyRows(projectDir: string): { sources: number; projects: number } {
  const db = new Database(path.join(projectDir, '.cliodeck', 'brain.db'), { readonly: true });
  try {
    const sources = (db.prepare('SELECT COUNT(*) AS n FROM tropy_sources').get() as { n: number }).n;
    const projects = (db.prepare('SELECT COUNT(*) AS n FROM tropy_projects').get() as { n: number }).n;
    return { sources, projects };
  } finally {
    db.close();
  }
}

let root: string;
let projectB: string;
let tpyA: string;
let tpyC: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-l06-4-main-'));
  projectB = path.join(root, 'projet-B');
  const tropyDir = path.join(root, 'tropy');
  fs.mkdirSync(projectB, { recursive: true });
  fs.mkdirSync(tropyDir, { recursive: true });
  const photo = path.join(tropyDir, 'photo.jpg');
  fs.writeFileSync(photo, 'jpeg factice');
  tpyA = makeTpy(tropyDir, {
    projectId: 'tropy-danzig',
    name: 'Archives Danzig',
    items: [{ id: 10, title: 'Rapport du préfet', photos: [{ id: 11, path: photo }] }],
  });
  tpyC = makeTpy(tropyDir, {
    projectId: 'tropy-comite',
    name: 'Comité de grève',
    items: [
      { id: 10, title: 'Procès-verbal de séance', photos: [{ id: 11, path: photo }] },
      { id: 20, title: 'Affiche', photos: [{ id: 21, path: photo }] },
    ],
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  await tropyService.close();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('tropy:start-watching', () => {
  it('un chemin envoyé par le renderer alors qu’aucun projet Tropy n’est lié : refus, aucune surveillance', async () => {
    await tropyService.init(projectB);

    const result = await invoke('tropy:start-watching', tpyA);

    expect(result.success).toBe(false);
    expect(tropyService.isWatching()).toBe(false);
    // Et la synchro qui suivait n'a rien à lire : rien de A n'entre dans B.
    const sync = await invoke('tropy:sync', { performOCR: false, ocrLanguage: 'fra' });
    expect(sync.success).toBe(false);
    expect(tropyRows(projectB)).toEqual({ sources: 0, projects: 0 });
  });

  it('le projet Tropy lié : surveillé sans qu’aucun chemin ne vienne du renderer', async () => {
    await tropyService.init(projectB);
    await invoke('tropy:open-project', tpyC);
    await invoke('tropy:sync', { performOCR: false, ocrLanguage: 'fra' });

    const result = await invoke('tropy:start-watching');

    expect(result.success).toBe(true);
    expect(tropyService.isWatching()).toBe(true);
    const info = await invoke<{ info: { tpyPath: string; isWatching: boolean } }>('tropy:get-project-info');
    expect(info.info).toMatchObject({ tpyPath: tpyC, isWatching: true });
  });

  it('un autre chemin envoyé alors qu’un projet est lié : c’est le projet lié qui reste surveillé', async () => {
    await tropyService.init(projectB);
    await invoke('tropy:open-project', tpyC);
    await invoke('tropy:sync', { performOCR: false, ocrLanguage: 'fra' });

    await invoke('tropy:start-watching', tpyA);
    await invoke('tropy:sync', { performOCR: false, ocrLanguage: 'fra' });

    const info = await invoke<{ info: { tpyPath: string; name: string } }>('tropy:get-project-info');
    expect(info.info).toMatchObject({ tpyPath: tpyC, name: 'Comité de grève' });
    expect(tropyRows(projectB)).toEqual({ sources: 2, projects: 1 });
  });
});

describe.skipIf(!sqliteAvailable)('tropy:purge', () => {
  it('arrête la surveillance du projet purgé', async () => {
    await tropyService.init(projectB);
    await invoke('tropy:open-project', tpyC);
    await invoke('tropy:sync', { performOCR: false, ocrLanguage: 'fra' });
    await invoke('tropy:start-watching');
    expect(tropyService.isWatching()).toBe(true);

    const result = await invoke('tropy:purge');

    expect(result.success).toBe(true);
    expect(tropyService.isWatching()).toBe(false);
    expect(tropyRows(projectB)).toEqual({ sources: 0, projects: 0 });
  });

  it('après la purge, un autre projet Tropy s’ouvre et se synchronise (le chemin que donne L06-3)', async () => {
    await tropyService.init(projectB);
    await invoke('tropy:open-project', tpyC);
    await invoke('tropy:sync', { performOCR: false, ocrLanguage: 'fra' });
    // Sans purge, l'autre projet est refusé (Q25).
    const refused = await invoke<{ success: boolean; issue?: { code: string } }>('tropy:open-project', tpyA);
    expect(refused.issue?.code).toBe('different-project');

    await invoke('tropy:purge');
    const opened = await invoke('tropy:open-project', tpyA);
    const sync = await invoke('tropy:sync', { performOCR: false, ocrLanguage: 'fra' });

    expect(opened.success).toBe(true);
    expect(sync.success).toBe(true);
    const info = await invoke<{ info: { tpyPath: string; name: string } }>('tropy:get-project-info');
    expect(info.info).toMatchObject({ tpyPath: tpyA, name: 'Archives Danzig' });
    expect(tropyRows(projectB)).toEqual({ sources: 1, projects: 1 });
  });
});
