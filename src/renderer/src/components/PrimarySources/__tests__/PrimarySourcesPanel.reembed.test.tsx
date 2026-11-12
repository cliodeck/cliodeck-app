// @vitest-environment jsdom
/**
 * Après un changement de modèle d'embeddings, la réindexation des sources primaires est proposée
 * dans le panneau, jamais faite d'office (L06-9 : J7, Q29).
 *
 * Les extraits calculés par l'ancien modèle ne se comparent pas aux questions du nouveau : la
 * recherche par le sens les perd. Le seul remède était la purge, qui efface aussi les
 * transcriptions et l'OCR. Le panneau dit combien de sources et d'extraits sont concernés, et que
 * les transcriptions sont gardées ; « Réindexer », une fois confirmé, les refait par la passe de la
 * réindexation complète (H7), dite à l'écran.
 *
 * Vrais : panneau, stores, registre du projet, preload (derrière un `contextBridge` simulé),
 * handlers IPC, `tropyService`, `TropySync` sur un .tpy écrit par `makeTpy`, brain.db temporaire.
 * Simulés : Electron hors du pont (la fenêtre relaie au preload ce que le main envoie), la
 * configuration, le projet ouvert côté main, le fournisseur d'embeddings (aucun réseau), dont la
 * dimension change comme après un changement de modèle.
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
  /** La dimension du modèle d'embeddings : 8, puis 16 après le changement de modèle. */
  dimension: 8,
  texts: 0,
}));

vi.mock('electron', async () => {
  const { createSimulatedElectron } = await import('../../../../../preload/__tests__/helpers/simulated-bridge');
  const sim = createSimulatedElectron();
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
    // La fenêtre de l'app : ce que le main lui envoie arrive au preload.
    BrowserWindow: {
      getAllWindows: () => [
        { webContents: { send: (channel: string, ...args: unknown[]) => sim.sendFromMain(channel, ...args) } },
      ],
    },
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
      get dimension() {
        return h.dimension;
      },
      getStatus: () => ({ state: 'ready' }),
      healthCheck: async () => ({ state: 'ready' }),
      embed: async (texts: string[]) => {
        h.texts += texts.length;
        return texts.map(() => Array.from({ length: h.dimension }, (_, i) => (i === 0 ? 1 : 0)));
      },
      dispose: async () => undefined,
    }),
    dispose: async () => undefined,
  }),
}));

// Les vraies chaînes françaises, interpolées : le message doit dire les comptes.
vi.mock('react-i18next', async () => {
  const i18next = (await import('i18next')).default;
  const fr = (await import('../../../../../../public/locales/fr/common.json')).default;
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'fr',
    ns: ['common'],
    defaultNS: 'common',
    resources: { fr: { common: fr } },
    interpolation: { escapeValue: false },
  });
  return {
    useTranslation: () => ({ t: instance.t.bind(instance), i18n: instance }),
    Trans: ({ children }: { children?: unknown }) => children ?? null,
    initReactI18next: { type: '3rdParty', init: () => undefined },
  };
});

// Le vrai preload, exposé à la page comme le fait `contextBridge`.
await import('../../../../../preload/index');
(window as unknown as { electron: unknown }).electron = (h.sim as SimulatedElectron).exposed();

const { setupTropyHandlers } = await import('../../../../../main/ipc/handlers/tropy-handlers.js');
const { tropyService } = await import('../../../../../main/services/tropy-service.js');
const { PrimarySourcesPanel } = await import('../PrimarySourcesPanel');
const { usePrimarySourcesStore } = await import('../../../stores/primarySourcesStore');
const { useProjectStore } = await import('../../../stores/projectStore');
const { useDialogStore } = await import('../../../stores/dialogStore');
const { projectLifecycle } = await import('../../../lifecycle/projectLifecycle');
const { projectManager } = await import('../../../../../main/services/project-manager.js');
setupTropyHandlers();

const INITIAL_STORE = usePrimarySourcesStore.getState();
// Attendre le résultat, pas un délai : cette borne n'est qu'un garde-fou pour une CI lente.
vi.setConfig({ testTimeout: 30_000 });

const SYLLABLES = ['ba', 'cor', 'di', 'fu', 'gal', 'le', 'mi', 'nor', 'pa', 'ru', 'sel', 'to', 'van', 'ze', 'qui', 'ran', 'tel', 'mor'];
function word(n: number): string {
  let s = '';
  for (let k = 0, x = n; k < 4; k++, x = Math.floor(x / SYLLABLES.length)) s += SYLLABLES[x % SYLLABLES.length];
  return s;
}
/** Une note de 500 caractères ou plus : la transcription de la source (Q26). */
function noteOf(offset: number): string {
  return Array.from({ length: 50 }, (_, i) =>
    `${Array.from({ length: 12 }, (_, k) => word(offset + 12 * i + k)).join(' ')}.`
  ).join(' ');
}

