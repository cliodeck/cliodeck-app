// @vitest-environment jsdom
/**
 * Changer de mode ne prend ni le curseur ni l'annulation, et une proposition n'écrit rien.
 *
 * Quitter le mode Écriture démonte l'éditeur. Le cache d'état vivait dans le composant : il
 * disparaissait avec lui, la vue remontée repartait à l'offset 0 sans historique, et une
 * proposition tombait au-dessus du titre.
 *
 * Vraie vue CM6, vrais stores, vrai autosave ; seul le disque est simulé, derrière l'IPC. Les
 * minuteurs sont simulés : l'autosave part quand le test le décide, à n'importe quelle vitesse de CI.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import { EditorSelection, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo, undoDepth } from '@codemirror/commands';

import { CodeMirrorEditor } from '../CodeMirrorEditor';
import { resetEditorStates } from '../editor-state-memory';
import { useAutoSave } from '../../../hooks/useAutoSave';
import { flushOpenDocument } from '../../../hooks/useSaveOnQuit';
import { useEditorStore } from '../../../stores/editorStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useWorkspaceModeStore, WORKSPACE_MODES, type WorkspaceMode } from '../../../stores/workspaceModeStore';
import { WorkspaceModeBar } from '../../Layout/WorkspaceModeBar';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

const PROJECT = '/p/article';
const DOC = `${PROJECT}/document.md`;
const OTHER = '/p/autre';
const OTHER_DOC = `${OTHER}/document.md`;
const TITLE = '# Titre\n\n';
const SECOND = 'Second paragraphe, avec son milieu ici et sa fin.';
const TEXT = `${TITLE}Premier paragraphe.\n\n${SECOND}\n`;
const MIDDLE = TEXT.indexOf('milieu');
const PHRASE = 'une frappe ';
const DRAFT = 'TEXTE DU BROUILLON';

let disk: Record<string, string>;
let writes: Array<[string, string]>;

const editor = () => useEditorStore.getState();
const mirror = () => editor().content;

/** Ce que MainLayout monte en mode Écriture : l'autosave et l'éditeur, rien dans les autres modes. */
const WritePanel: React.FC = () => {
  useAutoSave();
  return <CodeMirrorEditor />;
};
const Workspace: React.FC = () => {
  const mode = useWorkspaceModeStore((s) => s.active);
  return mode === 'write' ? <WritePanel /> : null;
};

function currentView(): EditorView {
  const dom = document.querySelector<HTMLElement>('.cm-editor');
  const view = dom && EditorView.findFromDOM(dom);
  if (!view) throw new Error('Pas de vue CM6 montée');
  return view;
}

const noView = () => document.querySelector('.cm-editor') === null;
const text = () => currentView().state.doc.toString();
const head = () => currentView().state.selection.main.head;

function placeCursor(position: number): void {
  act(() => {
    currentView().dispatch({ selection: EditorSelection.cursor(position) });
  });
}

function type(typed: string): void {
  const view = currentView();
  const at = view.state.selection.main.head;
  act(() => {
    view.dispatch({
      changes: { from: at, insert: typed },
      selection: EditorSelection.cursor(at + typed.length),
      annotations: Transaction.userEvent.of('input.type'),
    });
  });
}

const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

async function switchMode(mode: WorkspaceMode): Promise<void> {
  await act(async () => {
    useWorkspaceModeStore.getState().setActive(mode);
  });
}

const proposalBox = () => document.querySelector<HTMLElement>('.cm-proposal-box');
const proposalPosition = () => {
  const box = proposalBox();
  if (!box) throw new Error('Aucune proposition à l’écran');
  return currentView().posAtDOM(box);
};
const proposalButton = (index: 0 | 1 | 2) => {
  const button = proposalBox()?.querySelectorAll('button')[index];
  if (!button) throw new Error('Pas de bouton sur la proposition');
  return button;
};
const accept = () => act(() => void fireEvent.mouseDown(proposalButton(0)));
const reject = () => act(() => void fireEvent.mouseDown(proposalButton(1)));

