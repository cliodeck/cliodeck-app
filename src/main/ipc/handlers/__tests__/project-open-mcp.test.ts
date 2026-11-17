/**
 * Les clients MCP d'un projet se chargent à son ouverture (A10, S09-1-2). Un projet rouvert n'en
 * avait aucun : seuls les projets créés dans la session chargeaient leurs serveurs, et « Ajouter un
 * client » y échouait (« No project loaded »).
 *
 * Les vrais handlers (`project:*`, `fusion:mcp:add`), la vraie séquence et sa table, le vrai
 * gestionnaire de projet sur un vrai disque, le vrai service des clients MCP et le vrai garde
 * d'accord, avec le mini-serveur local lancé par ce Node-ci : jamais `npx`, aucun réseau. Electron
 * est simulé : `app.getPath('userData')` rend un dossier temporaire, jamais le userData de l'auteur,
 * et seul le dialogue natif répond à la place de l'historien, reconnu au texte de sa question. Les
 * autres services du projet sont remplacés : ils n'écrivent rien dans `.cliodeck`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  userData: '',
  /** Les questions posées, dans l'ordre, et la réponse donnée. */
  questions: [] as Array<{ message: string; response: number }>,
  /** La réponse à une question, par son texte ; `null` la retient jusqu'à `release`. */
  answer: (_message: string): number | null => 0,
  held: [] as Array<() => void>,
  secrets: new Map<string, string>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
  dialog: {
    showMessageBox: async (...args: unknown[]) => {
      const options = args[args.length - 1] as { message: string; cancelId?: number };
      const decided = h.answer(options.message);
      const response =
        decided ?? (await new Promise<number>((resolve) => h.held.push(() => resolve(h.answer(options.message) ?? 0))));
      h.questions.push({ message: options.message, response });
      return { response, checkboxChecked: false };
    },
  },
  BrowserWindow: { fromWebContents: () => null, getFocusedWindow: () => null, getAllWindows: () => [] },
  app: {
    isPackaged: false,
    getPath: () => h.userData,
    getAppPath: () => path.resolve(__dirname, '../../../../..'),
  },
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('../../../services/secure-storage.js', () => ({
  secureStorage: {
    setKey: (k: string, v: string) => void h.secrets.set(k, v),
    getKey: (k: string) => h.secrets.get(k) ?? '',
    deleteKey: (k: string) => void h.secrets.delete(k),
    hasKey: (k: string) => h.secrets.has(k),
  },
  SENSITIVE_KEYS: [],
}));
vi.mock('../../../services/config-manager.js', () => ({
  configManager: {
    addRecentProject: vi.fn(),
    removeRecentProject: vi.fn(),
    getRecentProjects: () => [],
    getLLMConfig: () => ({ backend: 'ollama', ollamaURL: 'http://127.0.0.1:9' }),
    getRAGConfig: () => ({}),
    get: () => undefined,
  },
}));
// Les services du projet sans rapport avec les serveurs MCP : rien ne s'écrit dans `.cliodeck` par eux.
vi.mock('../../../services/history-service.js', () => ({
  historyService: { init: vi.fn(), close: vi.fn(), getHistoryManager: () => null },
}));
vi.mock('../../../services/usage-journal-service.js', () => ({
  usageJournalService: { init: vi.fn(), close: vi.fn() },
}));
vi.mock('../../../services/mode-service.js', () => ({ modeService: { init: vi.fn(), close: vi.fn() } }));
vi.mock('../../../services/tropy-service.js', () => ({ tropyService: { init: vi.fn(), close: vi.fn() } }));
vi.mock('../../../services/retrieval-service.js', () => ({ retrievalService: { clear: vi.fn() } }));
vi.mock('../../../services/pdf-service.js', () => ({
  pdfService: { init: vi.fn(), close: vi.fn(), getCurrentProjectPath: () => null },
}));
vi.mock('../../../services/manuscript-index-service.js', () => ({
  manuscriptIndexService: { configure: vi.fn(), purgeOutside: vi.fn(() => 0) },
}));
vi.mock('../../../services/reading-notes-indexing.js', () => ({ indexReadingNotesInBackground: vi.fn() }));
vi.mock('../../../services/fusion-chat-service.js', () => ({ fusionChatService: {} }));
vi.mock('../../../services/recipe-step-handlers.js', () => ({ recipeStepHandlers: {} }));