let root: string;
let projectDir: string;

const project = (dir: string) => ({
  id: path.basename(dir),
  name: path.basename(dir),
  path: dir,
  type: 'article' as const,
  createdAt: new Date(),
  lastOpenedAt: new Date(),
});

const brainDb = () => path.join(projectDir, '.cliodeck', 'brain.db');

/** Les dimensions des vecteurs en base, et le nombre d'extraits. */
function chunksInBase(): { dimensions: number[]; count: number } {
  const db = new Database(brainDb(), { readonly: true });
  try {
    const dimensions = (
      db.prepare('SELECT DISTINCT length(embedding) / 4 AS d FROM tropy_chunks ORDER BY d').all() as Array<{ d: number }>
    ).map((r) => r.d);
    const count = (db.prepare('SELECT COUNT(*) AS n FROM tropy_chunks').get() as { n: number }).n;
    return { dimensions, count };
  } finally {
    db.close();
  }
}

/** Ce que l'historien a écrit : transcriptions et notes, source par source. */
function transcriptions(): unknown {
  const db = new Database(brainDb(), { readonly: true });
  try {
    return db.prepare('SELECT id, transcription, transcription_source, notes_text FROM tropy_sources ORDER BY id').all();
  } finally {
    db.close();
  }
}

/** Ouvre un projet comme `project:load` puis `projectStore` : le main d'abord, le renderer ensuite. */
async function openProject(dir: string): Promise<void> {
  await tropyService.init(dir);
  await tropyService.whenFullReindexSettled();
  const since = h.invoked.length;
  await act(async () => {
    projectLifecycle.enter(dir);
    useProjectStore.setState({ currentProject: project(dir) });
  });
  await waitFor(() => expect(h.invoked.slice(since)).toContain('tropy:get-reembed-proposal'));
  await act(async () => undefined);
}

async function closeProject(): Promise<void> {
  await tropyService.close();
  await act(async () => {
    projectLifecycle.enter(null);
    useProjectStore.setState({ currentProject: null });
  });
}

const TITLE = 'Sources primaires à réindexer pour le nouveau modèle de recherche sémantique';
const notice = () => screen.queryByText(TITLE);

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-l069-panneau-'));
  projectDir = path.join(root, 'projet');
  const tropyDir = path.join(root, 'tropy');
  fs.mkdirSync(projectDir);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(projectManager, 'getCurrentProjectPath').mockImplementation(() => projectDir);
  h.dimension = 8;
  h.texts = 0;
  h.invoked.length = 0;

  // Un projet synchronisé avec l'ancien modèle : trois sources, leurs extraits en 8 dimensions.
  const tpy = makeTpy(tropyDir, {
    projectId: 'tropy-greves',
    name: 'Grèves nantaises',
    items: [
      { id: 10, title: 'Arrêté du maire', notes: [{ text: noteOf(0) }] },
      { id: 20, title: 'Lettre à Yves', notes: [{ text: noteOf(1000) }] },
      { id: 30, title: 'Rapport du commissaire', notes: [{ text: noteOf(2000) }] },
    ],
  });
  await tropyService.init(projectDir);
  expect((await tropyService.openProject(tpy)).success).toBe(true);
  expect((await tropyService.sync({ performOCR: false, ocrLanguage: 'fra' })).issues).toEqual([]);
  await tropyService.close();
  // Le modèle d'embeddings change : 16 dimensions.
  h.dimension = 16;
  h.texts = 0;
});

