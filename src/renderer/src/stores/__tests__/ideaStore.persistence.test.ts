// @vitest-environment jsdom
/**
 * `ideas.json` : un fichier abîmé se met de côté, une lecture impossible n'écrit rien, et
 * les sauvegardes passent une par une (S15-1-2, S16-1-19).
 *
 * Rien n'est simulé jusqu'au disque : `window.electron.fs` appelle les VRAIS handlers `fs:*`.
 * Seuls sont simulés le projet courant du main et, là où le système ne sait pas le faire à
 * la demande, une erreur de lecture : ETIMEDOUT, ce que rend un fichier OneDrive dont les
 * données ne sont pas sur le disque (mesuré sur un vrai `ideas.json`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { hasUnwrittenIdeas, useIdeaStore, type Idea } from '../ideaStore';
import { projectLifecycle } from '../../lifecycle/projectLifecycle';

// Vrai disque et plusieurs allers-retours par test : à 24 `yes` sur 14 cœurs, l'un d'eux dépassait les 5 s par défaut.
vi.setConfig({ testTimeout: 30_000 });

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  mainCurrent: null as string | null,
  /** Les lectures de ce chemin échouent comme un fichier OneDrive sans ses données. */
  readTimesOut: null as string | null,
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const mocked = {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (args[0] === h.readTimesOut) {
        throw Object.assign(new Error(`ETIMEDOUT: operation timed out, read '${String(args[0])}'`), {
          code: 'ETIMEDOUT',
        });
      }
      return actual.readFile(...args);
    },
  };
  return { ...mocked, default: mocked };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
  dialog: {},
  shell: {},
  BrowserWindow: { fromWebContents: () => null },
  app: { isPackaged: false, getPath: () => '/tmp', getAppPath: () => '/nonexistent-app-path' },
}));
vi.mock('../../../../main/services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => h.mainCurrent },
}));
vi.mock('../../../../main/services/config-manager.js', () => ({
  configManager: { get: () => undefined, set: () => undefined },
}));

const { setupFilesystemHandlers } = await import('../../../../main/ipc/handlers/filesystem-handlers');

const IS_ROOT = process.getuid?.() === 0;
const QUARANTINE = /^ideas\.json\.illisible-/;
const IDEAS_IO_DEADLINE_MS = 15_000;

let root: string;
let dirA: string;
let dirB: string;
let ideasA: string;
let ideasB: string;
/** Chaque écriture demandée au main, avec ce qu'elle contient. */
let writes: Array<{ filePath: string; content: string }>;
let inflightWrites: number;
let maxInflightWrites: number;
/** Appelé après chaque lecture, avant que le store n'en reçoive le résultat. */
let afterRead: (() => Promise<void>) | null;
/** Retient les écritures au main le temps de le libérer. */
let holdWrites: Promise<void> | null;

const store = () => useIdeaStore.getState();
const ideasFileOf = (dir: string) => path.join(dir, '.cliodeck', 'ideas.json');

function ipc<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`canal non enregistré : ${channel}`);
  return handler({}, ...args) as Promise<T>;
}

function installMain(): void {
  (window as unknown as { electron: unknown }).electron = {
    fs: {
      exists: (filePath: string) => ipc('fs:exists', filePath),
      readUserFile: async (filePath: string) => {
        const read = await ipc('fs:read-user-file', filePath);
        await afterRead?.();
        return read;
      },
      writeFile: async (filePath: string, content: string, options?: { exclusive?: boolean }) => {
        writes.push({ filePath, content });
        inflightWrites++;
        maxInflightWrites = Math.max(maxInflightWrites, inflightWrites);
        try {
          await holdWrites;
          return await ipc('fs:write-file', filePath, content, options);
        } finally {
          inflightWrites--;
        }
      },
      quarantineFile: (filePath: string) => ipc('fs:quarantine-file', filePath),
    },
  };
}

function idea(title: string, extra: Partial<Idea> = {}): Idea {
  return {
    id: `idee-${title}`,
    title,
    content: `Notes sur ${title}.`,
    tags: [],
    links: [],
    origin: { type: 'manual' },
    createdAt: '2026-05-06T10:00:00.000Z',
    updatedAt: '2026-05-06T10:00:00.000Z',
    ...extra,
  };
}

function ideasFile(titles: string[]): string {
  return JSON.stringify({ ideas: titles.map((title) => idea(title)) }, null, 2);
}

const titles = () => store().ideas.map((i) => i.title);
const onDisk = (file: string) => (JSON.parse(fs.readFileSync(file, 'utf8')) as { ideas: Idea[] }).ideas;
const titlesOnDisk = (file: string) => onDisk(file).map((i) => i.title);
const quarantined = (dir: string) =>
  fs
    .readdirSync(path.join(dir, '.cliodeck'))
    .filter((name) => QUARANTINE.test(name))
    .map((name) => path.join(dir, '.cliodeck', name));

/** Le fichier mis de côté : il doit y en avoir un, et un seul. */
function theBackup(dir: string): string {
  const files = quarantined(dir);
  expect(files).toHaveLength(1);
  return files[0];
}

const newIdea = (title: string) =>
  store().addIdea({ title, content: '', tags: [], links: [], origin: { type: 'manual' } });

/** Le main bascule, puis le panneau recharge : l'ordre de `openProjectContents`. */
function mainSwitchesTo(dir: string): void {
  h.mainCurrent = dir;
}

/** Pour un test sur la file seule : le main est toujours sur le projet qu'on lui demande. */
function mainFollowsRequests(): void {
  const { readUserFile, writeFile } = window.electron.fs;
  const follow = (filePath: string) => {
    h.mainCurrent = filePath === ideasB ? dirB : dirA;
  };
  Object.assign(window.electron.fs, {
    readUserFile: (filePath: string) => {
      follow(filePath);
      return readUserFile(filePath);
    },
    writeFile: (filePath: string, content: string) => {
      follow(filePath);
      return writeFile(filePath, content);
    },
  });
}

/** `Cmd+R` : le renderer repart de rien, mais la fenêtre reste, et son `sessionStorage` avec. */
async function reloadedRenderer(): Promise<typeof useIdeaStore> {
  vi.resetModules();
  const { useIdeaStore: fresh } = await import('../ideaStore');
  return fresh;
}

/** Une nouvelle session : une autre fenêtre, qui ne reçoit rien de la précédente. */
async function nextSession(): Promise<typeof useIdeaStore> {
  sessionStorage.clear();
  return reloadedRenderer();
}

