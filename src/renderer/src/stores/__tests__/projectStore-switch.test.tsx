// @vitest-environment jsdom
/**
 * Ouvrir un projet ne réécrit jamais le document qu'il contient.
 *
 * Le repli de l'ouverture prenait toute erreur de lecture pour un fichier absent, et
 * écrivait « # Nom » par-dessus un document présent (le piège signalé dès la PR #42).
 * Un fichier en Latin-1 s'ouvrait avec ses accents en U+FFFD, et l'autosave les rendait
 * définitifs. Ici tout est réel jusqu'au disque : les VRAIS handlers `editor:*` et
 * `fs:write-file`, le vrai éditeur CM6, le vrai autosave. Seuls le projet courant du main
 * et ses services sont simulés.
 */
import { createElement, type FC } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, act, screen } from '@testing-library/react';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { EditorSelection, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { DEFAULT_BOOK_SETTINGS } from '@backend/types/book';

import { NotAProjectError, useProjectStore } from '../projectStore';
import { useEditorStore } from '../editorStore';
import { useDialogStore } from '../dialogStore';
import { hasUnwrittenIdeas, useIdeaStore } from '../ideaStore';
import { useNotificationStore } from '../notificationStore';
import { BrainstormPanel } from '../../components/Brainstorm/BrainstormPanel';
import { CodeMirrorEditor } from '../../components/Editor/CodeMirrorEditor';
import { useAutoSave } from '../../hooks/useAutoSave';
import i18n from '../../i18n';

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
vi.mock('../../../../main/services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => h.mainCurrent },
}));
vi.mock('../../../../main/services/config-manager.js', () => ({
  configManager: { get: () => undefined, set: () => undefined, addRecentProject: () => undefined },
}));
vi.mock('../../../../main/services/manuscript-index-service.js', () => ({
  manuscriptIndexService: { isEnabled: () => false },
}));
vi.mock('../../../../main/services/retrieval-service.js', () => ({ retrievalService: {} }));
vi.mock('../../../../main/services/reading-notes-index-service.js', () => ({
  readingNotesIndexService: { configure: () => undefined, isReadingNoteFile: () => false },
}));
vi.mock('../../../../main/services/reading-notes-indexing.js', () => ({
  indexReadingNotesInBackground: () => undefined,
}));
vi.mock('../../../../main/services/history-service.js', () => ({
  historyService: { getHistoryManager: () => null },
}));
vi.mock('../../components/Chat/AssistantChat', () => ({ AssistantChat: () => null }));
vi.mock('react-force-graph-2d', () => ({ default: () => null }));

const { setupEditorHandlers } = await import('../../../../main/ipc/handlers/editor-handlers');
const { setupFilesystemHandlers } = await import('../../../../main/ipc/handlers/filesystem-handlers');
const { validateWritePath } = await import('../../../../main/ipc/utils/path-validator');

const A_TEXT = '# A\n\nTexte de A.\n';
const B_TEXT = '# B\n\nHuit mille mots de B.\n';
/** « # Été » en Latin-1. */
const LATIN1 = Buffer.from([0x23, 0x20, 0xc9, 0x74, 0xe9, 0x0a]);
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const IS_ROOT = process.getuid?.() === 0;

let root: string;
let dirA: string;
let dirB: string;
let documentA: string;
let documentB: string;
/** Tout ce qui demande une écriture, dans l'ordre : `editor:save-file` et `fs:write-file`. */
let writesTo: string[];

const store = () => useEditorStore.getState();
const project = () => useProjectStore.getState();
const dialogs = () => useDialogStore.getState();
const toasts = () => useNotificationStore.getState().notifications;
const projectJsonB = () => path.join(dirB, 'project.json');

function ipc<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`canal non enregistré : ${channel}`);
  return handler({}, ...args) as Promise<T>;
}

