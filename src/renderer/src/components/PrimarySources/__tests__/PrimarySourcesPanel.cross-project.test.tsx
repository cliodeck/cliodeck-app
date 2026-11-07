// @vitest-environment jsdom
/**
 * Le scénario de la contre-vérification de S18-1-30, de bout en bout.
 *
 * Projet A lié au Tropy « Archives Danzig » ; on ouvre le projet B, qui n'a pas
 * de Tropy ; dans B, l'œil (synchro automatique) puis « Synchroniser ». Le
 * panneau gardait le projet Tropy de A, l'œil envoyait son chemin au main, qui
 * l'adoptait, et la synchro importait l'archive de A dans le brain.db de B.
 *
 * La garde d'identité de L06-3 est en place et ne l'empêche pas : B n'a aucune
 * source, c'est pour elle une première liaison. Ce qui doit l'empêcher : le
 * panneau ne propose plus rien de A dans B, et le main ne surveille que le
 * projet Tropy lié au projet courant, jamais un chemin reçu du renderer.
 *
 * Vrais : panneau, store, preload (derrière un `contextBridge` simulé, le vrai
 * n'existe que dans Electron), handlers IPC avec leur validation, `tropyService`,
 * `TropySync` et sa garde, `TropyReader` sur un .tpy écrit par `makeTpy`,
 * `TropyWatcher`, et un brain.db par projet dans un dossier temporaire.
 * Simulés : Electron hors du pont, la configuration, le fournisseur
 * d'embeddings (aucun réseau).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SimulatedElectron } from '../../../../../preload/__tests__/helpers/simulated-bridge';
import { sqliteAvailable } from '../../../../../../backend/__tests__/helpers/native-guards';
import { makeTpy } from '../../../../../../backend/integrations/tropy/__tests__/helpers/make-tpy';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const h = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  invoked: [] as string[],
  sim: null as SimulatedElectron | null,
}));

vi.mock('electron', async () => {
  const { createSimulatedElectron } = await import('../../../../../preload/__tests__/helpers/simulated-bridge');
  const sim = createSimulatedElectron();
  // Le renderer parle au main par les vrais handlers, comme `ipcRenderer.invoke`.
  sim.module.ipcRenderer.invoke = async (channel: string, ...args: unknown[]) => {
    h.invoked.push(channel);
    const handler = h.handlers.get(channel);
    if (!handler) throw new Error(`canal non enregistré : ${channel}`);
    return handler({ sender: null }, ...args);
  };
  h.sim = sim;
  return {
    ...sim.module,
    ipcMain: { handle: (channel: string, fn: Handler) => h.handlers.set(channel, fn) },
    BrowserWindow: { getAllWindows: () => [] },
    app: { commandLine: { hasSwitch: () => false }, getPath: () => os.tmpdir() },
  };
});

vi.mock('../../../../../main/services/config-manager.js', () => ({
  configManager: {
    getLLMConfig: () => ({ backend: 'ollama', ollamaURL: 'http://127.0.0.1:1' }),
    getRAGConfig: () => ({ similarityThreshold: 0 }),
    getAPIKey: () => '',
    get: () => undefined,
    set: () => undefined,
  },
}));

vi.mock('../../../../../../backend/core/llm/providers/cliodeck-config-adapter.js', () => ({
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

// Le vrai preload, exposé à la page comme le fait `contextBridge`.
await import('../../../../../preload/index');
(window as unknown as { electron: unknown }).electron = (h.sim as SimulatedElectron).exposed();

const { setupTropyHandlers } = await import('../../../../../main/ipc/handlers/tropy-handlers.js');
const { tropyService } = await import('../../../../../main/services/tropy-service.js');
const { TropySync } = await import('../../../../../../backend/integrations/tropy/TropySync.js');
const { PrimarySourcesPanel } = await import('../PrimarySourcesPanel');
const { usePrimarySourcesStore } = await import('../../../stores/primarySourcesStore');
const { useProjectStore } = await import('../../../stores/projectStore');
setupTropyHandlers();

const INITIAL_STORE = usePrimarySourcesStore.getState();

let root: string;
let projectA: string;
let projectB: string;
let tpyA: string;
let syncSpy: ReturnType<typeof vi.spyOn>;

const project = (dir: string) => ({
  id: path.basename(dir),
  name: path.basename(dir),
  path: dir,
  type: 'article' as const,
  createdAt: new Date(),
  lastOpenedAt: new Date(),
});

/** Ce que le brain.db d'un projet tient de Tropy. */
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

/** Ouvre un projet comme `project:load` puis `projectStore` : le main d'abord, le renderer ensuite. */
async function openProject(dir: string): Promise<void> {
  await tropyService.init(dir);
  const since = h.invoked.length;
  await act(async () => {
    useProjectStore.setState({ currentProject: project(dir) });
  });
  // Le panneau a fini de lire le projet : sa dernière lecture est celle des statistiques.
  await waitFor(() => expect(h.invoked.slice(since)).toContain('tropy:get-statistics'));
  await act(async () => undefined);
}