import { setupProjectHandlers, type ProjectHandlersHandle } from '../project-handlers.js';
import { setupFusionHandlers } from '../fusion-handlers.js';
import { mcpClientsService } from '../../../services/mcp-clients-service.js';
import { loadMenuTranslations, setLanguage } from '../../../i18n.js';

const SERVER = fileURLToPath(
  new URL('../../../../../backend/integrations/mcp-clients/__tests__/fixtures/mini-mcp-server.mjs', import.meta.url)
);
const LOCALES = path.resolve(__dirname, '../../../../../public/locales');
const fr = JSON.parse(readFileSync(path.join(LOCALES, 'fr', 'menu.json'), 'utf8')) as Record<string, string>;
const ADD_QUESTION = fr.mcpConfirmMessage.replace('{{name}}', 'mini');
const DECLARED_QUESTION = (name: string): string => fr.mcpConfirmLoadMessage.replace('{{name}}', name);

interface Reply {
  success: boolean;
  error?: string;
  instance?: { state: string };
}

let workDir: string;
let pidLog: string;
let project: ProjectHandlersHandle;
/** Chaque chargement des clients MCP lancé par la séquence : on attend sa fin, il ne se voit pas. */
let loads: Array<Promise<void>>;

function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`canal non enregistré : ${channel}`);
  return handler({ sender: { send: () => undefined, isDestroyed: () => false } }, ...args) as Promise<T>;
}

/** Un projet article ; `clients`, ce que déclare son `.cliodeck/config.json` (aucun fichier si absent). */
function makeProject(name: string, clients?: unknown[]): string {
  const dir = path.join(workDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ name, type: 'article' }));
  writeFileSync(path.join(dir, 'document.md'), `# ${name}\n`);
  if (clients) {
    mkdirSync(path.join(dir, '.cliodeck'));
    writeFileSync(
      path.join(dir, '.cliodeck', 'config.json'),
      JSON.stringify({ schema_version: 2, name, mcpClients: clients }, null, 2)
    );
  }
  return path.join(dir, 'project.json');
}

const mini = (...extra: string[]) => ({
  name: 'mini',
  transport: 'stdio' as const,
  command: process.execPath,
  args: [SERVER, pidLog, ...extra],
});

const pids = (): number[] =>
  existsSync(pidLog) ? readFileSync(pidLog, 'utf8').split('\n').filter(Boolean).map(Number) : [];
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const stateOf = (name: string): string | undefined => mcpClientsService.list().find((c) => c.name === name)?.state;

/** Attend la fin des chargements lancés par les ouvertures, sans avancer d'horloge. */
async function loaded(): Promise<void> {
  await vi.waitFor(() => expect(loads.length).toBeGreaterThan(0), { timeout: 10_000 });
  await Promise.all(loads);
}

/** Attend que `condition` soit vraie, au plus `ms` : un processus met un moment à partir ou à mourir. */
async function until(condition: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!condition() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}

beforeAll(() => {
  h.userData = mkdtempSync(path.join(os.tmpdir(), 'cliodeck-userdata-'));
  loadMenuTranslations();
  setLanguage('fr');
  setupFusionHandlers();
});

afterAll(() => {
  rmSync(h.userData, { recursive: true, force: true });
});

beforeEach(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'cliodeck-mcp-ouverture-'));
  // Dans le dossier de chaque test : l'empreinte d'un serveur change d'un test à l'autre, et un
  // accord retenu par l'un ne vaut pas pour le suivant.
  pidLog = path.join(workDir, 'pids.txt');
  h.questions.length = 0;
  h.held.length = 0;
  h.answer = () => 0;
  loads = [];
  const load = mcpClientsService.loadProject.bind(mcpClientsService);
  vi.spyOn(mcpClientsService, 'loadProject').mockImplementation((...args) => {
    const running = load(...args);
    loads.push(running);
    return running;
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  project = setupProjectHandlers();
});

afterEach(async () => {
  for (const release of h.held.splice(0)) release();
  await call('project:close');
  await mcpClientsService.unload();
  vi.restoreAllMocks();
  // Filet, par PID et jamais par motif : un serveur qui survivrait au test.
  for (const pid of pids()) if (alive(pid)) process.kill(pid, 'SIGKILL');
  rmSync(workDir, { recursive: true, force: true });
});