function installMain(): void {
  (window as unknown as { electron: unknown }).electron = {
    project: {
      load: vi.fn(async (projectJson: string) => {
        const dir = path.dirname(projectJson);
        h.mainCurrent = dir;
        return {
          success: true,
          project: { ...JSON.parse(await readFile(projectJson, 'utf8')), path: dir },
        };
      }),
      getChapters: vi.fn(async (dir: string) => {
        const manifest = JSON.parse(await readFile(path.join(dir, 'project.json'), 'utf8'));
        return { success: true, chapters: manifest.chapters ?? [], unattached: [] };
      }),
      getRecent: vi.fn(async () => []),
      getMetadata: vi.fn(async (projectJson: string) => ({
        success: true,
        project: { ...JSON.parse(await readFile(projectJson, 'utf8')), path: path.dirname(projectJson) },
      })),
    },
    editor: {
      loadFile: (filePath: string) => ipc('editor:load-file', filePath),
      saveFile: (filePath: string, content: string) => {
        writesTo.push(filePath);
        return ipc('editor:save-file', filePath, content);
      },
      onInsertText: () => () => undefined,
    },
    fs: {
      exists: (filePath: string) => ipc('fs:exists', filePath),
      readUserFile: (filePath: string) => ipc('fs:read-user-file', filePath),
      quarantineFile: (filePath: string) => ipc('fs:quarantine-file', filePath),
      writeFile: (filePath: string, content: string, options?: { exclusive?: boolean }) => {
        writesTo.push(filePath);
        return ipc('fs:write-file', filePath, content, options);
      },
    },
    proposals: { recordAdjudication: () => undefined },
    ipcRenderer: { on: () => undefined, removeListener: () => undefined },
  };
}

const Workbench: FC = () => {
  useAutoSave();
  return createElement(CodeMirrorEditor);
};

async function mountWorkbench(): Promise<void> {
  await act(async () => {
    render(createElement(Workbench));
  });
}

function currentView(): EditorView {
  const dom = document.querySelector<HTMLElement>('.cm-editor');
  const view = dom && EditorView.findFromDOM(dom);
  if (!view) throw new Error('Pas de vue CM6 montée');
  return view;
}

const typeAtEnd = (text: string) =>
  act(async () => {
    const view = currentView();
    const end = view.state.doc.length;
    view.dispatch({
      changes: { from: end, insert: text },
      selection: EditorSelection.cursor(end + text.length),
      annotations: Transaction.userEvent.of('input.type'),
    });
  });

const settle = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

const eventually = (assertion: () => void) => vi.waitFor(assertion, { timeout: 5000, interval: 20 });

async function writeProject(dir: string, manifest: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'project.json'),
    JSON.stringify({ createdAt: new Date().toISOString(), ...manifest })
  );
}

async function openProjectA(): Promise<void> {
  await mountWorkbench();
  await act(async () => {
    await project().loadProject(path.join(dirA, 'project.json'));
  });
  expect(store().filePath).toBe(documentA);
}

async function openProjectB(): Promise<void> {
  await act(async () => {
    await project().loadProject(projectJsonB());
  });
}

const expectUntitledBuffer = () => {
  expect(store().filePath).toBeNull();
  expect(store().bufferDetached).toBe(false);
  expect(currentView().state.readOnly).toBe(false);
  expect(project().loadState.kind).toBe('ready');
  expect(project().currentChapterId).toBeNull();
};

beforeEach(async () => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  root = await mkdtemp(path.join(os.tmpdir(), 'cliodeck-bascule-'));
  dirA = path.join(root, 'A');
  dirB = path.join(root, 'B');
  documentA = path.join(dirA, 'document.md');
  documentB = path.join(dirB, 'document.md');
  await writeProject(dirA, { id: 'a', name: 'A', type: 'article' });
  await writeProject(dirB, { id: 'b', name: 'B', type: 'article' });
  await writeFile(documentA, A_TEXT);
  await writeFile(documentB, B_TEXT);
  writesTo = [];
  setupEditorHandlers();
  setupFilesystemHandlers();
  installMain();
  // Sous Vitest, le second de deux import() concurrents d'un module simulé rend le vrai
  // module (mesuré), et le validateur garde en cache son import paresseux.
  h.mainCurrent = dirA;
  await validateWritePath(documentA);
  h.mainCurrent = null;
  useNotificationStore.getState().dismissAll();
  useEditorStore.setState((s) => ({
    filePath: null,
    content: '',
    isDirty: false,
    editorFacade: null,
    switchLock: null,
    bufferDetached: false,
    documentVersion: s.documentVersion + 1,
    settings: { ...s.settings, autoSave: true, autoSaveDelay: 30 },
  }));
  useProjectStore.setState({
    currentProject: null,
    chapters: [],
    unattachedFiles: [],
    currentChapterId: null,
    bookSettings: { ...DEFAULT_BOOK_SETTINGS },
    loadState: { kind: 'idle' },
  });
});