afterEach(async () => {
  cleanup();
  await closeProject();
  vi.restoreAllMocks();
  usePrimarySourcesStore.setState(INITIAL_STORE, true);
  useDialogStore.setState({ queue: [], confirmOpen: false, alertOpen: false });
  fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('Sources primaires : après un changement de modèle, la réindexation est proposée', () => {
  it('rien sans geste ; le bandeau dit les sources, les extraits, les deux dimensions et que les transcriptions sont gardées', async () => {
    const { count } = chunksInBase();
    render(<PrimarySourcesPanel />);
    await openProject(projectDir);

    expect(await screen.findByText(TITLE)).toBeTruthy();
    const message = screen.getByText(/« Réindexer » recalcule/).textContent ?? '';
    expect(message).toContain('3 source(s) primaire(s)');
    expect(message).toContain(`leurs ${count} extrait(s) actuels`);
    expect(message).toContain('8 dimensions');
    expect(message).toContain('en produit 16');
    expect(message).toContain('Les transcriptions sont gardées');
    expect(message).toContain("l'OCR n'est pas refait");
    // Aucun réembarquement d'office.
    expect(h.texts).toBe(0);
    expect(chunksInBase()).toEqual({ dimensions: [8], count });
  });

  it('« Réindexer », confirmé : les sources sont refaites en 16 dimensions, transcriptions intactes, et le panneau le dit', async () => {
    const before = transcriptions();
    render(<PrimarySourcesPanel />);
    await openProject(projectDir);
    await screen.findByText(TITLE);

    fireEvent.click(screen.getByRole('button', { name: /Réindexer/ }));
    // La confirmation dit ce que la passe coûte et ce qu'elle garde ; rien n'est détruit, pas de rouge.
    await waitFor(() => expect(useDialogStore.getState().confirmOpen).toBe(true));
    const confirm = useDialogStore.getState();
    expect(confirm.confirmTitle).toBe('Réindexer les sources primaires');
    expect(confirm.confirmMessage).toContain('3 source(s) primaire(s)');
    expect(confirm.confirmMessage).toContain('Les transcriptions sont gardées');
    expect(confirm.confirmMessage).toContain('vous sera proposée de nouveau à la prochaine ouverture');
    expect(confirm.confirmDanger).toBe(false);
    expect(h.texts).toBe(0);

    await act(async () => {
      useDialogStore.getState().resolveConfirm(true);
    });
    await act(async () => {
      await tropyService.whenFullReindexSettled();
    });

    expect(
      await screen.findByText(/Réindexation des sources primaires pour le nouveau modèle de recherche sémantique terminée : 3 source\(s\)/)
    ).toBeTruthy();
    await waitFor(() => expect(notice()).toBeNull());
    expect(chunksInBase().dimensions).toEqual([16]);
    expect(transcriptions()).toEqual(before);
  });

  it('confirmation refusée : rien ne part, le bandeau reste', async () => {
    render(<PrimarySourcesPanel />);
    await openProject(projectDir);
    await screen.findByText(TITLE);

    fireEvent.click(screen.getByRole('button', { name: /Réindexer/ }));
    await waitFor(() => expect(useDialogStore.getState().confirmOpen).toBe(true));
    await act(async () => {
      useDialogStore.getState().resolveConfirm(false);
    });

    expect(h.invoked).not.toContain('tropy:reembed');
    expect(h.texts).toBe(0);
    expect(notice()).toBeTruthy();
  });

  it('« Plus tard » : le bandeau se ferme sans rien lancer, et revient à la prochaine ouverture du projet', async () => {
    render(<PrimarySourcesPanel />);
    await openProject(projectDir);
    await screen.findByText(TITLE);

    fireEvent.click(screen.getByRole('button', { name: /Plus tard/ }));
    expect(notice()).toBeNull();
    expect(h.texts).toBe(0);

    await closeProject();
    await openProject(projectDir);
    expect(await screen.findByText(TITLE)).toBeTruthy();
    expect(h.texts).toBe(0);
  });

  it('un autre projet que l’ouvert : ni proposition lue, ni réindexation lancée (project-changed)', async () => {
    await tropyService.init(projectDir);
    await tropyService.whenFullReindexSettled();
    const other = path.join(root, 'autre-projet');

    expect(await h.handlers.get('tropy:get-reembed-proposal')?.({ sender: null }, other)).toMatchObject({
      success: false,
      error: 'project-changed',
    });
    expect(await h.handlers.get('tropy:reembed')?.({ sender: null }, other)).toMatchObject({
      success: false,
      error: 'project-changed',
    });
    await tropyService.whenFullReindexSettled();
    expect(h.texts).toBe(0);
    // Témoin : le projet ouvert, lui, a sa proposition.
    expect(await h.handlers.get('tropy:get-reembed-proposal')?.({ sender: null }, projectDir)).toMatchObject({
      success: true,
      proposal: { sources: 3, expected: 8, actual: 16 },
    });
  });

  it('témoin : le modèle d’avant, rien n’est proposé', async () => {
    h.dimension = 8;
    render(<PrimarySourcesPanel />);
    await openProject(projectDir);

    expect(notice()).toBeNull();
  });
});