beforeEach(() => {
  h.handlers.clear();
  setupFilesystemHandlers();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-idees-')));
  dirA = path.join(root, 'A');
  dirB = path.join(root, 'B');
  fs.mkdirSync(path.join(dirA, '.cliodeck'), { recursive: true });
  fs.mkdirSync(path.join(dirB, '.cliodeck'), { recursive: true });
  ideasA = ideasFileOf(dirA);
  ideasB = ideasFileOf(dirB);
  h.mainCurrent = dirA;
  h.readTimesOut = null;
  writes = [];
  inflightWrites = 0;
  maxInflightWrites = 0;
  afterRead = null;
  holdWrites = null;
  installMain();
  useIdeaStore.setState({
    ideas: [],
    isLoading: false,
    selectedId: null,
    persistence: { kind: 'ready' },
    loadedFor: null,
    saveError: null,
  });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('un ideas.json abîmé est mis de côté, et rien ne se perd', () => {
  it("40 idées tronquées à 60 % : les octets d'origine restent, et la première sauvegarde crée un fichier valide", async () => {
    const whole = ideasFile(Array.from({ length: 40 }, (_, i) => `Idée ${i}`));
    const truncated = whole.slice(0, Math.floor(whole.length * 0.6));
    fs.writeFileSync(ideasA, truncated);

    await store().loadIdeas(dirA);
    expect(titles()).toEqual([]);
    newIdea('Après coup');
    await store().saveIdeas(dirA);

    const backup = theBackup(dirA);
    expect(fs.readFileSync(backup, 'utf8')).toBe(truncated);
    expect(titlesOnDisk(ideasA)).toEqual(['Après coup']);
    expect(store().persistence).toEqual({ kind: 'quarantined', backupPath: backup });
    expect(store().saveError).toBeNull();
  });

  it('un fichier de 0 octet suit le même chemin', async () => {
    fs.writeFileSync(ideasA, '');

    await store().loadIdeas(dirA);

    const backup = theBackup(dirA);
    expect(fs.readFileSync(backup, 'utf8')).toBe('');
    expect(fs.existsSync(ideasA)).toBe(false);
    expect(store().persistence).toEqual({ kind: 'quarantined', backupPath: backup });
  });

  it("du non-UTF-8 est mis de côté sans changer un octet : ce n'est pas une panne de lecture", async () => {
    const latin1 = Buffer.from([0x7b, 0x22, 0xe9, 0x74, 0xe9, 0x22, 0x7d]);
    fs.writeFileSync(ideasA, latin1);

    await store().loadIdeas(dirA);

    const backup = theBackup(dirA);
    expect(fs.readFileSync(backup).equals(latin1)).toBe(true);
    expect(store().persistence).toEqual({ kind: 'quarantined', backupPath: backup });
  });

  it.each([
    ['un JSON scalaire', '42'],
    ['null', 'null'],
    ['un champ ideas qui n’est pas une liste', '{"ideas": {"titre": "Braudel"}}'],
    ['une liste de ce qui n’est pas une idée', '{"ideas": ["Braudel", 12]}'],
    ['un objet d’une autre forme, qui porte des données', '{"notes": [{"titre": "Braudel"}]}'],
    ['un objet d’une autre forme, aux champs tous simples', '{"note": "Relire Braudel"}'],
    ['ideas à null, à côté d’autre chose', '{"ideas": null, "note": "Relire Braudel"}'],
    ['une virgule en trop après une retouche à la main', '{"ideas": [{"id": "a", "title": "Braudel"},]}'],
  ])('%s : forme inattendue, mise de côté', async (_name, content) => {
    fs.writeFileSync(ideasA, content);

    await store().loadIdeas(dirA);

    const backup = theBackup(dirA);
    expect(fs.readFileSync(backup, 'utf8')).toBe(content);
    expect(store().persistence.kind).toBe('quarantined');
    expect(titles()).toEqual([]);
  });

  it('si la mise de côté échoue : rien ne bouge, et rien ne peut plus écrire', async () => {
    fs.writeFileSync(ideasA, '{ tronqué');
    // Le refus du handler, tel qu'il arrive quand le dossier ne se laisse pas modifier.
    (window.electron.fs as { quarantineFile: unknown }).quarantineFile = async () => ({
      success: false,
      error: 'EACCES: permission denied, rename',
    });

    await store().loadIdeas(dirA);
    newIdea('À ne pas écrire');
    await store().saveIdeas(dirA);

    expect(store().persistence.kind).toBe('blocked');
    expect(writes).toEqual([]);
    expect(fs.readFileSync(ideasA, 'utf8')).toBe('{ tronqué');
  });
});

describe('le faux positif : un fichier sain ne se met jamais de côté', () => {
  it('un BOM en tête (éditeur externe, Windows) se charge normalement', async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(ideasFile(['Braudel']))]);
    fs.writeFileSync(ideasA, bytes);

    await store().loadIdeas(dirA);

    expect(titles()).toEqual(['Braudel']);
    expect(store().persistence).toEqual({ kind: 'ready' });
    expect(quarantined(dirA)).toEqual([]);
    expect(fs.readFileSync(ideasA).equals(bytes)).toBe(true);
  });

  it('une écriture en cours par un autre processus : relu une fois terminée, rien ne bouge', async () => {
    const whole = ideasFile(['Braudel', 'Febvre']);
    fs.writeFileSync(ideasA, whole.slice(0, 20));
    let finished = false;
    afterRead = async () => {
      if (finished) return;
      finished = true;
      fs.writeFileSync(ideasA, whole);
    };

    await store().loadIdeas(dirA);

    expect(titles()).toEqual(['Braudel', 'Febvre']);
    expect(store().persistence).toEqual({ kind: 'ready' });
    expect(quarantined(dirA)).toEqual([]);
  });

  it('un tableau nu se charge', async () => {
    fs.writeFileSync(ideasA, JSON.stringify([idea('Braudel')]));

    await store().loadIdeas(dirA);

    expect(titles()).toEqual(['Braudel']);
    expect(store().persistence).toEqual({ kind: 'ready' });
    expect(quarantined(dirA)).toEqual([]);
  });

  it.each([
    ['un objet vide', '{}'],
    ['ideas à null', '{"ideas": null}'],
  ])('%s : une liste vide, comme `data.ideas ?? []` depuis le premier jour', async (_name, content) => {
    fs.writeFileSync(ideasA, content);

    await store().loadIdeas(dirA);

    expect(titles()).toEqual([]);
    expect(store().persistence).toEqual({ kind: 'ready' });
    expect(fs.readFileSync(ideasA, 'utf8')).toBe(content);
  });

  it('un champ de plus, à la racine ou sur une idée : chargé, et celui de l’idée survit à la sauvegarde', async () => {
    const withExtra = { ...idea('Braudel'), couleurFuture: 'ocre' };
    fs.writeFileSync(ideasA, JSON.stringify({ version: 3, ideas: [withExtra] }));

    await store().loadIdeas(dirA);
    await store().saveIdeas(dirA);

    expect(store().persistence).toEqual({ kind: 'ready' });
    expect(quarantined(dirA)).toEqual([]);
    expect(onDisk(ideasA)[0]).toMatchObject({ title: 'Braudel', couleurFuture: 'ocre' });
  });

  it("une idée sans identifiant ni champs : chargée, et sans faire tomber le panneau qui les lit", async () => {
    fs.writeFileSync(
      ideasA,
      JSON.stringify({ ideas: [{ title: 'Sans identifiant' }, { id: 'double', title: 'Un' }, { id: 'double', title: 'Deux' }] })
    );

    await store().loadIdeas(dirA);

    const ideas = store().ideas;
    expect(ideas.map((i) => i.title)).toEqual(['Sans identifiant', 'Un', 'Deux']);
    expect(new Set(ideas.map((i) => i.id)).size).toBe(3);
    expect(ideas.every((i) => i.id.length > 0)).toBe(true);
    // Ce que lisent IdeasPanel et IdeasCanvas sans précaution : aucun de ces accès ne lève.
    for (const i of ideas) {
      expect(i.content.toLowerCase()).toBe('');
      expect(i.tags).toEqual([]);
      expect(i.links).toEqual([]);
      expect(i.origin.type).toBe('manual');
    }
    expect(store().persistence).toEqual({ kind: 'ready' });
    expect(quarantined(dirA)).toEqual([]);
  });

  it('charger ne réécrit rien : un fichier sain et non retouché garde ses octets', async () => {
    const content = `${JSON.stringify({ ideas: [{ title: 'Sans identifiant' }] })}\n`;
    fs.writeFileSync(ideasA, content);

    await store().loadIdeas(dirA);
    await store().flushIdeas();

    expect(writes).toEqual([]);
    expect(fs.readFileSync(ideasA, 'utf8')).toBe(content);
  });
});

