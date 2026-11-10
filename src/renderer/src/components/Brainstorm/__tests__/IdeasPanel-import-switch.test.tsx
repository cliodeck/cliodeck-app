// @vitest-environment jsdom
/**
 * « Importer depuis le vault Obsidian » pendant une bascule de projet (S16-1-18, L03-5).
 *
 * L'import attend le main, qui lit jusqu'à 200 notes, puis ajoute les notes à la liste et
 * l'écrit. Il ajoutait les notes du vault de A à la liste de B, et le filet de sortie les écrivait.
 * La comparaison des chemins qui l'a remplacé laissait passer un aller-retour A → B → A pendant
 * l'attente : les notes rejoignaient une liste rechargée depuis, et le dédoublonnage lisait celle
 * du clic.
 *
 * Vrai panneau, vrai store, vrai registre, VRAIS handlers `fs:*` sur un vrai disque. Le projet
 * change comme le fait `projectStore` : `beginTransition`, puis `enter` et le projet à l'écran.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { BrainstormPanel } from '../BrainstormPanel';
import { IdeasPanel } from '../IdeasPanel';
import { useIdeaStore, type Idea } from '../../../stores/ideaStore';
import { useNotificationStore } from '../../../stores/notificationStore';
import { useProjectStore } from '../../../stores/projectStore';
import { projectLifecycle } from '../../../lifecycle/projectLifecycle';

// Vrai disque et plusieurs allers-retours par test : à 24 `yes` sur 14 cœurs, l'un d'eux dépassait les 5 s par défaut.
vi.setConfig({ testTimeout: 30_000 });

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  mainCurrent: null as string | null,
}));

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
vi.mock('../../../../../main/services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => h.mainCurrent },
}));
vi.mock('../../../../../main/services/config-manager.js', () => ({
  configManager: { get: () => undefined, set: () => undefined },
}));
vi.mock('../../Chat/AssistantChat', () => ({ AssistantChat: () => <div data-testid="chat" /> }));
vi.mock('react-force-graph-2d', () => ({ default: () => null }));

const { setupFilesystemHandlers } = await import('../../../../../main/ipc/handlers/filesystem-handlers');

const NOTE = 'NOTE-DU-VAULT-DE-A';

let root: string;
let dirA: string;
let dirB: string;
let ideasA: string;
let ideasB: string;
/** Chaque écriture demandée au main. */
let writes: string[];
let importAsIdeas: ReturnType<typeof vi.fn>;
let answerImport: () => void;

const store = () => useIdeaStore.getState();
const titles = () => store().ideas.map((idea) => idea.title);

const idea = (title: string, origin: Idea['origin'] = { type: 'manual' }): Idea => ({
  id: `idee-${title}`,
  title,
  content: '',
  tags: [],
  links: [],
  origin,
  createdAt: '2026-05-06T10:00:00.000Z',
  updatedAt: '2026-05-06T10:00:00.000Z',
});

const ideasFile = (...titles: string[]) => JSON.stringify({ ideas: titles.map((title) => idea(title)) }, null, 2);

function ipc(channel: string, ...args: unknown[]): unknown {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`canal non enregistré : ${channel}`);
  return handler({}, ...args);
}

/** Ce que fait `projectStore` : la demande part au main, puis l'écran passe au projet rendu. */
function showProject(dir: string): void {
  act(() => {
    projectLifecycle.beginTransition();
    h.mainCurrent = dir;
    projectLifecycle.enter(dir);
    useProjectStore.setState({ currentProject: { path: dir } as never });
  });
}

const settled = () =>
  act(async () => {
    await vi.waitFor(() => expect(store().isLoading).toBe(false), { timeout: 5000, interval: 5 });
  });