afterEach(async () => {
  cleanup();
  while (dialogs().confirmOpen) dialogs().resolveConfirm(false);
  while (dialogs().alertOpen) dialogs().closeAlert();
  useNotificationStore.getState().dismissAll();
  await chmod(dirB, 0o755).catch(() => undefined);
  await chmod(documentB, 0o644).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

describe('document présent mais illisible : il ne bouge pas', () => {
  it('Latin-1 : refusé, pas un octet ne change, l’auteur sait quoi faire', async () => {
    await writeFile(documentB, LATIN1);
    await openProjectA();

    await openProjectB();

    expect(readFileSync(documentB).equals(LATIN1)).toBe(true);
    expect(writesTo).toEqual([]);
    expectUntitledBuffer();
    expect(currentView().state.doc.toString()).toBe('');
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]).toMatchObject({
      level: 'error',
      title: i18n.t('project.documentOpenError'),
      message: `${i18n.t('editor.notUtf8')} ${i18n.t('project.documentOpenUntitled')}`,
    });
  });

  it('Latin-1 : taper ensuite n’atteint jamais le fichier refusé', async () => {
    await writeFile(documentB, LATIN1);
    await openProjectA();
    await openProjectB();

    await typeAtEnd('Une idée.');
    await settle(150);

    expect(readFileSync(documentB).equals(LATIN1)).toBe(true);
    expect(writesTo).toEqual([]);
    expect(store().isDirty).toBe(true);
    expect((await readdir(dirB)).sort()).toEqual(['document.md', 'project.json']);
  });

  it.skipIf(IS_ROOT)('droits retirés : le document reste, avec ses octets', async () => {
    await chmod(documentB, 0o000);
    await openProjectA();

    await openProjectB();

    expect(writesTo).toEqual([]);
    expectUntitledBuffer();
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].message).toBe(
      `${i18n.t('project.documentOpenUnchanged')} ${i18n.t('project.documentOpenUntitled')}`
    );
    await chmod(documentB, 0o644);
    expect(readFileSync(documentB, 'utf8')).toBe(B_TEXT);
  });

  it.skipIf(IS_ROOT)('lisible sans droit de lecture mais inscriptible : surtout pas de remplacement', async () => {
    // Le cas où le repli réussissait : `access(W_OK)` passe, et le renommage remplace tout.
    await chmod(documentB, 0o200);
    await openProjectA();

    await openProjectB();

    expect(writesTo).toEqual([]);
    expectUntitledBuffer();
    await chmod(documentB, 0o644);
    expect(readFileSync(documentB, 'utf8')).toBe(B_TEXT);
  });

  it('un dossier à la place du document : prévenu, rien de créé à côté', async () => {
    await rm(documentB);
    await mkdir(documentB);
    await openProjectA();

    await openProjectB();

    expect(writesTo).toEqual([]);
    expectUntitledBuffer();
    expect(toasts()).toHaveLength(1);
    expect(await readdir(documentB)).toEqual([]);
  });

  it('l’auteur avait accepté d’abandonner son tampon sans titre : le texte lui revient', async () => {
    await writeFile(documentB, LATIN1);
    await mountWorkbench();
    await typeAtEnd('Une idée sans titre.');

    const switching = project().loadProject(projectJsonB());
    await eventually(() => expect(dialogs().confirmOpen).toBe(true));
    await act(async () => {
      dialogs().resolveConfirm(true);
      await switching;
    });

    expect(currentView().state.doc.toString()).toBe('Une idée sans titre.');
    expect(currentView().state.readOnly).toBe(false);
    expect(store().filePath).toBeNull();
    expect(store().content).toBe('Une idée sans titre.');
    expect(store().isDirty).toBe(true);
    expect(toasts()).toHaveLength(1);
    expect(readFileSync(documentB).equals(LATIN1)).toBe(true);
  });

  it('livre au premier chapitre en Latin-1 : aucun chapitre annoncé, et le fichier reste', async () => {
    const chapter = path.join(dirB, 'chapters', '01.md');
    await writeProject(dirB, {
      id: 'b',
      name: 'B',
      type: 'book',
      chapters: [{ id: 'c1', title: 'Un', filePath: 'chapters/01.md', order: 0, kind: 'chapter' }],
    });
    await mkdir(path.dirname(chapter));
    await writeFile(chapter, LATIN1);
    await openProjectA();

    await openProjectB();

    expect(readFileSync(chapter).equals(LATIN1)).toBe(true);
    expect(writesTo).toEqual([]);
    expectUntitledBuffer();
    expect(project().chapters.map((c) => c.id)).toEqual(['c1']);
    expect(toasts()[0].message).toContain(i18n.t('editor.notUtf8'));
  });
});