describe('un projet rouvert retrouve ses serveurs MCP (A10)', () => {
  it('serveur ajouté (accord retenu), projet fermé puis rouvert : prêt, sans question ; B ouvert, il s’arrête', async () => {
    const fileA = makeProject('A');
    await call('project:load', fileA);
    await loaded();
    h.answer = (message) => (message === ADD_QUESTION ? 1 : 0);

    // « Ajouter un client » sur un projet rouvert : il échouait (« No project loaded »).
    const added = await call<Reply>('fusion:mcp:add', mini());
    expect(added).toMatchObject({ success: true, instance: { state: 'ready' } });
    await call('project:close');
    await until(() => pids().every((pid) => !alive(pid)), 5_000);
    expect(pids().filter(alive)).toEqual([]);

    await call('project:load', fileA);
    await loaded();

    expect(h.questions.map((q) => q.message)).toEqual([ADD_QUESTION]);
    expect(stateOf('mini')).toBe('ready');
    expect(pids()).toHaveLength(2);
    expect(alive(pids()[1])).toBe(true);

    await call('project:load', makeProject('B'));
    await until(() => !alive(pids()[1]), 5_000);
    expect(alive(pids()[1])).toBe(false);
    expect(mcpClientsService.list()).toEqual([]);
  }, 20_000);

  it('projet reçu d’un tiers : une question avant tout lancement, et rien ne démarre sur un refus', async () => {
    const received = makeProject('Recu', [mini('--outils=2')]);

    const opened = await call<Reply>('project:load', received);
    await loaded();

    expect(opened.success).toBe(true);
    expect(h.questions).toEqual([{ message: DECLARED_QUESTION('mini'), response: 0 }]);
    expect(mcpClientsService.list()).toEqual([]);
    expect(pids()).toEqual([]);

    // Rien de retenu pour un refus : rouvert, le projet repose la question (aucun « ne plus demander »).
    await call('project:close');
    loads = [];
    await call('project:load', received);
    await loaded();
    expect(h.questions.map((q) => q.message)).toEqual([DECLARED_QUESTION('mini'), DECLARED_QUESTION('mini')]);
    expect(pids()).toEqual([]);
  }, 20_000);

  it('projet reçu, question acceptée : prêt ; rouvert : aucune nouvelle question', async () => {
    const received = makeProject('Recu', [mini('--outils=3')]);
    h.answer = (message) => (message === DECLARED_QUESTION('mini') ? 1 : 0);

    await call('project:load', received);
    await loaded();
    expect(stateOf('mini')).toBe('ready');
    await call('project:close');
    loads = [];
    await call('project:load', received);
    await loaded();

    expect(h.questions.map((q) => q.message)).toEqual([DECLARED_QUESTION('mini')]);
    expect(stateOf('mini')).toBe('ready');
  }, 20_000);
});