describe("les mises de côté s'accumulent sans s'écraser", () => {
  it('répétées dans la même seconde : chacune garde son fichier et ses octets', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-03T10:00:00.000Z') });
    try {
      for (const content of ['{ un', '{ deux', '{ trois']) {
        fs.writeFileSync(ideasA, content);
        await store().loadIdeas(dirA);
      }
    } finally {
      vi.useRealTimers();
    }

    const contents = quarantined(dirA).map((file) => fs.readFileSync(file, 'utf8'));
    expect(contents.sort()).toEqual(['{ deux', '{ trois', '{ un']);
    expect(store().persistence).toMatchObject({ kind: 'quarantined' });
  });
});

describe('la bannière vaut pour la session et pour ce projet', () => {
  async function quarantine(): Promise<string> {
    fs.writeFileSync(ideasA, '{ tronqué');
    await store().loadIdeas(dirA);
    return theBackup(dirA);
  }

  it('un rechargement qui trouve le fichier absent la garde', async () => {
    const backup = await quarantine();

    await store().loadIdeas(dirA);

    expect(store().persistence).toEqual({ kind: 'quarantined', backupPath: backup });
  });

  it('un rechargement après la première sauvegarde la garde aussi, et ne remet rien de côté', async () => {
    const backup = await quarantine();
    newIdea('Après coup');
    await store().saveIdeas(dirA);

    await store().loadIdeas(dirA);

    expect(titles()).toEqual(['Après coup']);
    expect(store().persistence).toEqual({ kind: 'quarantined', backupPath: backup });
    expect(quarantined(dirA)).toEqual([backup]);
  });

  it('la session suivante relit un fichier sain : plus de bannière, et la mise de côté reste', async () => {
    const backup = await quarantine();
    newIdea('Après coup');
    await store().saveIdeas(dirA);

    const fresh = await nextSession();
    await fresh.getState().loadIdeas(dirA);

    expect(fresh.getState().persistence).toEqual({ kind: 'ready' });
    expect(fresh.getState().ideas.map((i) => i.title)).toEqual(['Après coup']);
    expect(fs.readFileSync(backup, 'utf8')).toBe('{ tronqué');
  });

  it("un autre projet ne l'hérite pas", async () => {
    await quarantine();
    mainSwitchesTo(dirB);
    fs.writeFileSync(ideasB, ideasFile(['Idée de B']));

    await store().loadIdeas(dirB);

    expect(store().persistence).toEqual({ kind: 'ready' });
    expect(titles()).toEqual(['Idée de B']);
  });

  it('un aller-retour vers un autre projet la garde : le fichier trouvé au retour ne dit plus rien', async () => {
    const backup = await quarantine();
    mainSwitchesTo(dirB);
    await store().loadIdeas(dirB);
    expect(store().persistence).toEqual({ kind: 'ready' });

    mainSwitchesTo(dirA);
    await store().loadIdeas(dirA);

    expect(store().persistence).toEqual({ kind: 'quarantined', backupPath: backup });
  });

  it('un disque débranché puis revenu la rend aussi : `blocked` la remplace, le temps de la panne', async () => {
    const backup = await quarantine();
    const unplugged = `${dirA}-debranche`;

    fs.renameSync(dirA, unplugged);
    await store().loadIdeas(dirA);
    expect(store().persistence.kind).toBe('blocked');

    fs.renameSync(unplugged, dirA);
    await store().loadIdeas(dirA);
    expect(store().persistence).toEqual({ kind: 'quarantined', backupPath: backup });
  });

  it('`Cmd+R` la garde : la fenêtre est la même, et rien ne la dirait plus', async () => {
    const backup = await quarantine();

    const reloaded = await reloadedRenderer();
    await reloaded.getState().loadIdeas(dirA);

    expect(reloaded.getState().persistence).toEqual({ kind: 'quarantined', backupPath: backup });
  });

  it('sans `sessionStorage` utilisable, le chargement aboutit quand même', async () => {
    const refused = () => {
      throw new Error('QuotaExceededError');
    };
    vi.stubGlobal('sessionStorage', { getItem: refused, setItem: refused });
    try {
      fs.writeFileSync(ideasA, '{ tronqué');
      await store().loadIdeas(dirA);
      expect(store().persistence).toEqual({ kind: 'quarantined', backupPath: theBackup(dirA) });

      // Et la lecture suivante n'en fait pas une panne : la liste reste utilisable.
      await store().loadIdeas(dirA);
      expect(store().persistence).toEqual({ kind: 'ready' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('un fichier revenu pendant la session ne s’écrase pas', () => {
  const forty = Array.from({ length: 40 }, (_, i) => `Idée ${i}`);

  async function quarantine(): Promise<string> {
    const whole = ideasFile(forty);
    fs.writeFileSync(ideasA, whole.slice(0, Math.floor(whole.length * 0.6)));
    await store().loadIdeas(dirA);
    return theBackup(dirA);
  }

  it('réparé puis renommé par l’auteur : ses idées reviennent à côté de la nouvelle, et plus rien à dire', async () => {
    const backup = await quarantine();
    fs.writeFileSync(backup, ideasFile(forty));
    fs.renameSync(backup, ideasA);

    newIdea('Après coup');
    await store().saveIdeas(dirA);

    expect(titlesOnDisk(ideasA)).toEqual([...forty, 'Après coup']);
    expect(titles()).toEqual([...forty, 'Après coup']);
    expect(store().saveError).toBeNull();
    expect(store().persistence).toEqual({ kind: 'ready' });
  });

  it('remis par une synchronisation : la version complète reste, et la mise de côté aussi', async () => {
    const backup = await quarantine();
    const truncated = fs.readFileSync(backup, 'utf8');
    fs.writeFileSync(ideasA, ideasFile(forty));

    newIdea('Après coup');
    await store().saveIdeas(dirA);

    expect(titlesOnDisk(ideasA)).toEqual([...forty, 'Après coup']);
    expect(fs.readFileSync(backup, 'utf8')).toBe(truncated);
    expect(quarantined(dirA)).toEqual([backup]);
    expect(store().persistence).toEqual({ kind: 'quarantined', backupPath: backup });
  });

  it('revenu encore abîmé : mis de côté à son tour, sans toucher au premier, et l’idée s’écrit', async () => {
    const first = await quarantine();
    const firstBytes = fs.readFileSync(first, 'utf8');
    fs.writeFileSync(ideasA, '{ encore tronqué');

    newIdea('Après coup');
    await store().saveIdeas(dirA);

    expect(titlesOnDisk(ideasA)).toEqual(['Après coup']);
    expect(fs.readFileSync(first, 'utf8')).toBe(firstBytes);
    const second = quarantined(dirA).filter((file) => file !== first);
    expect(second).toHaveLength(1);
    expect(fs.readFileSync(second[0], 'utf8')).toBe('{ encore tronqué');
    expect(store().persistence).toEqual({ kind: 'quarantined', backupPath: second[0] });
  });

  it('revenu mais illisible pour l’instant : rien ne s’écrit, ça se dit, et Réessayer le reprend', async () => {
    await quarantine();
    fs.writeFileSync(ideasA, ideasFile(forty));
    h.readTimesOut = ideasA;

    newIdea('Après coup');
    await store().saveIdeas(dirA);

    expect(writes).toEqual([]);
    expect(fs.readFileSync(ideasA, 'utf8')).toBe(ideasFile(forty));
    expect(store().saveError).toContain('ETIMEDOUT');
    expect(titles()).toEqual(['Après coup']);
    expect(store().persistence.kind).toBe('quarantined');
    expect(hasUnwrittenIdeas()).toBe(true);

    h.readTimesOut = null;
    await store().saveIdeas(dirA);

    expect(titlesOnDisk(ideasA)).toEqual([...forty, 'Après coup']);
    expect(store().saveError).toBeNull();
  });

  it('ce qui se tape pendant la relecture part aussi : le maillon écrit l’état du moment où il écrit', async () => {
    await quarantine();
    fs.writeFileSync(ideasA, ideasFile(['Braudel']));
    afterRead = async () => {
      afterRead = null;
      newIdea('Pendant la relecture');
    };

    newIdea('Après coup');
    await store().saveIdeas(dirA);

    expect(titlesOnDisk(ideasA)).toEqual(['Braudel', 'Après coup', 'Pendant la relecture']);
    expect(titles()).toEqual(['Braudel', 'Après coup', 'Pendant la relecture']);
  });

  it('un projet sans fichier à l’ouverture, qui en reçoit un ensuite (synchronisation en retard) : même règle', async () => {
    await store().loadIdeas(dirA);
    fs.writeFileSync(ideasA, ideasFile(['Braudel', 'Febvre']));

    newIdea('Après coup');
    await store().saveIdeas(dirA);

    expect(titlesOnDisk(ideasA)).toEqual(['Braudel', 'Febvre', 'Après coup']);
    expect(store().persistence).toEqual({ kind: 'ready' });
  });

  it('revenu, puis une écriture ratée : Réessayer ne relit pas ce qu’il a déjà repris, et rien ne se double', async () => {
    await quarantine();
    fs.writeFileSync(ideasA, ideasFile(['Braudel']));
    const write = window.electron.fs.writeFile;
    (window.electron.fs as { writeFile: unknown }).writeFile = async () => {
      throw new Error('ENOSPC: no space left on device, write');
    };

    newIdea('Après coup');
    await store().saveIdeas(dirA);

    expect(store().saveError).toContain('ENOSPC');
    expect(titles()).toEqual(['Braudel', 'Après coup']);

    (window.electron.fs as { writeFile: unknown }).writeFile = write;
    await store().saveIdeas(dirA);

    expect(store().saveError).toBeNull();
    expect(titlesOnDisk(ideasA)).toEqual(['Braudel', 'Après coup']);
  });

  it('encore absent à la première écriture, qui rate ; revenu avant Réessayer : il est repris quand même', async () => {
    await quarantine();
    const write = window.electron.fs.writeFile;
    (window.electron.fs as { writeFile: unknown }).writeFile = async () => {
      throw new Error('ENOSPC: no space left on device, write');
    };
    newIdea('Après coup');
    await store().saveIdeas(dirA);
    expect(store().saveError).toContain('ENOSPC');

    fs.writeFileSync(ideasA, ideasFile(['Braudel']));
    (window.electron.fs as { writeFile: unknown }).writeFile = write;
    await store().saveIdeas(dirA);

    expect(titlesOnDisk(ideasA)).toEqual(['Braudel', 'Après coup']);
    expect(store().saveError).toBeNull();
  });

  it('revenu avant un rechargement : celui-ci l’a lu, et la première écriture ne le reprend pas une seconde fois', async () => {
    await store().loadIdeas(dirA);
    fs.writeFileSync(ideasA, ideasFile(['Braudel']));
    await store().loadIdeas(dirA);
    expect(titles()).toEqual(['Braudel']);

    newIdea('Après coup');
    await store().saveIdeas(dirA);

    expect(titlesOnDisk(ideasA)).toEqual(['Braudel', 'Après coup']);
  });

  it('une fois écrit, le fichier est le nôtre : retirer une idée ne la fait pas revenir', async () => {
    await quarantine();
    const removed = newIdea('Retirée');
    newIdea('Gardée');
    await store().saveIdeas(dirA);
    expect(titlesOnDisk(ideasA)).toEqual(['Retirée', 'Gardée']);

    store().removeIdea(removed);
    await store().saveIdeas(dirA);

    expect(titlesOnDisk(ideasA)).toEqual(['Gardée']);
    expect(titles()).toEqual(['Gardée']);
  });

  describe('une écriture qui aboutit après le délai', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    async function writeThatLandsLate(project: string): Promise<() => Promise<void>> {
      let land: () => void = () => undefined;
      holdWrites = new Promise<void>((resolve) => {
        land = resolve;
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const saving = store().saveIdeas(project);
      // Pas avant que l'écriture soit partie : le délai tomberait sur la relecture du vrai disque.
      await vi.waitFor(() => expect(inflightWrites).toBe(1), { timeout: 5000, interval: 50 });
      await vi.advanceTimersByTimeAsync(IDEAS_IO_DEADLINE_MS);
      await saving;
      expect(store().saveError).toBeTruthy();
      vi.useRealTimers();
      return async () => {
        holdWrites = null;
        land();
        await vi.waitFor(() => expect(inflightWrites).toBe(0), { timeout: 5000 });
        // La suite de l'écriture, côté store, passe aux microtâches qui suivent.
        await new Promise((resolve) => setTimeout(resolve, 0));
      };
    }

    it('n’est pas prise pour un fichier revenu : ce qu’on a retiré entre-temps ne revient pas', async () => {
      await quarantine();
      const removed = newIdea('Retirée');
      newIdea('Gardée');
      const landLate = await writeThatLandsLate(dirA);

      await landLate();
      expect(titlesOnDisk(ideasA)).toEqual(['Retirée', 'Gardée']);

      store().removeIdea(removed);
      await store().saveIdeas(dirA);

      expect(titlesOnDisk(ideasA)).toEqual(['Gardée']);
    });

    it('dans A, ne fait pas oublier à B qu’il n’avait pas de fichier', async () => {
      await quarantine();
      newIdea('De A');
      const landLate = await writeThatLandsLate(dirA);

      store().abandonUnwrittenIdeas();
      mainSwitchesTo(dirB);
      await store().loadIdeas(dirB);
      // Validée avant la bascule, une écriture en panne aboutit après : le main ne la refuse plus.
      mainSwitchesTo(dirA);
      await landLate();
      expect(titlesOnDisk(ideasA)).toEqual(['De A']);
      mainSwitchesTo(dirB);

      fs.writeFileSync(ideasB, ideasFile(['Reçue par synchronisation']));

      newIdea('De B');
      await store().saveIdeas(dirB);

      expect(titlesOnDisk(ideasB)).toEqual(['Reçue par synchronisation', 'De B']);
    });
  });
});

describe('une mise de côté qui n’est plus là ne se dit plus', () => {
  async function quarantine(): Promise<string> {
    fs.writeFileSync(ideasA, '{ tronqué');
    await store().loadIdeas(dirA);
    return theBackup(dirA);
  }

  it('réparée et remise à sa place : au rechargement, les idées, sans message sur un chemin qui n’existe plus', async () => {
    const backup = await quarantine();
    fs.writeFileSync(backup, ideasFile(['Braudel', 'Febvre']));
    fs.renameSync(backup, ideasA);

    await store().loadIdeas(dirA);

    expect(titles()).toEqual(['Braudel', 'Febvre']);
    expect(store().persistence).toEqual({ kind: 'ready' });
  });

  it('rangée ailleurs par l’auteur : plus de message non plus, y compris après `Cmd+R`', async () => {
    const backup = await quarantine();
    fs.renameSync(backup, path.join(root, 'rangee-ailleurs.json'));

    await store().loadIdeas(dirA);
    expect(store().persistence).toEqual({ kind: 'ready' });

    const reloaded = await reloadedRenderer();
    await reloaded.getState().loadIdeas(dirA);
    expect(reloaded.getState().persistence).toEqual({ kind: 'ready' });
  });

  it('un dossier qui ne répond plus pendant ce contrôle : bloqué, comme toute lecture sans réponse', async () => {
    await quarantine();
    const exists = window.electron.fs.exists;
    let asked = false;
    (window.electron.fs as { exists: unknown }).exists = (filePath: string) => {
      if (!QUARANTINE.test(path.basename(filePath))) return exists(filePath);
      asked = true;
      return new Promise(() => undefined);
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const loading = store().loadIdeas(dirA);
      // Pas avant : le délai tomberait sur la lecture du vrai disque, et le test passerait pour une autre raison.
      await vi.waitFor(() => expect(asked).toBe(true), { timeout: 5000, interval: 50 });
      await vi.advanceTimersByTimeAsync(IDEAS_IO_DEADLINE_MS);
      await loading;
    } finally {
      vi.useRealTimers();
    }

    expect(store().persistence.kind).toBe('blocked');
  });
});

describe('une lecture impossible : rien ne bouge, rien ne s’écrit, et on peut réessayer', () => {
  it('une erreur d’E/S (fichier OneDrive sans ses données) : bloqué, fichier intact, aucune écriture', async () => {
    const content = ideasFile(['Braudel']);
    fs.writeFileSync(ideasA, content);
    h.readTimesOut = ideasA;

    await store().loadIdeas(dirA);
    newIdea('À ne pas écrire');
    await store().saveIdeas(dirA);
    await store().flushIdeas();

    expect(store().persistence.kind).toBe('blocked');
    expect(writes).toEqual([]);
    expect(quarantined(dirA)).toEqual([]);
    expect(fs.readFileSync(ideasA, 'utf8')).toBe(content);
  });

  it.skipIf(IS_ROOT)('des droits manquants : même chose', async () => {
    const content = ideasFile(['Braudel']);
    fs.writeFileSync(ideasA, content);
    fs.chmodSync(ideasA, 0o000);
    try {
      await store().loadIdeas(dirA);
      newIdea('À ne pas écrire');
      await store().saveIdeas(dirA);

      expect(store().persistence.kind).toBe('blocked');
      expect(writes).toEqual([]);
      expect(quarantined(dirA)).toEqual([]);
    } finally {
      fs.chmodSync(ideasA, 0o644);
    }
    expect(fs.readFileSync(ideasA, 'utf8')).toBe(content);
  });

  it('ce qui n’est pas un fichier ordinaire ne se déplace pas', async () => {
    fs.mkdirSync(ideasA);

    await store().loadIdeas(dirA);

    expect(store().persistence.kind).toBe('blocked');
    expect(fs.statSync(ideasA).isDirectory()).toBe(true);
    expect(quarantined(dirA)).toEqual([]);
  });

  it('un chemin que le main refuse : bloqué, pas confondu avec un fichier absent', async () => {
    fs.writeFileSync(ideasA, ideasFile(['Braudel']));
    mainSwitchesTo(dirB);

    await store().loadIdeas(dirA);

    expect(store().persistence.kind).toBe('blocked');
    expect(titlesOnDisk(ideasA)).toEqual(['Braudel']);
  });

  it('réessayer une fois le dossier revenu suffit : ni redémarrage, ni rien de perdu', async () => {
    fs.writeFileSync(ideasA, ideasFile(['Braudel']));
    h.readTimesOut = ideasA;
    await store().loadIdeas(dirA);
    expect(store().persistence.kind).toBe('blocked');

    h.readTimesOut = null;
    await store().loadIdeas(dirA);

    expect(store().persistence).toEqual({ kind: 'ready' });
    expect(titles()).toEqual(['Braudel']);
    newIdea('Après le retour');
    await store().saveIdeas(dirA);
    expect(titlesOnDisk(ideasA)).toEqual(['Braudel', 'Après le retour']);
  });

  it("un disque débranché rend le fichier « absent » : ce n'est pas une liste vide à écrire au retour", async () => {
    fs.writeFileSync(ideasA, ideasFile(['Braudel', 'Febvre']));
    const elsewhere = path.join(root, 'demonte');
    fs.renameSync(dirA, elsewhere);

    await store().loadIdeas(dirA);
    newIdea('Écrite pendant le débranchement');
    await store().saveIdeas(dirA);
    fs.renameSync(elsewhere, dirA);
    await store().saveIdeas(dirA);

    expect(store().persistence.kind).toBe('blocked');
    expect(titlesOnDisk(ideasA)).toEqual(['Braudel', 'Febvre']);
  });
});

describe('les sauvegardes passent une par une, avec l’état du moment où elles écrivent', () => {
  it('deux saveIdeas sans await : une écriture à la fois, et le fichier final est valide et à jour', async () => {
    fs.writeFileSync(ideasA, ideasFile(['Braudel']));
    await store().loadIdeas(dirA);

    newIdea('Febvre');
    const first = store().saveIdeas(dirA);
    await Promise.resolve();
    newIdea('Bloch');
    const second = store().saveIdeas(dirA);
    await Promise.all([first, second]);

    expect(maxInflightWrites).toBe(1);
    expect(titlesOnDisk(ideasA)).toEqual(titles());
    expect(titles()).toEqual(['Braudel', 'Febvre', 'Bloch']);
  });

  it("le maillon en attente écrit l'état du moment où il écrit, pas celui de son appel", async () => {
    fs.writeFileSync(ideasA, ideasFile(['Braudel']));
    await store().loadIdeas(dirA);
    let release: () => void = () => undefined;
    holdWrites = new Promise<void>((resolve) => {
      release = resolve;
    });

    newIdea('Lefebvre');
    const first = store().saveIdeas(dirA);
    await vi.waitFor(() => expect(writes).toHaveLength(1), { timeout: 5000 });
    newIdea('Febvre');
    const second = store().saveIdeas(dirA);
    // Modifiée après l'appel : la sauvegarde qui attend son tour la voit.
    newIdea('Bloch');
    release();
    await Promise.all([first, second]);

    expect(titlesOnDisk(ideasA)).toEqual(['Braudel', 'Lefebvre', 'Febvre', 'Bloch']);
  });

  it('cent demandes pendant une écriture : une seule attend, et le dernier état est sur le disque', async () => {
    fs.writeFileSync(ideasA, ideasFile(['Braudel']));
    await store().loadIdeas(dirA);
    const [{ id }] = store().ideas;
    let release: () => void = () => undefined;
    holdWrites = new Promise<void>((resolve) => {
      release = resolve;
    });

    const saves: Array<Promise<void>> = [];
    for (let x = 0; x < 100; x++) {
      store().updateIdea(id, { position: { x, y: 0 } });
      saves.push(store().saveIdeas(dirA));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(writes).toHaveLength(1);

    release();
    await Promise.all(saves);

    expect(writes).toHaveLength(2);
    expect(maxInflightWrites).toBe(1);
    expect(onDisk(ideasA)[0].position).toEqual({ x: 99, y: 0 });
  });

  it('une écriture ratée se dit, garde le texte à l’écran, et la suivante efface le message', async () => {
    fs.writeFileSync(ideasA, ideasFile(['Braudel']));
    await store().loadIdeas(dirA);
    const write = window.electron.fs.writeFile;
    (window.electron.fs as { writeFile: unknown }).writeFile = async () => {
      throw new Error('ENOSPC: no space left on device, write');
    };

    newIdea('Febvre');
    await store().saveIdeas(dirA);

    expect(store().saveError).toContain('ENOSPC');
    expect(titles()).toEqual(['Braudel', 'Febvre']);
    expect(titlesOnDisk(ideasA)).toEqual(['Braudel']);

    (window.electron.fs as { writeFile: unknown }).writeFile = write;
    await store().saveIdeas(dirA);

    expect(store().saveError).toBeNull();
    expect(titlesOnDisk(ideasA)).toEqual(['Braudel', 'Febvre']);
  });

  it('rien de neuf : un blur ou un clic sur une carte n’écrit rien, donc n’échoue pas', async () => {
    fs.writeFileSync(ideasA, ideasFile(['Braudel']));
    await store().loadIdeas(dirA);
    (window.electron.fs as { writeFile: unknown }).writeFile = async () => {
      throw new Error('EACCES: permission denied, write');
    };

    await store().saveIdeas(dirA);

    expect(store().saveError).toBeNull();
  });

  it('une écriture ratée, puis l’auteur défait ce qui ne s’écrivait pas : plus rien à signaler', async () => {
    fs.writeFileSync(ideasA, ideasFile(['Braudel']));
    await store().loadIdeas(dirA);
    (window.electron.fs as { writeFile: unknown }).writeFile = async () => {
      throw new Error('ENOSPC: no space left on device, write');
    };
    const id = newIdea('Febvre');
    await store().saveIdeas(dirA);
    expect(store().saveError).toContain('ENOSPC');

    store().removeIdea(id);
    await store().flushIdeas();

    expect(store().saveError).toBeNull();
    expect(hasUnwrittenIdeas()).toBe(false);
  });

  it('une liste abandonnée : plus rien à écrire ni à signaler', async () => {
    fs.writeFileSync(ideasA, ideasFile(['Braudel']));
    await store().loadIdeas(dirA);
    (window.electron.fs as { writeFile: unknown }).writeFile = async () => {
      throw new Error('ENOSPC: no space left on device, write');
    };
    newIdea('Febvre');
    await store().saveIdeas(dirA);

    store().abandonUnwrittenIdeas();

    expect(store().saveError).toBeNull();
    expect(hasUnwrittenIdeas()).toBe(false);
  });

  it('une liste que le disque n’a pas reçue survit à un rechargement du panneau', async () => {
    fs.writeFileSync(ideasA, ideasFile(['Braudel']));
    await store().loadIdeas(dirA);
    const write = window.electron.fs.writeFile;
    (window.electron.fs as { writeFile: unknown }).writeFile = async () => {
      throw new Error('ENOSPC: no space left on device, write');
    };
    newIdea('Febvre');
    await store().saveIdeas(dirA);

    await store().loadIdeas(dirA);

    expect(titles()).toEqual(['Braudel', 'Febvre']);
    expect(store().saveError).toContain('ENOSPC');

    (window.electron.fs as { writeFile: unknown }).writeFile = write;
    await store().loadIdeas(dirA);
    expect(titlesOnDisk(ideasA)).toEqual(['Braudel', 'Febvre']);
    expect(store().saveError).toBeNull();
  });
});

describe('la file et le chargement', () => {
  it('une sauvegarde avant tout chargement ne peut pas écraser le fichier', async () => {
    const content = ideasFile(Array.from({ length: 40 }, (_, i) => `Idée ${i}`));
    fs.writeFileSync(ideasA, content);

    newIdea('Trop tôt');
    await store().saveIdeas(dirA);

    expect(writes).toEqual([]);
    expect(fs.readFileSync(ideasA, 'utf8')).toBe(content);
  });

  it('une sauvegarde demandée pendant le chargement passe après lui, avec la liste chargée', async () => {
    fs.writeFileSync(ideasA, ideasFile(['Braudel', 'Febvre']));

    const loading = store().loadIdeas(dirA);
    const saving = store().saveIdeas(dirA);
    await Promise.all([loading, saving]);

    expect(titlesOnDisk(ideasA)).toEqual(['Braudel', 'Febvre']);
    expect(titles()).toEqual(['Braudel', 'Febvre']);
  });

  it('un rechargement passe après la sauvegarde en cours : il lit ce qu’elle écrit', async () => {
    fs.writeFileSync(ideasA, ideasFile(['Braudel', 'Febvre']));
    await store().loadIdeas(dirA);
    let release: () => void = () => undefined;
    holdWrites = new Promise<void>((resolve) => {
      release = resolve;
    });

    store().removeIdea(store().ideas[1].id);
    const saving = store().saveIdeas(dirA);
    await vi.waitFor(() => expect(writes).toHaveLength(1), { timeout: 5000 });
    // Quitter le Brainstorm et y revenir : le panneau se remonte et recharge.
    const reloading = store().loadIdeas(dirA);
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    await Promise.all([saving, reloading]);

    expect(titles()).toEqual(['Braudel']);
    expect(titlesOnDisk(ideasA)).toEqual(['Braudel']);
  });

  it('un rechargement écrit d’abord ce qui ne l’est pas : le panneau démonté sans blur ne perd rien', async () => {
    fs.writeFileSync(ideasA, ideasFile(['Braudel']));
    await store().loadIdeas(dirA);

    store().updateIdea(store().ideas[0].id, { content: 'Tapé, jamais quitté le champ.' });
    await store().loadIdeas(dirA);

    expect(store().ideas[0].content).toBe('Tapé, jamais quitté le champ.');
    expect(onDisk(ideasA)[0].content).toBe('Tapé, jamais quitté le champ.');
  });
});

describe('un disque sans réponse ne retient pas la file', () => {
  const never = () => new Promise<never>(() => undefined);

  afterEach(() => {
    vi.useRealTimers();
  });

  it('une lecture sans réponse dans A : A est bloqué après le délai, et B se charge', async () => {
    fs.writeFileSync(ideasB, ideasFile(['Idée de B']));
    const read = window.electron.fs.readUserFile;
    let reading = false;
    (window.electron.fs as { readUserFile: unknown }).readUserFile = (filePath: string) => {
      if (filePath !== ideasA) return read(filePath);
      reading = true;
      return never();
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const loadingA = store().loadIdeas(dirA);
    await vi.advanceTimersByTimeAsync(0);
    expect(reading).toBe(true);
    await vi.advanceTimersByTimeAsync(IDEAS_IO_DEADLINE_MS);
    await loadingA;

    expect(store().persistence.kind).toBe('blocked');
    expect(store().loadedFor).toBe(dirA);
    expect(store().isLoading).toBe(false);
    expect(fs.existsSync(ideasA)).toBe(false);

    vi.useRealTimers();
    mainSwitchesTo(dirB);
    await store().loadIdeas(dirB);
    expect(titles()).toEqual(['Idée de B']);
  });

  it('un dossier de projet qui ne répond plus : bloqué après le délai, sans liste vide à écrire', async () => {
    let asked = false;
    (window.electron.fs as { exists: unknown }).exists = () => {
      asked = true;
      return never();
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const loading = store().loadIdeas(dirA);
    // La vraie lecture rend « absent » sur le vrai disque, hors de l'horloge simulée.
    await vi.waitFor(() => expect(asked).toBe(true), { timeout: 5000, interval: 20 });
    await vi.advanceTimersByTimeAsync(IDEAS_IO_DEADLINE_MS);
    await loading;

    expect(store().persistence.kind).toBe('blocked');
    expect(store().isLoading).toBe(false);
  });

  it('une écriture sans réponse : elle se dit après le délai, et la file repart', async () => {
    fs.writeFileSync(ideasA, ideasFile(['Braudel']));
    await store().loadIdeas(dirA);
    const write = window.electron.fs.writeFile;
    (window.electron.fs as { writeFile: unknown }).writeFile = never;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    newIdea('Febvre');
    const saving = store().saveIdeas(dirA);
    await vi.advanceTimersByTimeAsync(IDEAS_IO_DEADLINE_MS);
    await saving;

    expect(store().saveError).toBeTruthy();
    expect(hasUnwrittenIdeas()).toBe(true);

    vi.useRealTimers();
    (window.electron.fs as { writeFile: unknown }).writeFile = write;
    await store().saveIdeas(dirA);
    expect(store().saveError).toBeNull();
    expect(titlesOnDisk(ideasA)).toEqual(['Braudel', 'Febvre']);
  });

  it('une mise de côté qui aboutit après le délai n’est pas oubliée', async () => {
    fs.writeFileSync(ideasA, '{ tronqué');
    const quarantineFile = window.electron.fs.quarantineFile;
    let moving: Promise<unknown> | null = null;
    let answer: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    (window.electron.fs as { quarantineFile: unknown }).quarantineFile = (filePath: string) => {
      moving = answered.then(() => quarantineFile(filePath));
      return moving;
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const loading = store().loadIdeas(dirA);
    // `waitFor` fait avancer l'horloge simulée : la relecture a lieu, sur le vrai disque.
    await vi.waitFor(() => expect(moving).not.toBeNull(), { timeout: 5000, interval: 50 });
    await vi.advanceTimersByTimeAsync(IDEAS_IO_DEADLINE_MS);
    await loading;
    expect(store().persistence.kind).toBe('blocked');
    vi.useRealTimers();

    answer();
    await moving;
    await store().loadIdeas(dirA);

    expect(store().persistence).toEqual({ kind: 'quarantined', backupPath: theBackup(dirA) });
  });
});

describe('une bascule de projet ne croise jamais deux listes', () => {
  beforeEach(() => {
    fs.writeFileSync(ideasA, ideasFile(['Idée de A']));
    fs.writeFileSync(ideasB, ideasFile(['Idée de B']));
  });

  it('une sauvegarde pour B avant que B soit chargé ne part pas avec la liste de A', async () => {
    await store().loadIdeas(dirA);
    mainSwitchesTo(dirB);

    await store().saveIdeas(dirB);

    expect(titlesOnDisk(ideasB)).toEqual(['Idée de B']);
    expect(writes).toEqual([]);
  });

  it('une sauvegarde tardive pour A après le chargement de B ne part pas avec la liste de B', async () => {
    await store().loadIdeas(dirA);
    mainSwitchesTo(dirB);
    await store().loadIdeas(dirB);

    // Le blur d'un champ dont la fermeture voit encore A.
    await store().saveIdeas(dirA);

    expect(titlesOnDisk(ideasA)).toEqual(['Idée de A']);
    expect(titlesOnDisk(ideasB)).toEqual(['Idée de B']);
    expect(writes).toEqual([]);
  });

  it('pendant une écriture de A : ce qui attend dans la file finit dans A, et B reçoit sa liste', async () => {
    await store().loadIdeas(dirA);
    let release: () => void = () => undefined;
    holdWrites = new Promise<void>((resolve) => {
      release = resolve;
    });

    newIdea('Febvre');
    const inFlight = store().saveIdeas(dirA);
    await vi.waitFor(() => expect(writes).toHaveLength(1), { timeout: 5000 });
    newIdea('Bloch');
    const waiting = store().saveIdeas(dirA);

    // L'ordre de `loadProject` : la file de A se vide avant que le main bascule.
    const flushed = store().flushIdeas();
    release();
    await Promise.all([inFlight, waiting, flushed]);
    mainSwitchesTo(dirB);
    await store().loadIdeas(dirB);
    newIdea('Idée de B, la seconde');
    await store().saveIdeas(dirB);

    expect(titlesOnDisk(ideasA)).toEqual(['Idée de A', 'Febvre', 'Bloch']);
    expect(titlesOnDisk(ideasB)).toEqual(['Idée de B', 'Idée de B, la seconde']);
  });

  it('une sauvegarde de B demandée pendant qu’une sauvegarde de A attend ne s’y joint pas : B s’écrit', async () => {
    await store().loadIdeas(dirA);
    mainFollowsRequests();
    let release: () => void = () => undefined;
    holdWrites = new Promise<void>((resolve) => {
      release = resolve;
    });
    newIdea('Febvre');
    const inFlight = store().saveIdeas(dirA);
    await vi.waitFor(() => expect(writes).toHaveLength(1), { timeout: 5000 });
    newIdea('Bloch');
    const waiting = store().saveIdeas(dirA);

    // Une idée arrive dès que B est chargé, avant le tour de sa sauvegarde.
    const stop = useIdeaStore.subscribe((state, previous) => {
      if (state.loadedFor === dirB && previous.loadedFor !== dirB) newIdea('Idée de B, la seconde');
    });
    const loadingB = store().loadIdeas(dirB);
    const savingB = store().saveIdeas(dirB);
    release();
    await Promise.all([inFlight, waiting, loadingB, savingB]);
    stop();

    expect(titlesOnDisk(ideasA)).toEqual(['Idée de A', 'Febvre', 'Bloch']);
    expect(titlesOnDisk(ideasB)).toEqual(['Idée de B', 'Idée de B, la seconde']);
  });

  it('un chargement dépassé avant son tour ne lit rien', async () => {
    await store().loadIdeas(dirA);
    mainFollowsRequests();
    let release: () => void = () => undefined;
    holdWrites = new Promise<void>((resolve) => {
      release = resolve;
    });
    newIdea('Febvre');
    const inFlight = store().saveIdeas(dirA);
    await vi.waitFor(() => expect(writes).toHaveLength(1), { timeout: 5000 });

    const reads: string[] = [];
    const read = window.electron.fs.readUserFile;
    (window.electron.fs as { readUserFile: unknown }).readUserFile = (filePath: string) => {
      reads.push(filePath);
      return read(filePath);
    };
    const reloadA = store().loadIdeas(dirA);
    const loadingB = store().loadIdeas(dirB);
    release();
    await Promise.all([inFlight, reloadA, loadingB]);

    expect(reads).toEqual([ideasB]);
  });

  it('un chargement dépassé pendant sa lecture ne dit pas que tout est chargé', async () => {
    mainFollowsRequests();
    const read = window.electron.fs.readUserFile;
    let reading: string | null = null;
    const held = new Map<string, () => void>();
    (window.electron.fs as { readUserFile: unknown }).readUserFile = async (filePath: string) => {
      reading = filePath;
      await new Promise<void>((resolve) => {
        held.set(filePath, resolve);
      });
      return read(filePath);
    };

    const loadingA = store().loadIdeas(dirA);
    await vi.waitFor(() => expect(reading).toBe(ideasA), { timeout: 5000 });
    const loadingB = store().loadIdeas(dirB);
    held.get(ideasA)?.();
    await loadingA;

    expect(store().isLoading).toBe(true);

    await vi.waitFor(() => expect(reading).toBe(ideasB), { timeout: 5000 });
    held.get(ideasB)?.();
    await loadingB;
    expect(store().isLoading).toBe(false);
    expect(titles()).toEqual(['Idée de B']);
  });

  it('un chargement de B demandé pendant celui de A : la liste de A ne reste pas, ni ne part dans B', async () => {
    let held = false;
    afterRead = async () => {
      if (held) return;
      held = true;
      await new Promise((resolve) => setTimeout(resolve, 30));
    };

    const loadingA = store().loadIdeas(dirA);
    mainSwitchesTo(dirB);
    const loadingB = store().loadIdeas(dirB);
    const savingB = store().saveIdeas(dirB);
    await Promise.all([loadingA, loadingB, savingB]);

    expect(store().loadedFor).toBe(dirB);
    expect(titles()).toEqual(['Idée de B']);
    expect(titlesOnDisk(ideasA)).toEqual(['Idée de A']);
    expect(titlesOnDisk(ideasB)).toEqual(['Idée de B']);
    expect(store().isLoading).toBe(false);
  });
});

describe('la remise à zéro du projet rend caduc un chargement en vol (L03-5)', () => {
  /** Ce que fait `projectStore` : la demande part au main, puis l'écran passe au projet rendu. */
  function screenSwitchesTo(dir: string | null, { mainToo = true } = {}): void {
    projectLifecycle.beginTransition();
    if (mainToo) h.mainCurrent = dir;
    projectLifecycle.enter(dir);
  }

  beforeEach(() => {
    projectLifecycle.enter(dirA);
    fs.writeFileSync(ideasA, ideasFile(['Idée de A']));
  });

  it('Brainstorm fermé dans B : la réponse de A ne pose ni sa liste ni son projet', async () => {
    let release: () => void = () => undefined;
    let readDone = false;
    afterRead = () =>
      new Promise<void>((resolve) => {
        readDone = true;
        release = resolve;
      });

    const loadingA = store().loadIdeas(dirA);
    await vi.waitFor(() => expect(readDone).toBe(true), { timeout: 5000 });
    screenSwitchesTo(dirB);
    release();
    await loadingA;

    expect(store().loadedFor).toBeNull();
    expect(titles()).toEqual([]);
    expect(store().isLoading).toBe(false);
    expect(hasUnwrittenIdeas()).toBe(false);
  });

  it('un chargement de A qui attend son tour derrière une écriture ne lit plus rien', async () => {
    await store().loadIdeas(dirA);
    let release: () => void = () => undefined;
    holdWrites = new Promise<void>((resolve) => {
      release = resolve;
    });
    newIdea('Febvre');
    const writing = store().saveIdeas(dirA);
    await vi.waitFor(() => expect(writes).toHaveLength(1), { timeout: 5000 });
    const reads: string[] = [];
    const read = window.electron.fs.readUserFile;
    (window.electron.fs as { readUserFile: unknown }).readUserFile = (filePath: string) => {
      reads.push(filePath);
      return read(filePath);
    };

    const reloading = store().loadIdeas(dirA);
    store().abandonUnwrittenIdeas();
    // L'écriture de A est déjà partie au main, qui la sert avant de basculer.
    screenSwitchesTo(dirB, { mainToo: false });
    release();
    await Promise.all([writing, reloading]);
    mainSwitchesTo(dirB);

    expect(reads).toEqual([]);
    expect(store().loadedFor).toBeNull();
    expect(titles()).toEqual([]);
    expect(titlesOnDisk(ideasA)).toEqual(['Idée de A', 'Febvre']);
  });
});

describe('la disposition automatique du Tableau n’est pas une modification de l’auteur', () => {
  const placed = new Map([['idee-Braudel', { x: 40, y: 40 }]]);

  beforeEach(async () => {
    fs.writeFileSync(ideasA, ideasFile(['Braudel']));
    await store().loadIdeas(dirA);
  });

  it('elle place les cartes sans rien écrire, sans dater l’idée et sans rien laisser à écrire', async () => {
    const { updatedAt } = store().ideas[0];

    store().arrangeIdeas(placed);

    expect(store().ideas[0].position).toEqual({ x: 40, y: 40 });
    expect(store().ideas[0].updatedAt).toBe(updatedAt);
    expect(hasUnwrittenIdeas()).toBe(false);
    await store().flushIdeas();
    expect(writes).toEqual([]);
  });

  it('elle s’écrit avec la première vraie modification', async () => {
    store().arrangeIdeas(placed);

    newIdea('Febvre');
    await store().saveIdeas(dirA);

    expect(onDisk(ideasA)[0].position).toEqual({ x: 40, y: 40 });
  });

  it('elle ne fait pas oublier une modification que le disque attend encore', async () => {
    newIdea('Febvre');

    store().arrangeIdeas(placed);

    expect(hasUnwrittenIdeas()).toBe(true);
  });
});

describe("flushIdeas : ce que ni Cmd+Q ni une bascule n'écrivaient", () => {
  it('écrit une frappe dont aucun blur n’est parti', async () => {
    fs.writeFileSync(ideasA, ideasFile(['Braudel']));
    await store().loadIdeas(dirA);

    store().updateIdea(store().ideas[0].id, { content: 'Tapé juste avant de quitter.' });
    await store().flushIdeas();

    expect(onDisk(ideasA)[0].content).toBe('Tapé juste avant de quitter.');
  });

  it('attend ce qui est encore dans la file', async () => {
    fs.writeFileSync(ideasA, ideasFile(['Braudel']));
    await store().loadIdeas(dirA);
    let release: () => void = () => undefined;
    holdWrites = new Promise<void>((resolve) => {
      release = resolve;
    });

    newIdea('Febvre');
    void store().saveIdeas(dirA);
    await vi.waitFor(() => expect(writes).toHaveLength(1), { timeout: 5000 });
    newIdea('Bloch');
    void store().saveIdeas(dirA);

    let flushed = false;
    const flushing = store().flushIdeas().then(() => {
      flushed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(flushed).toBe(false);
    release();
    await flushing;

    expect(titlesOnDisk(ideasA)).toEqual(['Braudel', 'Febvre', 'Bloch']);
  });

  it("n'écrit rien quand tout est déjà sur le disque", async () => {
    fs.writeFileSync(ideasA, ideasFile(['Braudel']));
    await store().loadIdeas(dirA);

    await store().flushIdeas();

    expect(writes).toEqual([]);
  });

  it("n'écrit pas d'ideas.json neuf après une mise de côté sans aucune modification", async () => {
    fs.writeFileSync(ideasA, '{ tronqué');
    await store().loadIdeas(dirA);

    await store().flushIdeas();

    expect(fs.existsSync(ideasA)).toBe(false);
    expect(writes).toEqual([]);
  });
});