describe('le message d’un document non ouvert : il dit vrai tant qu’il est là', () => {
  /** Projet B ouvert sur son document en Latin-1 : le tampon sans titre, et le message. */
  async function refusedOnB(): Promise<void> {
    await writeFile(documentB, LATIN1);
    await openProjectA();
    await openProjectB();
    expect(toasts()).toHaveLength(1);
  }

  it('le fichier converti puis rouvert : le document à l’écran, et plus de message', async () => {
    await refusedOnB();

    await writeFile(documentB, '# Été\n');
    await act(async () => {
      await store().loadFile(documentB);
    });

    expect(store().filePath).toBe(documentB);
    expect(currentView().state.doc.toString()).toBe('# Été\n');
    expect(toasts()).toEqual([]);
  });

  it('un autre fichier ouvert : le message parlait du tampon, il part aussi', async () => {
    await refusedOnB();
    const other = path.join(dirB, 'notes.md');
    await writeFile(other, '# Notes\n');

    await act(async () => {
      await store().loadFile(other);
    });

    expect(store().filePath).toBe(other);
    expect(toasts()).toEqual([]);
  });

  it('rouvert sans conversion : le refus reste dit', async () => {
    await refusedOnB();

    await act(async () => {
      await expect(store().loadFile(documentB)).rejects.toMatchObject({ reason: 'encoding' });
    });

    expect(store().filePath).toBeNull();
    expect(toasts()).toHaveLength(1);
    expect(readFileSync(documentB).equals(LATIN1)).toBe(true);
  });

  it('écrire dans le tampon : l’éditeur n’a toujours pas le document, le message reste', async () => {
    await refusedOnB();

    await typeAtEnd('Une idée.');
    await settle(100);

    expect(toasts()).toHaveLength(1);
  });

  it('le projet quitté puis rouvert toujours refusé : un seul message, qui part de même', async () => {
    await refusedOnB();
    await act(async () => {
      await project().loadProject(path.join(dirA, 'project.json'));
    });
    expect(toasts()).toEqual([]);
    expect(store().filePath).toBe(documentA);

    await openProjectB();
    expect(toasts()).toHaveLength(1);

    await writeFile(documentB, '# Été\n');
    await act(async () => {
      await store().loadFile(documentB);
    });
    expect(toasts()).toEqual([]);
  });
});

describe('document absent : il se crée, sans rien pouvoir écraser', () => {
  it('article : gabarit, ouverture, et la frappe s’y écrit', async () => {
    await rm(documentB);
    await openProjectA();

    await openProjectB();

    expect(readFileSync(documentB, 'utf8')).toBe('# B\n');
    expect(store().filePath).toBe(documentB);
    expect(store().content).toBe('# B\n');
    expect(toasts()).toEqual([]);

    await typeAtEnd('Une phrase.');
    await eventually(() => expect(readFileSync(documentB, 'utf8')).toBe('# B\nUne phrase.'));
  });

  it('le fichier apparaît entre la lecture et la création : il n’est pas écrasé', async () => {
    await rm(documentB);
    await openProjectA();
    const read = window.electron.editor.loadFile;
    window.electron.editor.loadFile = async (filePath: string) => {
      const response = await read(filePath);
      if (filePath === documentB) await writeFile(documentB, B_TEXT);
      return response;
    };

    await openProjectB();

    expect(readFileSync(documentB, 'utf8')).toBe(B_TEXT);
    expect(store().filePath).toBeNull();
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].details).toContain('EEXIST');
  });

  it('livre au chapitre disparu : rien n’est inventé', async () => {
    const chapter = path.join(dirB, 'chapters', '01.md');
    await writeProject(dirB, {
      id: 'b',
      name: 'B',
      type: 'book',
      chapters: [{ id: 'c1', title: 'Un', filePath: 'chapters/01.md', order: 0, kind: 'chapter' }],
    });
    await mkdir(path.dirname(chapter));
    await openProjectA();

    await openProjectB();

    expect(existsSync(chapter)).toBe(false);
    expect(writesTo).toEqual([]);
    expectUntitledBuffer();
    expect(toasts()).toHaveLength(1);
  });

  it.skipIf(IS_ROOT)('dossier en lecture seule : la création échoue, prévenu, tampon sans titre', async () => {
    await rm(documentB);
    await chmod(dirB, 0o555);
    await openProjectA();

    await openProjectB();

    expect(existsSync(documentB)).toBe(false);
    expectUntitledBuffer();
    expect(toasts()).toHaveLength(1);
  });
});