describe('pas d’attente sans sortie (A10)', () => {
  it('la question sans réponse ne retient pas l’ouverture ; fermer le projet pendant la première, aucune autre', async () => {
    const received = makeProject('Recu', [
      { name: 'premier', transport: 'stdio', command: '/nonexistent/cliodeck-mcp-1' },
      { name: 'second', transport: 'stdio', command: '/nonexistent/cliodeck-mcp-2' },
    ]);
    h.answer = () => null;

    const opened = await call<Reply>('project:load', received);
    expect(opened.success).toBe(true);
    await vi.waitFor(() => expect(h.held).toHaveLength(1), { timeout: 10_000 });

    await call('project:close');
    // Acceptée après coup : rien ne démarre, et la seconde n'est pas posée.
    h.answer = () => 1;
    h.held.splice(0).forEach((release) => release());
    await Promise.all(loads);

    expect(h.questions.map((q) => q.message)).toEqual([DECLARED_QUESTION('premier')]);
    expect(mcpClientsService.list()).toEqual([]);
  });

  it('un serveur lent reste en handshaking : l’ouverture ne l’attend pas, la fermeture l’arrête', async () => {
    const slow = makeProject('Lent', [mini('--lent=60000')]);
    h.answer = (message) => (message === DECLARED_QUESTION('mini') ? 1 : 0);

    const opened = await call<Reply>('project:load', slow);
    expect(opened.success).toBe(true);
    await vi.waitFor(() => expect(stateOf('mini')).toBe('handshaking'), { timeout: 10_000 });
    const pid = pids()[0];
    expect(alive(pid)).toBe(true);

    const startedAt = Date.now();
    await call('project:close');
    // Borné par le manager (5 s par serveur) ; le mini-serveur part dès que son entrée se ferme.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    await until(() => !alive(pid), 5_000);
    expect(alive(pid)).toBe(false);
  }, 30_000);

  it('quitter l’app avec un serveur lancé : aucun processus ne survit à la sortie', async () => {
    const fileA = makeProject('A', [mini('--outils=4')]);
    h.answer = (message) => (message === DECLARED_QUESTION('mini') ? 1 : 0);
    await call('project:load', fileA);
    await loaded();
    expect(stateOf('mini')).toBe('ready');
    const pid = pids()[0];

    // Le budget que l'app donne au projet à la sortie (`shutdownApp` : 8 s moins 1,5 s).
    await project.shutdownProject(6_500);
    await until(() => !alive(pid), 5_000);

    expect(alive(pid)).toBe(false);
    expect(mcpClientsService.list()).toEqual([]);
  }, 20_000);
});

describe('ce que l’ouverture écrit dans .cliodeck (A10)', () => {
  const listing = (dir: string): string[] | null =>
    existsSync(path.join(dir, '.cliodeck')) ? readdirSync(path.join(dir, '.cliodeck')).sort() : null;

  /**
   * Chaque cas, avec ce que `main` laisse dans `.cliodeck` après l'ouverture (mesuré avant A10, où
   * l'ouverture ne chargeait aucun client) : seul le gestionnaire de projet y écrit, par la migration
   * d'un `.cliodeck` sans `config.json`. Un projet sans serveur n'y gagne rien de plus.
   */
  const CASES: Array<[string, (dir: string) => void, string[] | null]> = [
    ['pas de .cliodeck', () => undefined, null],
    [
      'config.json sans serveur',
      (dir) => {
        mkdirSync(path.join(dir, '.cliodeck'));
        writeFileSync(path.join(dir, '.cliodeck', 'config.json'), JSON.stringify({ schema_version: 2, name: 'P' }));
      },
      ['config.json'],
    ],
    [
      '.cliodeck sans config.json (migré à l’ouverture)',
      (dir) => {
        mkdirSync(path.join(dir, '.cliodeck'));
        writeFileSync(path.join(dir, '.cliodeck', 'hints.md'), 'Contexte.\n');
      },
      ['config.json', 'hints.md', 'recipes', 'recipes-runs'],
    ],
  ];

  it.each(CASES)('%s : rien de plus que sur main', async (_label, prepare, expected) => {
    const file = makeProject('P');
    prepare(path.dirname(file));

    await call('project:load', file);
    await Promise.all(loads);
    await call('project:close');

    expect(listing(path.dirname(file))).toEqual(expected);
  });

  it('le dossier du projet disparaît pendant la question : rien n’est recréé à son ancien chemin', async () => {
    const parent = path.join(workDir, 'parent');
    mkdirSync(parent);
    const dir = path.join(parent, 'These');
    mkdirSync(path.join(dir, '.cliodeck'), { recursive: true });
    writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ name: 'These', type: 'article' }));
    writeFileSync(path.join(dir, 'document.md'), '# These\n');
    writeFileSync(
      path.join(dir, '.cliodeck', 'config.json'),
      JSON.stringify({
        schema_version: 2,
        name: 'These',
        mcpClients: [{ name: 'absent', transport: 'stdio', command: '/nonexistent/cliodeck-mcp-absent' }],
      })
    );
    h.answer = () => null;

    await call('project:load', path.join(dir, 'project.json'));
    await vi.waitFor(() => expect(h.held).toHaveLength(1), { timeout: 10_000 });
    renameSync(parent, `${parent}-debranche`);
    h.answer = () => 1;
    h.held.splice(0).forEach((release) => release());
    await Promise.all(loads);

    expect(existsSync(parent)).toBe(false);
  });
});