/** Les appels de la synchro faits depuis l'ouverture de B, avec le .tpy de A. */
const syncsOfAAfter = (since: number) =>
  syncSpy.mock.calls.slice(since).filter((call: unknown[]) => call[0] === tpyA);

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-l06-4-'));
  projectA = path.join(root, 'projet-A');
  projectB = path.join(root, 'projet-B');
  const tropyDir = path.join(root, 'tropy');
  for (const dir of [projectA, projectB, tropyDir]) fs.mkdirSync(dir, { recursive: true });
  const photo = path.join(tropyDir, 'rapport.jpg');
  fs.writeFileSync(photo, 'jpeg factice');
  tpyA = makeTpy(tropyDir, {
    projectId: 'tropy-danzig',
    name: 'Archives Danzig',
    items: [
      { id: 10, title: 'Rapport du préfet', photos: [{ id: 11, path: photo }] },
      { id: 20, title: 'Lettre du commissaire', photos: [{ id: 21, path: photo }] },
    ],
  });

  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  syncSpy = vi.spyOn(TropySync.prototype, 'sync');

  // Projet A, lié à « Archives Danzig » par le panneau, synchronisé.
  render(<PrimarySourcesPanel />);
  await openProject(projectA);
  await act(async () => {
    await usePrimarySourcesStore.getState().openTPYProject(tpyA);
  });
  expect(await screen.findByText('Archives Danzig')).toBeInTheDocument();
  expect(tropyRows(projectA)).toEqual({ sources: 2, projects: 1 });
});

afterEach(async () => {
  cleanup();
  await tropyService.close();
  vi.restoreAllMocks();
  useProjectStore.setState({ currentProject: null });
  usePrimarySourcesStore.setState(INITIAL_STORE, true);
  fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('Sources primaires : le projet B n’importe pas l’archive du projet A', () => {
  it('B sans Tropy : l’œil puis « Synchroniser », s’ils sont proposés, n’amènent rien de A dans B', async () => {
    const since = syncSpy.mock.calls.length;
    await openProject(projectB);

    // Le geste de la contre-vérification, sur ce que le panneau propose dans B.
    const eye = screen.queryByTitle('Enable auto-sync');
    if (eye) await act(async () => fireEvent.click(eye));
    const sync = screen.queryByTitle('Synchronize');
    if (sync) {
      await act(async () => fireEvent.click(sync));
      await waitFor(() => expect(usePrimarySourcesStore.getState().isSyncing).toBe(false));
    }

    expect(syncsOfAAfter(since)).toEqual([]);
    expect(tropyRows(projectB)).toEqual({ sources: 0, projects: 0 });
    expect(tropyService.isWatching()).toBe(false);
    // Le panneau de B est celui d'un projet sans Tropy.
    expect(screen.queryByText('Archives Danzig')).not.toBeInTheDocument();
    expect(screen.getByText('No Tropy Project')).toBeInTheDocument();
    expect(screen.queryByTitle('Synchronize')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Enable auto-sync')).not.toBeInTheDocument();
  });

  it('même un renderer resté sur le chemin de A : la surveillance et la synchro de B le refusent', async () => {
    const since = syncSpy.mock.calls.length;
    await openProject(projectB);
    // L'état qu'avait le panneau de B avant le correctif.
    act(() => {
      usePrimarySourcesStore.setState({
        tpyPath: tpyA,
        projectInfo: { name: 'Archives Danzig', itemCount: 2, lastModified: '', isWatching: false, tpyPath: tpyA },
      });
    });

    // Ce que font l'œil et « Synchroniser ».
    await act(async () => {
      await usePrimarySourcesStore.getState().startWatching();
      await usePrimarySourcesStore.getState().syncTPY({ performOCR: false, ocrLanguage: 'fra' });
    });

    expect(syncsOfAAfter(since)).toEqual([]);
    expect(tropyRows(projectB)).toEqual({ sources: 0, projects: 0 });
    expect(tropyService.isWatching()).toBe(false);
    expect(usePrimarySourcesStore.getState().projectInfo?.isWatching).toBe(false);
  });

  it('revenir au projet A : son projet Tropy et ses sources réapparaissent, rien n’a bougé', async () => {
    await openProject(projectB);
    await openProject(projectA);

    expect(await screen.findByText('Archives Danzig')).toBeInTheDocument();
    expect(screen.getByText('Rapport du préfet')).toBeInTheDocument();
    expect(screen.getByTitle('Synchronize')).toBeInTheDocument();
    expect(tropyRows(projectA)).toEqual({ sources: 2, projects: 1 });
  });
});