describe('fichier avec BOM : il reste ouvrable, et son BOM ne bouge pas', () => {
  const bomBytes = (text: string) => Buffer.concat([BOM, Buffer.from(text, 'utf8')]);
  const TEXT = '# Été\n\nTexte.\n';

  it('ouvert : le BOM n’est pas dans le texte, le titre reste un titre, et aucun message', async () => {
    await writeFile(documentB, bomBytes(TEXT));
    await openProjectA();

    await openProjectB();

    expect(store().filePath).toBe(documentB);
    expect(store().content).toBe(TEXT);
    expect(currentView().state.doc.toString()).toBe(TEXT);
    expect(document.querySelector('.cm-specialChar')).toBeNull();
    expect(toasts()).toEqual([]);
  });

  it('rien tapé : aucune écriture, les octets ne changent pas', async () => {
    await writeFile(documentB, bomBytes(TEXT));
    await openProjectA();
    await openProjectB();

    await settle(150);

    expect(writesTo).toEqual([]);
    expect(readFileSync(documentB).equals(bomBytes(TEXT))).toBe(true);
    expect(store().isDirty).toBe(false);
  });

  it('Enregistrer sans rien taper : octet pour octet', async () => {
    await writeFile(documentB, bomBytes(TEXT));
    await openProjectA();
    await openProjectB();

    await act(async () => {
      await store().saveFile();
    });

    expect(readFileSync(documentB).equals(bomBytes(TEXT))).toBe(true);
    expect(store().isDirty).toBe(false);
  });

  it('frappe et autosave : le texte part, précédé d’un seul BOM, et l’éditeur n’en voit toujours rien', async () => {
    await writeFile(documentB, bomBytes(TEXT));
    await openProjectA();
    await openProjectB();

    await typeAtEnd('Suite.');

    await eventually(() => expect(readFileSync(documentB).equals(bomBytes(`${TEXT}Suite.`))).toBe(true));
    await eventually(() => expect(store().isDirty).toBe(false));
    expect(store().content).toBe(`${TEXT}Suite.`);
    expect(currentView().state.doc.toString()).toBe(`${TEXT}Suite.`);
  });
});