/** Le vault répond, et la suite de l'import passe aux microtâches qui suivent sa réponse. */
const vaultAnswers = () =>
  act(async () => {
    answerImport();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function importStartedInA(): Promise<void> {
  showProject(dirA);
  render(<BrainstormPanel />);
  await settled();
  await userEvent.click(screen.getByRole('tab', { name: 'ideas.tabIdeas' }));
  await userEvent.click(screen.getByTitle('ideas.importObsidian'));
  expect(importAsIdeas).toHaveBeenCalledTimes(1);
}

beforeEach(() => {
  h.handlers.clear();
  setupFilesystemHandlers();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-import-bascule-')));
  dirA = path.join(root, 'A');
  dirB = path.join(root, 'B');
  fs.mkdirSync(path.join(dirA, '.cliodeck'), { recursive: true });
  fs.mkdirSync(path.join(dirB, '.cliodeck'), { recursive: true });
  ideasA = path.join(dirA, '.cliodeck', 'ideas.json');
  ideasB = path.join(dirB, '.cliodeck', 'ideas.json');
  fs.writeFileSync(ideasA, ideasFile('Idée de A'));
  fs.writeFileSync(ideasB, ideasFile('Idée de B'));
  writes = [];
  answerImport = () => undefined;
  importAsIdeas = vi.fn(
    () =>
      new Promise((resolve) => {
        answerImport = () =>
          resolve({
            success: true,
            ideas: [{ title: NOTE, content: 'Lu dans le vault de A.', tags: [], wikilinks: [], notePath: 'note.md' }],
          });
      })
  );
  (window as unknown as { electron: unknown }).electron = {
    fs: {
      exists: (p: string) => ipc('fs:exists', p),
      readUserFile: (p: string) => ipc('fs:read-user-file', p),
      writeFile: (p: string, content: string, options?: unknown) => {
        writes.push(p);
        return ipc('fs:write-file', p, content, options);
      },
      quarantineFile: (p: string) => ipc('fs:quarantine-file', p),
    },
    fusion: {
      hints: { read: async () => ({ success: true, hints: { present: false, raw: '', normalized: '', sourcePath: '' } }) },
      recipes: { list: async () => ({ success: true, builtin: [], user: [] }) },
      vault: { status: async () => ({ success: true, indexed: false, dbPath: '' }), importAsIdeas },
    },
    config: { get: async () => undefined, set: async () => undefined },
  };
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
  cleanup();
  useProjectStore.setState({ currentProject: null, loadState: { kind: 'idle' } });
  useNotificationStore.getState().dismissAll();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('une bascule pendant l’import', () => {
  it('A → B : aucune écriture dans A, et la liste de B reste la sienne, à l’écran comme sur son disque', async () => {
    const aBefore = fs.readFileSync(ideasA);
    const bBefore = fs.readFileSync(ideasB);
    await importStartedInA();

    showProject(dirB);
    await settled();
    expect(await screen.findByText('Idée de B')).toBeInTheDocument();
    await vaultAnswers();
    await store().flushIdeas();

    expect(titles()).toEqual(['Idée de B']);
    expect(screen.queryByText(NOTE)).toBeNull();
    expect(writes).toEqual([]);
    expect(fs.readFileSync(ideasA).equals(aBefore)).toBe(true);
    expect(fs.readFileSync(ideasB).equals(bBefore)).toBe(true);
  });

  it('A → B → A : les notes ne rejoignent pas la liste rechargée de A, ni son fichier', async () => {
    const aBefore = fs.readFileSync(ideasA);
    await importStartedInA();

    showProject(dirB);
    await settled();
    showProject(dirA);
    await settled();
    expect(await screen.findByText('Idée de A')).toBeInTheDocument();
    await vaultAnswers();
    await store().flushIdeas();

    expect(titles()).toEqual(['Idée de A']);
    expect(writes).toEqual([]);
    expect(fs.readFileSync(ideasA).equals(aBefore)).toBe(true);
  });

  it('un changement de projet déjà en cours au clic : rien n’est demandé au vault, rien n’est ajouté', async () => {
    showProject(dirA);
    await act(async () => {
      await store().loadIdeas(dirA);
    });
    render(<IdeasPanel />);
    act(() => {
      projectLifecycle.beginTransition();
    });

    await userEvent.click(screen.getByTitle('ideas.importObsidian'));
    await vaultAnswers();

    expect(importAsIdeas).not.toHaveBeenCalled();
    expect(titles()).toEqual(['Idée de A']);
    expect(writes).toEqual([]);
  });
});

describe('sans bascule', () => {
  it('les notes arrivent et s’écrivent dans A', async () => {
    await importStartedInA();

    await vaultAnswers();
    await store().flushIdeas();

    expect(titles()).toEqual(['Idée de A', NOTE]);
    expect(fs.readFileSync(ideasA, 'utf8')).toContain(NOTE);
  });

  it('une note déjà importée pendant l’attente n’est pas ajoutée une seconde fois', async () => {
    await importStartedInA();
    act(() => {
      store().addIdea({ title: NOTE, content: '', tags: [], links: [], origin: { type: 'obsidian', notePath: 'note.md' } });
    });

    await vaultAnswers();
    await store().flushIdeas();

    expect(titles()).toEqual(['Idée de A', NOTE]);
  });

  it('deux notes homonymes de deux dossiers du vault, dans un même import, entrent toutes les deux', async () => {
    // Le titre d'une note importée est son nom de fichier : `Archives/Index.md` et `Lectures/Index.md`
    // portent le même. Le dédoublonnage écarte ce que la liste avait déjà avant cet import, pas une
    // note que ce même import vient d'ajouter.
    importAsIdeas.mockImplementation(
      () =>
        new Promise((resolve) => {
          answerImport = () =>
            resolve({
              success: true,
              ideas: [
                { title: 'Index', content: 'Index du dossier Archives.', tags: [], wikilinks: [], notePath: 'Archives/Index.md' },
                { title: 'Index', content: 'Index du dossier Lectures.', tags: [], wikilinks: [], notePath: 'Lectures/Index.md' },
              ],
            });
        })
    );
    await importStartedInA();

    await vaultAnswers();
    await store().flushIdeas();

    expect(store().ideas.map((i) => [i.title, i.content])).toEqual([
      ['Idée de A', ''],
      ['Index', 'Index du dossier Archives.'],
      ['Index', 'Index du dossier Lectures.'],
    ]);
    const onDisk = JSON.parse(fs.readFileSync(ideasA, 'utf8')) as { ideas: Idea[] };
    expect(onDisk.ideas.map((i) => i.origin)).toEqual([
      { type: 'manual' },
      { type: 'obsidian', notePath: 'Archives/Index.md' },
      { type: 'obsidian', notePath: 'Lectures/Index.md' },
    ]);
  });

  it('la liste du projet n’est pas chargée : rien n’est ajouté, et l’auteur le sait', async () => {
    const aBefore = fs.readFileSync(ideasA);
    showProject(dirA);
    render(<IdeasPanel />);

    await userEvent.click(screen.getByTitle('ideas.importObsidian'));
    await vaultAnswers();

    expect(titles()).toEqual([]);
    expect(writes).toEqual([]);
    expect(fs.readFileSync(ideasA).equals(aBefore)).toBe(true);
    const notice = useNotificationStore.getState().notifications.find((n) => n.title === 'ideas.importFailed');
    expect(notice?.message).toBe('ideas.importNotLoaded');
  });
});
