// @vitest-environment jsdom
/**
 * La réindexation complète des sources primaires (H7), dite à l'écran.
 *
 * Imposée à l'ouverture d'un projet aux extraits d'avant, elle peut durer des heures avec Ollama :
 * le panneau doit dire ce qui se passe, pourquoi, et ce que cela coûte (sources faites sur le
 * total, extraits à refaire comptés au départ), puis, la passe finie, le dire brièvement et
 * s'effacer.
 *
 * Vrais : panneau, stores, preload (derrière un `contextBridge` simulé), handlers IPC,
 * `tropyService`, `TropySync` sur un .tpy écrit par `makeTpy`, brain.db temporaire. Simulés :
 * Electron hors du pont (la fenêtre relaie au preload ce que le main envoie), la configuration, le
 * fournisseur d'embeddings (aucun réseau), arrêté sur son 1er texte le temps de lire le panneau.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
  gate: null as Promise<void> | null,
  reached: null as (() => void) | null,
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
      dimension: 8,
      getStatus: () => ({ state: 'ready' }),
      healthCheck: async () => ({ state: 'ready' }),
      embed: async (texts: string[]) => {
        for (let i = 0; i < texts.length; i++) {
          h.texts += 1;
          if (h.texts === 1 && h.gate) {
            h.reached?.();
            await h.gate;
          }
        }
        return texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]);
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

/** La base telle qu'une version d'avant H7 l'a laissée : pas de version d'extraits. */
function makeBaseFromBefore(): number {
  const db = new Database(path.join(projectDir, '.cliodeck', 'brain.db'));
  try {
    const columns = (db.prepare("PRAGMA table_info('tropy_sources')").all() as Array<{ name: string }>).map(
      (c) => c.name
    );
    if (columns.includes('chunks_version')) db.exec('ALTER TABLE tropy_sources DROP COLUMN chunks_version');
    return (db.prepare('SELECT COUNT(*) AS n FROM tropy_chunks').get() as { n: number }).n;
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
  await waitFor(() => expect(h.invoked.slice(since)).toContain('tropy:get-statistics'));
  await act(async () => undefined);
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-h7-panneau-'));
  projectDir = path.join(root, 'projet');
  const tropyDir = path.join(root, 'tropy');
  fs.mkdirSync(projectDir);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  h.gate = null;
  h.reached = null;
  h.texts = 0;

  // Un projet synchronisé par une version d'avant : trois sources, leurs extraits.
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
});

afterEach(async () => {
  h.gate = null;
  cleanup();
  await tropyService.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  useProjectStore.setState({ currentProject: null });
  usePrimarySourcesStore.setState(INITIAL_STORE, true);
  fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('Sources primaires : la réindexation complète se dit dans le panneau', () => {
  it('le message dit les sources faites sur le total et les extraits à refaire, puis la fin, puis s’efface', async () => {
    const chunkCount = makeBaseFromBefore();
    expect(chunkCount).toBeGreaterThan(3);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    // Ollama lent : la passe s'arrête sur son 1er extrait, le temps de lire le panneau.
    h.texts = 0;
    let open!: () => void;
    h.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      h.reached = resolve;
    });

    render(<PrimarySourcesPanel />);
    await openProject(projectDir);

    const running = await screen.findByText(/Réindexation complète des sources primaires \(/, {}, { timeout: 10_000 });
    await reached;
    expect(running.textContent).toContain('une seule fois, après une mise à jour de ClioDeck');
    expect(running.textContent).toContain('0 / 3 source(s)');
    expect(running.textContent).toContain(`environ ${chunkCount} extrait(s) à refaire`);
    expect(running.textContent).toContain('anciens extraits');

    await act(async () => {
      open();
      await tropyService.whenFullReindexSettled();
    });

    const done = await screen.findByText(/Réindexation complète des sources primaires terminée/);
    expect(done.textContent).toContain('3 source(s)');
    expect(screen.queryByText(/à refaire/)).toBeNull();

    // Un message court, qui s'efface de lui-même : parti au bout d'une minute au plus.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.queryByText(/Réindexation complète/)).toBeNull();
  });
});