describe('les idées du projet qu’on quitte', () => {
  const ideasOf = (dir: string) => path.join(dir, '.cliodeck', 'ideas.json');
  const ideasFile = (title: string) =>
    JSON.stringify({
      ideas: [{ id: 'i1', title, content: '', tags: [], links: [], origin: { type: 'manual' } }],
    });
  const contentOnDisk = async (dir: string) =>
    (JSON.parse(await readFile(ideasOf(dir), 'utf8')) as { ideas: Array<{ content: string }> }).ideas[0].content;
  const ideaStore = () => useIdeaStore.getState();
  const typedWithoutBlur = 'Tapé, jamais quitté le champ.';

  beforeEach(async () => {
    for (const [dir, title] of [
      [dirA, 'Idée de A'],
      [dirB, 'Idée de B'],
    ]) {
      await mkdir(path.join(dir, '.cliodeck'));
      await writeFile(ideasOf(dir), ideasFile(title));
    }
    useIdeaStore.setState({
      ideas: [],
      isLoading: false,
      selectedId: null,
      persistence: { kind: 'ready' },
      loadedFor: null,
      saveError: null,
    });
    await openProjectA();
    await ideaStore().loadIdeas(dirA);
    ideaStore().updateIdea('i1', { content: typedWithoutBlur });
  });

  it('une frappe dont aucun blur n’est parti s’écrit dans A avant que le main bascule, et B garde sa liste', async () => {
    const bBefore = await readFile(ideasOf(dirB), 'utf8');

    await openProjectB();

    expect(project().currentProject?.path).toBe(dirB);
    expect(await contentOnDisk(dirA)).toBe(typedWithoutBlur);
    expect(await readFile(ideasOf(dirB), 'utf8')).toBe(bBefore);

    // Ce que le panneau ferait après la bascule : B reçoit sa liste, et l'écriture suivante aussi.
    await ideaStore().loadIdeas(dirB);
    expect(ideaStore().ideas.map((idea) => idea.title)).toEqual(['Idée de B']);
    await ideaStore().saveIdeas(dirB);
    expect(await contentOnDisk(dirA)).toBe(typedWithoutBlur);
    expect(await contentOnDisk(dirB)).toBe('');
  });

  it('une écriture de A encore dans la file part avant la bascule, avec l’état courant', async () => {
    const write = window.electron.fs.writeFile;
    (window.electron.fs as { writeFile: unknown }).writeFile = async (filePath: string, content: string) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return write(filePath, content);
    };
    const inFlight = ideaStore().saveIdeas(dirA);
    await settle(10);
    ideaStore().updateIdea('i1', { content: 'Tapé pendant la première écriture.' });
    void ideaStore().saveIdeas(dirA);

    await openProjectB();
    await inFlight;

    expect(project().currentProject?.path).toBe(dirB);
    expect(await contentOnDisk(dirA)).toBe('Tapé pendant la première écriture.');
  });

  describe('si elle ne s’écrit pas : la question est posée, et elle parle des idées', () => {
    const asked = () => dialogs().confirmMessage;

    /** Demande B, attend la question, et rend la bascule en cours. */
    async function askingForB(): Promise<{ switching: Promise<void> }> {
      const switching = project().loadProject(projectJsonB());
      await eventually(() => expect(dialogs().confirmOpen).toBe(true));
      return { switching };
    }

    beforeEach(() => {
      (window.electron.fs as { writeFile: unknown }).writeFile = async () => {
        throw new Error('ENOSPC: no space left on device, write');
      };
    });

    it('elle nomme les idées et la raison, jamais le seul « fichier »', async () => {
      const { switching } = await askingForB();

      expect(asked()).toContain(i18n.t('ideas.switchSaveFailed', { reason: 'ENOSPC: no space left on device, write' }));
      expect(asked()).toContain('ENOSPC');
      expect(asked()).toMatch(/idées/);
      expect(dialogs().confirmTitle).toBe(i18n.t('ideas.switchSaveFailedTitle'));

      await act(async () => {
        dialogs().resolveConfirm(false);
        await switching;
      });
    });

    it('rester : rien n’a bougé, ni rejet, ni message d’erreur, et le texte est à l’écran', async () => {
      const { switching } = await askingForB();

      await act(async () => {
        dialogs().resolveConfirm(false);
        await switching;
      });

      expect(project().currentProject?.path).toBe(dirA);
      expect(project().loadState.kind).toBe('ready');
      expect(h.mainCurrent).toBe(dirA);
      expect(ideaStore().ideas[0].content).toBe(typedWithoutBlur);
      expect(ideaStore().saveError).toContain('ENOSPC');
      expect(store().filePath).toBe(documentA);
      expect(dialogs().alertOpen).toBe(false);
    });

    it('changer quand même : la bascule a lieu, B garde sa liste, et sortir ne repose pas la question', async () => {
      const bBefore = await readFile(ideasOf(dirB), 'utf8');
      const { switching } = await askingForB();

      await act(async () => {
        dialogs().resolveConfirm(true);
        await switching;
      });

      expect(project().currentProject?.path).toBe(dirB);
      expect(store().filePath).toBe(documentB);
      expect(hasUnwrittenIdeas()).toBe(false);
      expect(ideaStore().saveError).toBeNull();
      expect(await readFile(ideasOf(dirB), 'utf8')).toBe(bBefore);
      expect(await contentOnDisk(dirA)).toBe('');
    });

    it('changer quand même, mais le main refuse : rien n’est perdu, et la panne se dit encore', async () => {
      (window.electron.project as { load: unknown }).load = vi.fn(async () => ({
        success: false,
        error: 'projet refusé',
      }));
      const { switching } = await askingForB();

      await act(async () => {
        dialogs().resolveConfirm(true);
        await expect(switching).rejects.toThrow('projet refusé');
      });

      expect(project().currentProject?.path).toBe(dirA);
      expect(ideaStore().ideas[0].content).toBe(typedWithoutBlur);
      expect(hasUnwrittenIdeas()).toBe(true);
      expect(ideaStore().saveError).toContain('ENOSPC');
    });
  });

  it('un échec d’écriture, puis l’auteur défait ce qui ne s’écrivait pas : la bascule passe sans question', async () => {
    await ideaStore().flushIdeas();
    (window.electron.fs as { writeFile: unknown }).writeFile = async () => {
      throw new Error('ENOSPC: no space left on device, write');
    };
    const id = ideaStore().addIdea({ title: 'De trop', content: '', tags: [], links: [], origin: { type: 'manual' } });
    await ideaStore().saveIdeas(dirA);
    expect(ideaStore().saveError).toContain('ENOSPC');

    ideaStore().removeIdea(id);
    await openProjectB();

    expect(dialogs().confirmOpen).toBe(false);
    expect(project().currentProject?.path).toBe(dirB);
  });

  it('fermer un projet dont les idées ne s’écrivent plus n’empêche pas d’en ouvrir un autre', async () => {
    (window.electron.fs as { writeFile: unknown }).writeFile = async () => {
      throw new Error('ENOSPC: no space left on device, write');
    };

    await act(async () => {
      await project().closeProject();
    });
    await openProjectB();

    expect(dialogs().confirmOpen).toBe(false);
    expect(project().currentProject?.path).toBe(dirB);
    await ideaStore().loadIdeas(dirB);
    expect(ideaStore().ideas.map((idea) => idea.title)).toEqual(['Idée de B']);
    expect(ideaStore().saveError).toBeNull();
  });

  it('fermer malgré une écriture ratée se dit, avec la raison, et le message reste', async () => {
    (window.electron.fs as { writeFile: unknown }).writeFile = async () => {
      throw new Error('ENOSPC: no space left on device, write');
    };

    await act(async () => {
      await project().closeProject();
    });

    expect(project().currentProject).toBeNull();
    const notice = toasts().find((toast) => toast.title === i18n.t('ideas.closeSaveFailedTitle'));
    expect(notice?.level).toBe('error');
    expect(notice?.duration).toBe(0);
    expect(notice?.details).toContain('ENOSPC');
  });

  it('ce message dit vrai : rouvrir ce projet écrit ce qui attendait', async () => {
    const write = window.electron.fs.writeFile;
    (window.electron.fs as { writeFile: unknown }).writeFile = async () => {
      throw new Error('ENOSPC: no space left on device, write');
    };
    await act(async () => {
      await project().closeProject();
    });
    (window.electron.fs as { writeFile: unknown }).writeFile = write;

    await act(async () => {
      await project().loadProject(path.join(dirA, 'project.json'));
    });
    await ideaStore().loadIdeas(dirA);

    expect(await contentOnDisk(dirA)).toBe(typedWithoutBlur);
    expect(toasts().some((toast) => toast.title === i18n.t('ideas.closeSaveFailedTitle'))).toBe(false);
  });

  it('en ouvrir un autre à la place : le message a été dit, il part, et la sortie ne redemande rien', async () => {
    (window.electron.fs as { writeFile: unknown }).writeFile = async () => {
      throw new Error('ENOSPC: no space left on device, write');
    };
    await act(async () => {
      await project().closeProject();
    });

    await openProjectB();

    expect(toasts().some((toast) => toast.title === i18n.t('ideas.closeSaveFailedTitle'))).toBe(false);
    expect(hasUnwrittenIdeas()).toBe(false);
  });

  it('fermer sans rien à écrire ne dit rien', async () => {
    await ideaStore().flushIdeas();

    await act(async () => {
      await project().closeProject();
    });

    expect(toasts().some((toast) => toast.title === i18n.t('ideas.closeSaveFailedTitle'))).toBe(false);
  });

  describe('le panneau pendant que le main bascule : plus rien à y taper, puisque rien ne l’écrirait', () => {
    let releaseLoad: (() => void) | null;
    let realLoad: typeof window.electron.project.load;

    beforeEach(async () => {
      releaseLoad = null;
      realLoad = window.electron.project.load;
      (window.electron.project as { load: unknown }).load = vi.fn(async (projectJson: string) => {
        await new Promise<void>((resolve) => {
          releaseLoad = resolve;
        });
        return realLoad(projectJson);
      });
      await act(async () => {
        render(createElement(BrainstormPanel));
      });
      await act(async () => {
        await ideaStore().loadIdeas(dirA);
      });
      fireEvent.click(screen.getByRole('tab', { name: 'ideas.tabIdeas' }));
      fireEvent.click(await screen.findByText('Idée de A'));
      await screen.findByDisplayValue(typedWithoutBlur);
    });

    const held = async (): Promise<{ switching: Promise<void> }> => {
      const switching = project().loadProject(projectJsonB());
      await act(async () => {
        await vi.waitFor(() => expect(releaseLoad).not.toBeNull(), { timeout: 5000, interval: 5 });
      });
      return { switching };
    };

    it('le champ d’idée quitte l’écran dès la bascule, et B arrive avec sa liste', async () => {
      const { switching } = await held();

      expect(screen.queryByDisplayValue(typedWithoutBlur)).toBeNull();
      expect(screen.queryByTitle('ideas.create')).toBeNull();
      expect(screen.getByText('ideas.loading')).toBeInTheDocument();
      expect(await contentOnDisk(dirA)).toBe(typedWithoutBlur);

      await act(async () => {
        (releaseLoad as unknown as () => void)();
        await switching;
      });

      expect(await screen.findByText('Idée de B', undefined, { timeout: 5000 })).toBeInTheDocument();
      expect(screen.queryByText('Idée de A')).toBeNull();
    });

    it('une bascule qui échoue rend le panneau, avec sa liste', async () => {
      (window.electron.project as { load: unknown }).load = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          releaseLoad = resolve;
        });
        return { success: false, error: 'projet refusé' };
      });
      const { switching } = await held();
      expect(screen.queryByDisplayValue(typedWithoutBlur)).toBeNull();

      await act(async () => {
        (releaseLoad as unknown as () => void)();
        await expect(switching).rejects.toThrow('projet refusé');
      });

      expect(await screen.findByDisplayValue(typedWithoutBlur, undefined, { timeout: 5000 })).toBeInTheDocument();
      expect(project().currentProject?.path).toBe(dirA);
    });
  });

  it('fermer le projet l’écrit aussi, tant que le main l’autorise', async () => {
    await act(async () => {
      await project().closeProject();
    });

    expect(await contentOnDisk(dirA)).toBe(typedWithoutBlur);
  });
});