function propose(): void {
  act(() => {
    const outcome = editor().insertDraftAtCursor(DRAFT, { model: 'm', task: 't' });
    expect(outcome.mode).toBe('cursor');
  });
}

function projectFile(root: string, type: 'article' | 'book' | 'presentation', id = 'p1') {
  return {
    id,
    name: 'Projet',
    path: root,
    type,
    createdAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
  };
}

function setProject(root: string, type: 'article' | 'book' | 'presentation' = 'article'): void {
  useProjectStore.setState({
    currentProject: {
      ...projectFile(root, type),
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
    loadState: { kind: 'ready', loadedAt: 'avant', path: root },
  });
}

function openInStore(filePath: string): void {
  useEditorStore.setState((s) => ({
    filePath,
    content: disk[filePath],
    isDirty: false,
    lastSavedAt: null,
    documentVersion: s.documentVersion + 1,
  }));
}

async function mountWorkspace(mode: WorkspaceMode = 'write'): Promise<void> {
  useWorkspaceModeStore.setState({ active: mode });
  await act(async () => {
    render(<Workspace />);
  });
}

async function openProject(root: string): Promise<void> {
  await act(async () => {
    await useProjectStore.getState().loadProject(`${root}/project.json`);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetEditorStates();
  disk = { [DOC]: TEXT, [OTHER_DOC]: '# Autre\n\nTexte de l’autre projet.\n' };
  writes = [];
  (window as unknown as { electron: unknown }).electron = {
    project: {
      getMetadata: vi.fn(async (projectJson: string) => ({
        success: true,
        project: projectFile(projectJson.replace('/project.json', ''), 'article'),
      })),
      load: vi.fn(async (projectJson: string) => ({
        success: true,
        project: projectFile(projectJson.replace('/project.json', ''), 'article'),
      })),
      close: vi.fn(async () => ({ success: true })),
      getRecent: vi.fn(async () => []),
      getChapters: vi.fn(async () => ({ success: true, chapters: [], unattached: [] })),
    },
    editor: {
      loadFile: vi.fn(async (path: string) =>
        path in disk ? { success: true, content: disk[path] } : { success: false, code: 'absent', error: 'absent' }
      ),
      saveFile: vi.fn(async (path: string, content: string) => {
        writes.push([path, content]);
        disk[path] = content;
        return { success: true };
      }),
      onInsertText: () => () => undefined,
    },
    pdf: { getAllDocuments: vi.fn(async () => ({ success: true, documents: [] })) },
    proposals: { recordAdjudication: () => undefined },
    ipcRenderer: { on: () => undefined, removeListener: () => undefined },
  };
  setProject(PROJECT);
  openInStore(DOC);
  useEditorStore.setState((s) => ({ settings: { ...s.settings, autoSave: true } }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useEditorStore.setState({
    editorFacade: null,
    switchLock: null,
    bufferDetached: false,
    filePath: null,
    content: '',
    isDirty: false,
  });
  useProjectStore.setState({ currentProject: null, chapters: [], currentChapterId: null, loadState: { kind: 'idle' } });
  useWorkspaceModeStore.setState({ active: 'write' });
});

describe('Écriture → Brainstorm → Écriture', () => {
  it('rend le curseur et l’annulation, et la proposition tombe au curseur et non à 0', async () => {
    await mountWorkspace();
    placeCursor(MIDDLE);
    type(PHRASE);
    await wait(400);

    await switchMode('brainstorm');
    expect(noView()).toBe(true);
    await switchMode('write');

    expect(head()).toBe(MIDDLE + PHRASE.length);
    expect(undoDepth(currentView().state)).toBe(1);

    propose();
    expect(proposalPosition()).toBe(MIDDLE + PHRASE.length);
    expect(text()).not.toContain(DRAFT);

    await act(async () => {
      expect(undo(currentView())).toBe(true);
    });
    expect(text()).toBe(TEXT);
  });

  it('garde la frappe tombée juste avant le changement de mode, synchro encore en attente', async () => {
    await mountWorkspace();
    placeCursor(MIDDLE);
    type(PHRASE);
    expect(mirror()).toBe(TEXT);

    await switchMode('brainstorm');
    const expected = `${TEXT.slice(0, MIDDLE)}${PHRASE}${TEXT.slice(MIDDLE)}`;
    expect(mirror()).toBe(expected);
    expect(editor().isDirty).toBe(true);

    await switchMode('write');
    expect(text()).toBe(expected);
    expect(head()).toBe(MIDDLE + PHRASE.length);
    await act(async () => {
      expect(undo(currentView())).toBe(true);
    });
    expect(text()).toBe(TEXT);
  });

  it('n’écrit rien tant qu’on n’a pas décidé, autosave actif ; rejeter ne laisse rien, et Cmd+Z ramène la frappe d’avant', async () => {
    await mountWorkspace();
    placeCursor(MIDDLE);
    type(PHRASE);
    await wait(4000);
    const typedOnDisk = `${TEXT.slice(0, MIDDLE)}${PHRASE}${TEXT.slice(MIDDLE)}`;
    expect(disk[DOC]).toBe(typedOnDisk);

    await switchMode('brainstorm');
    await switchMode('write');
    writes = [];

    propose();
    expect(editor().isDirty).toBe(false);
    await wait(10_000);
    expect(writes).toEqual([]);
    expect(disk[DOC]).toBe(typedOnDisk);

    reject();
    await wait(10_000);
    expect(proposalBox()).toBeNull();
    expect(text()).toBe(typedOnDisk);
    expect(writes).toEqual([]);

    await act(async () => {
      expect(undo(currentView())).toBe(true);
    });
    expect(text()).toBe(TEXT);
  });

  it('accepter écrit le texte ; Cmd+Z le retire, et lui seul', async () => {
    await mountWorkspace();
    placeCursor(MIDDLE);
    type(PHRASE);
    await wait(4000);
    await switchMode('brainstorm');
    await switchMode('write');
    const before = text();

    propose();
    accept();
    expect(text()).toContain(DRAFT);
    await wait(4000);
    expect(disk[DOC]).toContain(DRAFT);

    await act(async () => {
      expect(undo(currentView())).toBe(true);
    });
    expect(text()).toBe(before);
  });
});

describe('ce qu’une fermeture écrit', () => {
  it('hors du mode Écriture, le miroir : la frappe tombée avant le changement de mode y est', async () => {
    await mountWorkspace();
    placeCursor(MIDDLE);
    type(PHRASE);
    await switchMode('brainstorm');
    expect(editor().editorFacade).toBeNull();

    await act(async () => {
      const report = await flushOpenDocument();
      expect(report.outcome).toBe('saved');
    });

    expect(disk[DOC]).toBe(`${TEXT.slice(0, MIDDLE)}${PHRASE}${TEXT.slice(MIDDLE)}`);
  });

  it('une proposition en attente n’entre pas dans ce qui s’écrit', async () => {
    await mountWorkspace();
    placeCursor(MIDDLE);
    type(PHRASE);
    propose();

    await act(async () => {
      const report = await flushOpenDocument();
      expect(report.outcome).toBe('saved');
    });

    expect(disk[DOC]).toBe(`${TEXT.slice(0, MIDDLE)}${PHRASE}${TEXT.slice(MIDDLE)}`);
    expect(disk[DOC]).not.toContain(DRAFT);
  });
});

describe('aucun curseur connu', () => {
  it('document jamais affiché en Écriture : la proposition va en fin de document, pas au-dessus du titre', async () => {
    await mountWorkspace('brainstorm');
    await switchMode('write');

    propose();

    expect(proposalPosition()).toBe(TEXT.length);
    expect(text()).toBe(TEXT);
    // Tab et Échap n'agissent qu'à l'endroit de la proposition.
    expect(head()).toBe(TEXT.length);
  });

  it('document affiché mais curseur jamais posé : toujours la fin, après un aller-retour de mode', async () => {
    await mountWorkspace();
    await switchMode('brainstorm');
    await switchMode('write');

    propose();

    expect(proposalPosition()).toBe(TEXT.length);
  });

  it('un curseur posé au tout début est un curseur connu', async () => {
    await mountWorkspace();
    placeCursor(TEXT.length);
    placeCursor(0);

    propose();

    expect(proposalPosition()).toBe(0);
  });

  it('un clic là où le curseur se trouve déjà, au tout début, est un curseur connu', async () => {
    await mountWorkspace();
    // Sans mise en page, jsdom placerait un clic gauche en fin de ligne. Le clic droit ne déplace
    // aucune sélection, comme un clic réel à l'offset 0, que le parcours e2e vérifie.
    act(() => {
      fireEvent.mouseDown(currentView().contentDOM, { button: 2 });
    });
    expect(head()).toBe(0);

    propose();

    expect(proposalPosition()).toBe(0);
  });

  it('la seconde proposition sans curseur ne remonte pas au-dessus du titre', async () => {
    await mountWorkspace();
    propose();
    reject();

    propose();

    expect(proposalPosition()).toBe(TEXT.length);
  });
});

describe('curseur en fin de ligne, là où est celui qui vient d’écrire une phrase', () => {
  const FIRST_END = TEXT.indexOf('Premier paragraphe.') + 'Premier paragraphe.'.length;

  it('la proposition reste au curseur, et le curseur reste à sa place', async () => {
    await mountWorkspace();
    placeCursor(FIRST_END);
    await switchMode('brainstorm');
    await switchMode('write');

    propose();

    expect(proposalPosition()).toBe(FIRST_END);
    expect(head()).toBe(FIRST_END);
    expect(text()).toBe(TEXT);
  });

  it('rejeter : le curseur n’a pas bougé, et la frappe suivante reste dans le paragraphe', async () => {
    await mountWorkspace();
    placeCursor(FIRST_END);
    propose();

    reject();

    expect(head()).toBe(FIRST_END);
    type('SUITE');
    expect(text()).toBe(TEXT.replace('Premier paragraphe.', 'Premier paragraphe.SUITE'));
  });

  it('accepter donne un bloc entre les deux paragraphes, le curseur à sa fin', async () => {
    await mountWorkspace();
    placeCursor(FIRST_END);
    propose();

    accept();

    expect(text()).toBe(TEXT.replace('Premier paragraphe.', `Premier paragraphe.\n\n${DRAFT}`));
    expect(head()).toBe(FIRST_END + `\n\n${DRAFT}`.length);
  });

  it('un titre suit le paragraphe : la frappe après un rejet n’entre pas dans le titre', async () => {
    const withHeading = '# Titre\n\nParagraphe.\n\n## Section\n\nSuite.\n';
    disk[DOC] = withHeading;
    openInStore(DOC);
    await mountWorkspace();
    const end = withHeading.indexOf('Paragraphe.') + 'Paragraphe.'.length;
    placeCursor(end);

    propose();
    expect(head()).toBe(end);
    reject();
    type('SUITE');

    expect(text()).toBe(withHeading.replace('Paragraphe.', 'Paragraphe.SUITE'));
  });

  it('présentation : le séparateur de diapositives reste intact', async () => {
    const slides = `${PROJECT}/slides.md`;
    const deck = '# Une\n\nTexte de la une.\n\n---\n\n# Deux\n';
    disk[slides] = deck;
    setProject(PROJECT, 'presentation');
    openInStore(slides);
    await mountWorkspace();
    const end = deck.indexOf('Texte de la une.') + 'Texte de la une.'.length;
    placeCursor(end);

    propose();
    expect(head()).toBe(end);
    reject();
    type('SUITE');

    expect(text()).toBe(deck.replace('Texte de la une.', 'Texte de la une.SUITE'));
    expect(text().split('\n')).toContain('---');
  });
});

describe('revenir en Écriture et continuer sans cliquer', () => {
  const contentHasFocus = () => document.activeElement === currentView().contentDOM;

  /** La barre des modes telle que l'auteur s'en sert : un vrai onglet, cliqué, qui garde le focus. */
  async function clickModeTab(mode: WorkspaceMode): Promise<void> {
    const tab = document.querySelectorAll<HTMLButtonElement>('.workspace-mode-bar__tab')[
      WORKSPACE_MODES.indexOf(mode)
    ];
    tab.focus();
    await act(async () => {
      fireEvent.click(tab);
    });
  }

  async function mountWithModeBar(): Promise<void> {
    useWorkspaceModeStore.setState({ active: 'write' });
    await act(async () => {
      render(
        <>
          <WorkspaceModeBar />
          <input aria-label="champ du chat" />
          <Workspace />
        </>
      );
    });
  }

  it('par l’onglet du mode : la vue reprend le focus, curseur conservé', async () => {
    await mountWithModeBar();
    placeCursor(MIDDLE);
    type(PHRASE);

    await clickModeTab('brainstorm');
    await clickModeTab('write');

    expect(contentHasFocus()).toBe(true);
    expect(head()).toBe(MIDDLE + PHRASE.length);
  });

  it('le focus n’est nulle part (le bouton du chat vient de disparaître) : la vue le reprend', async () => {
    await mountWithModeBar();
    placeCursor(MIDDLE);
    await clickModeTab('brainstorm');
    (document.activeElement as HTMLElement).blur();

    await switchMode('write');

    expect(contentHasFocus()).toBe(true);
  });

  it('un champ a le focus (le chat du panneau droit) : il le garde', async () => {
    await mountWithModeBar();
    placeCursor(MIDDLE);
    await clickModeTab('brainstorm');
    const field = document.querySelector<HTMLInputElement>('input');
    field?.focus();

    await switchMode('write');

    expect(document.activeElement).toBe(field);
  });

  it('aucun curseur posé : il n’y a rien à reprendre, le focus ne va pas à l’offset 0', async () => {
    await mountWithModeBar();

    await clickModeTab('brainstorm');
    await clickModeTab('write');

    expect(contentHasFocus()).toBe(false);
  });

  it('un changement de chapitre ne prend pas le focus, même vers un chapitre déjà visité', async () => {
    const A = `${PROJECT}/chapters/a.md`;
    const B = `${PROJECT}/chapters/b.md`;
    disk[A] = '# A\n\nTexte A.\n';
    disk[B] = '# B\n\nTexte B.\n';
    setProject(PROJECT, 'book');
    openInStore(A);
    await mountWithModeBar();
    placeCursor(disk[A].length);

    await act(async () => {
      await editor().loadFile(B);
    });
    await act(async () => {
      await editor().loadFile(A);
    });

    expect(head()).toBe(disk[A].length);
    expect(contentHasFocus()).toBe(false);
  });

  it('un chapitre ouvert depuis un autre mode ne prend pas le focus au retour', async () => {
    const A = `${PROJECT}/chapters/a.md`;
    const B = `${PROJECT}/chapters/b.md`;
    disk[A] = '# A\n\nTexte A.\n';
    disk[B] = '# B\n\nTexte B.\n';
    setProject(PROJECT, 'book');
    openInStore(A);
    await mountWithModeBar();
    placeCursor(disk[A].length);
    await act(async () => {
      await editor().loadFile(B);
    });
    placeCursor(disk[B].length);
    await clickModeTab('brainstorm');
    await act(async () => {
      await editor().loadFile(A);
    });

    await clickModeTab('write');

    expect(text()).toBe(disk[A]);
    expect(contentHasFocus()).toBe(false);
  });

  it('pendant un changement de projet, la vue en lecture seule ne prend pas le focus', async () => {
    await mountWithModeBar();
    placeCursor(MIDDLE);
    await clickModeTab('brainstorm');
    useEditorStore.setState({ bufferDetached: true });

    await clickModeTab('write');

    expect(contentHasFocus()).toBe(false);
  });
});

describe('le défilement restauré ne passe pas sur une demande de défilement', () => {
  const FAR = 700;
  const scrollTop = () => currentView().scrollDOM.scrollTop;

  /** L'auteur a fait défiler, loin de son curseur, puis un aller-retour de mode. */
  async function comeBackScrolled(): Promise<void> {
    await mountWorkspace();
    placeCursor(MIDDLE);
    const { scrollDOM } = currentView();
    scrollDOM.scrollTop = FAR;
    fireEvent.scroll(scrollDOM);
    await switchMode('brainstorm');
    await switchMode('write');
  }

  it('rien ne demande d’aller ailleurs : le défilement revient', async () => {
    await comeBackScrolled();
    await wait(50);
    expect(scrollTop()).toBe(FAR);
  });

  it('une proposition posée au retour reste la dernière à décider du défilement', async () => {
    await comeBackScrolled();
    propose();
    await wait(50);
    expect(scrollTop()).not.toBe(FAR);
  });

  it('« Ouvrir la source » au retour reste la dernière à décider du défilement', async () => {
    await comeBackScrolled();
    act(() => editor().editorFacade?.revealLine(3));
    await wait(50);
    expect(scrollTop()).not.toBe(FAR);
  });

  it('une proposition que la vue refuse ne demande rien : le défilement revient', async () => {
    await mountWorkspace();
    const { scrollDOM } = currentView();
    scrollDOM.scrollTop = FAR;
    fireEvent.scroll(scrollDOM);
    await switchMode('brainstorm');
    useEditorStore.setState({ bufferDetached: true });
    await switchMode('write');

    expect(editor().editorFacade?.propose({ proposed: DRAFT })).toBe(false);
    await wait(50);
    expect(scrollTop()).toBe(FAR);
  });
});

describe('le cache suit le projet, éditeur monté ou non', () => {
  it('changer de projet hors du mode Écriture puis y revenir : aucun état restauré', async () => {
    await mountWorkspace();
    placeCursor(MIDDLE);
    type(PHRASE);
    await wait(4000);
    await switchMode('brainstorm');

    await openProject(OTHER);
    expect(editor().filePath).toBe(OTHER_DOC);
    await openProject(PROJECT);
    expect(editor().filePath).toBe(DOC);

    await switchMode('write');
    expect(text()).toContain(PHRASE);
    expect(undoDepth(currentView().state)).toBe(0);
    expect(head()).toBe(0);
  });

  it('projet fermé puis rouvert au même chemin : aucun état restauré, comme avant', async () => {
    await mountWorkspace();
    placeCursor(MIDDLE);
    type(PHRASE);
    await wait(4000);
    await switchMode('brainstorm');

    await act(async () => {
      await useProjectStore.getState().closeProject();
    });
    await openProject(PROJECT);

    await switchMode('write');
    expect(undoDepth(currentView().state)).toBe(0);
    expect(head()).toBe(0);
  });

  it('projet changé en Écriture : aucun état ne survit non plus', async () => {
    await mountWorkspace();
    placeCursor(MIDDLE);
    type(PHRASE);
    await wait(4000);

    await openProject(OTHER);
    await openProject(PROJECT);

    expect(editor().filePath).toBe(DOC);
    expect(undoDepth(currentView().state)).toBe(0);
  });

  it('cache vidé : plus de curseur connu, la proposition va en fin de document', async () => {
    await mountWorkspace();
    placeCursor(MIDDLE);
    await switchMode('brainstorm');
    await openProject(OTHER);
    await openProject(PROJECT);
    await switchMode('write');

    propose();

    expect(proposalPosition()).toBe(TEXT.length);
  });
});

describe('le tampon sans titre', () => {
  const newBuffer = () =>
    act(async () => {
      await editor().replaceBuffer({ kind: 'untitled', discardOutgoing: true }, 'new-document');
    });

  it('retour de mode sur le même tampon : texte, curseur et annulation reviennent', async () => {
    await mountWorkspace();
    await newBuffer();
    type('Une idée');
    placeCursor(3);
    const version = editor().documentVersion;

    await switchMode('brainstorm');
    expect(editor().documentVersion).toBe(version);
    await switchMode('write');

    expect(text()).toBe('Une idée');
    expect(head()).toBe(3);
    expect(undoDepth(currentView().state)).toBe(1);
  });

  it('un nouveau tampon ne reprend ni le texte ni l’annulation d’un autre, même à texte identique', async () => {
    await mountWorkspace();
    await newBuffer();
    type('Une idée');
    // Le texte revient à vide : seul son historique distingue ce tampon d'un tampon neuf.
    act(() => {
      currentView().dispatch({
        changes: { from: 0, to: currentView().state.doc.length },
        annotations: Transaction.userEvent.of('delete.backward'),
      });
    });
    await wait(400);
    expect(undoDepth(currentView().state)).toBeGreaterThan(0);

    await switchMode('brainstorm');
    await newBuffer();
    await switchMode('write');

    expect(text()).toBe('');
    expect(undoDepth(currentView().state)).toBe(0);
    await act(async () => {
      expect(undo(currentView())).toBe(false);
    });
    expect(text()).toBe('');
  });

  it('un tampon rendu à son texte par une bascule échouée reprend sans son annulation', async () => {
    await mountWorkspace();
    await newBuffer();
    type('Une idée');
    await wait(400);
    let left: string | undefined;
    await act(async () => {
      const outcome = await editor().replaceBuffer({ kind: 'detach', discardOutgoing: true }, 'project-switch');
      if (outcome.status === 'replaced') left = outcome.detachedText;
    });
    await act(async () => {
      await editor().replaceBuffer({ kind: 'untitled', text: left }, 'project-restore');
    });

    expect(text()).toBe('Une idée');
    expect(undoDepth(currentView().state)).toBe(0);
  });
});

describe('la vue en lecture seule', () => {
  it('une vue détachée refuse la proposition : rien à l’écran, et le brouillon garde son texte', async () => {
    await mountWorkspace();
    await act(async () => {
      await editor().replaceBuffer({ kind: 'detach' }, 'project-switch');
    });
    expect(currentView().state.readOnly).toBe(true);

    let accepted: boolean | undefined;
    act(() => {
      accepted = editor().editorFacade?.propose({ proposed: DRAFT });
    });
    expect(accepted).toBe(false);
    expect(proposalBox()).toBeNull();

    let mode: string | undefined;
    act(() => {
      mode = editor().insertDraftAtCursor(DRAFT).mode;
    });
    expect(mode).toBe('unavailable');
    expect(proposalBox()).toBeNull();
    expect(mirror()).not.toContain(DRAFT);
  });
});

describe('livre : les chapitres d’un mode à l’autre', () => {
  const A = `${PROJECT}/chapters/a.md`;
  const B = `${PROJECT}/chapters/b.md`;

  beforeEach(() => {
    disk[A] = '# A\n\nTexte du chapitre A.\n';
    disk[B] = '# B\n\nTexte du chapitre B.\n';
    setProject(PROJECT, 'book');
    openInStore(A);
  });

  it('ouvrir un autre chapitre depuis un autre mode : A s’écrit, B s’affiche, A garde son annulation', async () => {
    await mountWorkspace();
    placeCursor(disk[A].length);
    type(PHRASE);
    const typed = `# A\n\nTexte du chapitre A.\n${PHRASE}`;

    await switchMode('brainstorm');
    expect(mirror()).toBe(typed);
    await act(async () => {
      await editor().loadFile(B);
    });
    expect(disk[A]).toBe(typed);
    expect(editor().filePath).toBe(B);

    await switchMode('write');
    expect(text()).toBe(disk[B]);
    expect(undoDepth(currentView().state)).toBe(0);

    await act(async () => {
      await editor().loadFile(A);
    });
    expect(text()).toBe(typed);
    expect(head()).toBe(typed.length);
    await act(async () => {
      expect(undo(currentView())).toBe(true);
    });
    expect(text()).toBe('# A\n\nTexte du chapitre A.\n');
  });

  it('un chapitre modifié dehors pendant le passage en Brainstorm repart du disque', async () => {
    await mountWorkspace();
    placeCursor(disk[A].length);
    type(PHRASE);
    await wait(4000);
    await switchMode('brainstorm');
    await act(async () => {
      await editor().loadFile(B);
    });
    disk[A] = '# A\n\nRéécrit dehors.\n';

    await act(async () => {
      await editor().loadFile(A);
    });
    await switchMode('write');

    expect(text()).toBe('# A\n\nRéécrit dehors.\n');
    expect(undoDepth(currentView().state)).toBe(0);
  });
});

describe('un fichier CRLF', () => {
  const CRLF_TEXT = TEXT.replace(/\n/g, '\r\n');
  const FIRST_PARAGRAPH_END = TEXT.indexOf('Premier paragraphe.') + 'Premier paragraphe.'.length;
  const BLOCK = 'Ligne une.\n\nLigne deux.';
  const toCrlf = (value: string) => value.replace(/\n/g, '\r\n');

  async function proposeAndAccept(source: string): Promise<string> {
    disk[DOC] = source;
    openInStore(DOC);
    await mountWorkspace();
    placeCursor(FIRST_PARAGRAPH_END);
    act(() => {
      expect(editor().insertDraftAtCursor(BLOCK, { model: 'm', task: 't' }).mode).toBe('cursor');
    });
    accept();
    return editor().getLiveContent();
  }

  it('une proposition acceptée rend le même texte qu’en LF, avec ses fins de ligne', async () => {
    const accepted = await proposeAndAccept(CRLF_TEXT);
    cleanup();
    const asLf = await proposeAndAccept(TEXT);
    expect(asLf).toContain(`Premier paragraphe.\n\n${BLOCK}\n\n${SECOND}`);
    expect(accepted).toBe(toCrlf(asLf));
  });

  it('sans curseur connu, la proposition va en fin de document', async () => {
    disk[DOC] = CRLF_TEXT;
    openInStore(DOC);
    await mountWorkspace();
    propose();
    expect(proposalPosition()).toBe(currentView().state.doc.length);
    accept();
    expect(editor().getLiveContent()).toBe(`${CRLF_TEXT}\r\n${DRAFT}`);
  });

  it('accepté, le texte part sur le disque sans LF nu', async () => {
    await proposeAndAccept(CRLF_TEXT);
    await wait(10_000);
    const written = writes.at(-1)?.[1] ?? '';
    expect(written).toContain(toCrlf(BLOCK));
    expect(written.replace(/\r\n/g, '')).not.toContain('\n');
  });
});

describe('présentation : slides.md suit le même chemin', () => {
  const SLIDES = `${PROJECT}/slides.md`;

  it('rend le curseur et l’annulation', async () => {
    disk[SLIDES] = '# Une\n\n---\n\n# Deux\n';
    setProject(PROJECT, 'presentation');
    openInStore(SLIDES);
    await mountWorkspace();
    placeCursor(disk[SLIDES].length);
    type(PHRASE);

    await switchMode('explore');
    await switchMode('write');

    expect(head()).toBe(disk[SLIDES].length + PHRASE.length);
    await act(async () => {
      expect(undo(currentView())).toBe(true);
    });
    expect(text()).toBe(disk[SLIDES]);
  });
});
