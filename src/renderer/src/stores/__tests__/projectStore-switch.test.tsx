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
import { cleanup, render, act } from '@testing-library/react';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { EditorSelection, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { DEFAULT_BOOK_SETTINGS } from '@backend/types/book';

import { useProjectStore } from '../projectStore';
import { useEditorStore } from '../editorStore';
import { useDialogStore } from '../dialogStore';
import { useNotificationStore } from '../notificationStore';
import { CodeMirrorEditor } from '../../components/Editor/CodeMirrorEditor';
import { useAutoSave } from '../../hooks/useAutoSave';
import i18n from '../../i18n';

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
  configManager: { get: () => undefined, set: () => undefined },
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