describe('choisir un fichier qui n’est pas un projet (S11-1-18, A35) : A n’est jamais quitté', () => {
  const FRAPPE = ' Une phrase que rien n’a encore écrite.';

  const folderState = async (dir: string): Promise<Array<[string, number, number, string]>> => {
    const names = (await readdir(dir)).sort();
    return Promise.all(
      names.map(async (name): Promise<[string, number, number, string]> => {
        const file = path.join(dir, name);
        const info = await stat(file);
        return [name, info.size, info.mtimeMs, (await readFile(file)).toString('base64')];
      })
    );
  };

  /** Le vrai garde du main, sur le vrai disque : c'est lui qui décide, pas un simulacre. */
  const useRealManifestGuard = async () => {
    const { ProjectManager } = await vi.importActual<typeof import('../../../../main/services/project-manager.js')>(
      '../../../../main/services/project-manager.js'
    );
    const main = new ProjectManager();
    const load = vi.fn(async (file: string) => {
      const result = await main.loadProject(file);
      if (result.success) h.mainCurrent = main.getCurrentProjectPath();
      return result;
    });
    const projectApi = window.electron.project as unknown as Record<string, unknown>;
    projectApi.getMetadata = (file: string) => main.getProjectMetadata(file);
    projectApi.load = load;
    return load;
  };

  it.each<[string, string, string]>([
    ['un CSL-JSON', 'references.json', '[{"id":"a","type":"book"}]\n'],
    ['un package.json', 'package.json', '{"name":"mon-outil","version":"1.0.0"}\n'],
    ['un .json vide', 'vide.json', ''],
    ['un project.json sans name ni type', 'project.json', '{"theme":"dark"}\n'],
  ])('%s : même vue, même document, la frappe reste, et rien ne s’écrit', async (_label, name, content) => {
    useEditorStore.setState((s) => ({ settings: { ...s.settings, autoSave: false } }));
    await openProjectA();
    const load = await useRealManifestGuard();
    const elsewhere = path.join(root, 'Ailleurs');
    await mkdir(elsewhere);
    const chosen = path.join(elsewhere, name);
    await writeFile(chosen, content);
    const before = await folderState(elsewhere);

    await typeAtEnd(FRAPPE);
    const view = currentView();
    const version = store().documentVersion;
    const left: unknown[] = [];
    const stopWatching = useEditorStore.subscribe((state) => {
      if (state.bufferDetached || state.filePath !== documentA) left.push(state.filePath);
    });
    writesTo.length = 0;

    let refusal: unknown;
    await act(async () => {
      refusal = await project().loadProject(chosen).catch((error: unknown) => error);
    });
    stopWatching();

    // Ni détaché, ni rouvert : la même vue, sans nouveau montage.
    expect(left).toEqual([]);
    expect(currentView()).toBe(view);
    expect(store().documentVersion).toBe(version);
    expect(refusal).toBeInstanceOf(NotAProjectError);
    expect((refusal as NotAProjectError).fileName).toBe(name);
    expect(view.state.readOnly).toBe(false);
    expect(view.state.doc.toString()).toContain(FRAPPE);
    expect(project().currentProject?.path).toBe(dirA);
    // L'indicateur de chargement ne reste pas en route.
    expect(project().loadState.kind).not.toBe('loading');
    // Le main n'a rien eu à faire, et la frappe n'a pas été écrite de force pour un refus.
    expect(load).not.toHaveBeenCalled();
    expect(writesTo).toEqual([]);
    expect(readFileSync(documentA, 'utf8')).toBe(A_TEXT);
    expect(await folderState(elsewhere)).toEqual(before);
  });

  it('le refus laisse le projet utilisable : un vrai projet s’ouvre juste après, et A s’écrit en partant', async () => {
    useEditorStore.setState((s) => ({ settings: { ...s.settings, autoSave: false } }));
    await openProjectA();
    await useRealManifestGuard();
    const chosen = path.join(root, 'package.json');
    await writeFile(chosen, '{"name":"mon-outil"}\n');

    await typeAtEnd(FRAPPE);
    await act(async () => {
      await expect(project().loadProject(chosen)).rejects.toBeInstanceOf(NotAProjectError);
    });
    await eventually(() => expect(store().content).toContain(FRAPPE));

    await openProjectB();

    expect(project().currentProject?.path).toBe(dirB);
    expect(store().filePath).toBe(documentB);
    expect(readFileSync(documentA, 'utf8')).toContain(FRAPPE);
  });
});
