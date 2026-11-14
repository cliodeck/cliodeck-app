// @vitest-environment jsdom
/**
 * Les éditions que l'app fait elle-même dans le texte ouvert ne touchent que ce qui change.
 *
 * Insérer une note réécrivait le document du curseur à la fin : une proposition IA en attente
 * plus loin était retirée, et son retrait partait aux journaux comme une décision (`invalidated`)
 * que l'auteur n'avait pas prise (S14-1-8). Renuméroter les notes ou renommer le chapitre ouvert
 * remplaçait tout le document : le curseur retombait en tête, et la frappe suivante avec lui
 * (S14-1-12).
 *
 * Vraie vue CM6, vrai EditorPanel (barre d'outils, navigateur de chapitres), vrais stores, vraies
 * propositions ; seuls le disque et le canal des journaux sont simulés, derrière l'IPC.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { EditorSelection, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import type { ResolvedChapter } from '@backend/types/book';
import { DEFAULT_BOOK_SETTINGS } from '@backend/types/book';

import { EditorPanel } from '../EditorPanel';
import { resetEditorStates } from '../editor-state-memory';
import { onceProposalDecided } from '../proposals-ipc';
import { useAutoSave } from '../../../hooks/useAutoSave';
import { useEditorStore, type DraftInsertion } from '../../../stores/editorStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useDialogStore } from '../../../stores/dialogStore';
import { useManuscriptStore } from '../../../stores/manuscriptStore';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

const ARTICLE = '/p/article';
const DOC = `${ARTICLE}/document.md`;
const BOOK = '/p/livre';
const CHAPTER = `${BOOK}/chapters/a.md`;

const P1 = 'Premier paragraphe, où l’on insère la note.';
const P2 = 'Deuxième paragraphe.';
const P3 = 'Troisième paragraphe, au bout duquel attend la proposition.';
const P4 = 'Dernier paragraphe.';
const TEXT = `${P1}\n\n${P2}\n\n${P3}\n\n${P4}\n`;
const DRAFT = 'Brouillon venu du Brainstorm.';

let disk: Record<string, string>;
let writes: Array<[string, string]>;
let adjudications: Array<{ decision: string }>;

const editor = () => useEditorStore.getState();

function currentView(): EditorView {
  const dom = document.querySelector<HTMLElement>('.cm-editor');
  const view = dom && EditorView.findFromDOM(dom);
  if (!view) throw new Error('Pas de vue CM6 montée');
  return view;
}

const docText = () => currentView().state.doc.toString();
const cursor = () => currentView().state.selection.main.head;

function placeCursor(at: number): void {
  act(() => {
    currentView().dispatch({ selection: EditorSelection.cursor(at) });
  });
}

/** Une frappe réelle pour CM6 : annotée, au curseur, et entrée dans l'historique. */
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

const undoOnce = () =>
  act(() => {
    expect(undo(currentView())).toBe(true);
  });

/** Le vrai keymap : Mod-Shift-f, sous jsdom Ctrl. La touche part vers la vue, jamais au système. */
function pressFootnote(): void {
  act(() => {
    currentView().contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F', keyCode: 70, shiftKey: true, ctrlKey: true, bubbles: true, cancelable: true })
    );
  });
}

/** Le brouillon proposé par le vrai chemin du Brainstorm, au curseur posé par l'auteur. */
function proposeDraftAt(at: number): string {
  placeCursor(at);
  // Affecté dans le rappel : sans `as`, TypeScript garderait le type de la valeur de départ.
  let insertion = { mode: 'unavailable' } as DraftInsertion;
  act(() => {
    insertion = editor().insertDraftAtCursor(DRAFT, { model: 'modele', task: 'brainstorm' });
  });
  if (insertion.mode !== 'cursor') throw new Error('La proposition n’a pas été posée');
  return insertion.proposalId;
}

const proposalBoxes = () => document.querySelectorAll('.cm-proposal-box');

function acceptProposal(): void {
  const accept = document.querySelector<HTMLButtonElement>('.cm-proposal-box .cm-proposal-btn');
  if (!accept) throw new Error('Aucune proposition à l’écran');
  act(() => {
    fireEvent.mouseDown(accept);
  });
}

const AutoSaved: React.FC = () => {
  useAutoSave();
  return null;
};

function setProject(path: string, type: 'article' | 'book', chapters: ResolvedChapter[] = []): void {
  useProjectStore.setState({
    currentProject: { id: 'p1', name: 'Projet', path, type, createdAt: new Date(), lastOpenedAt: new Date() },
    bookSettings: { ...DEFAULT_BOOK_SETTINGS },
    chapters,
    unattachedFiles: [],
    currentChapterId: chapters[0]?.id ?? null,
    loadState: { kind: 'ready', loadedAt: 'avant', path },
  });
}

async function mount(filePath: string, text: string): Promise<void> {
  disk[filePath] = text;
  useEditorStore.setState((s) => ({
    filePath,
    content: text,
    isDirty: false,
    lastSavedAt: null,
    documentVersion: s.documentVersion + 1,
  }));
  await act(async () => {
    render(
      <>
        <AutoSaved />
        <EditorPanel />
      </>
    );
  });
}

const mountArticle = (text: string = TEXT) => {
  setProject(ARTICLE, 'article');
  return mount(DOC, text);
};

const CHAPTER_A: ResolvedChapter = { id: 'a', title: 'Chapitre A', filePath: 'chapters/a.md', order: 0, kind: 'chapter' };

const mountBook = (text: string) => {
  setProject(BOOK, 'book', [CHAPTER_A]);
  return mount(CHAPTER, text);
};

beforeEach(() => {
  vi.useFakeTimers();
  resetEditorStates();
  disk = {};
  writes = [];
  adjudications = [];
  (window as unknown as { electron: unknown }).electron = {
    project: {
      getChapters: vi.fn(async () => ({ success: true, chapters: [CHAPTER_A], unattached: [] })),
      saveChapters: vi.fn(async () => ({ success: true })),
      readChapters: vi.fn(async (data: { projectPath: string; filePaths: string[] }) => ({
        success: true,
        files: data.filePaths.map((filePath) => ({ filePath, content: disk[`${data.projectPath}/${filePath}`] })),
      })),
    },
    editor: {
      loadFile: vi.fn(async (path: string) => ({ success: true, content: disk[path] })),
      saveFile: vi.fn(async (path: string, content: string) => {
        writes.push([path, content]);
        disk[path] = content;
        return { success: true };
      }),
      onInsertText: () => () => undefined,
    },
    pdf: { getAllDocuments: vi.fn(async () => ({ success: true, documents: [] })) },
    // Le canal des deux journaux : ce qui y part est une décision de l'auteur.
    proposals: {
      recordAdjudication: (event: { decision: string }) => {
        adjudications.push(event);
      },
    },
    ipcRenderer: { on: () => () => undefined },
  };
  useEditorStore.setState((s) => ({
    bufferDetached: false,
    switchLock: null,
    settings: { ...s.settings, autoSave: true, autoSaveDelay: 3000 },
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  useEditorStore.setState({
    editorFacade: null,
    switchLock: null,
    bufferDetached: false,
    filePath: null,
    content: '',
    isDirty: false,
  });
  useManuscriptStore.setState({ renumbering: false });
  useProjectStore.setState({ currentProject: null, chapters: [], currentChapterId: null, loadState: { kind: 'idle' } });
  while (useDialogStore.getState().alertOpen) useDialogStore.getState().closeAlert();
});

describe('insérer une note : seules les propositions qu’elle touche sont retirées', () => {
  const endOfP1 = TEXT.indexOf(P1) + P1.length;
  const endOfP3 = TEXT.indexOf(P3) + P3.length;

  it('S14-1-8 : une proposition en attente plus loin reste, et aucune décision ne part aux journaux', async () => {
    await mountArticle();
    const proposalId = proposeDraftAt(endOfP3);
    const decided = vi.fn();
    onceProposalDecided(proposalId, decided);
    expect(proposalBoxes()).toHaveLength(1);

    placeCursor(endOfP1);
    pressFootnote();

    expect(docText()).toBe(`${P1}[^1]\n\n${P2}\n\n${P3}\n\n${P4}\n\n[^1]: `);
    expect(adjudications).toEqual([]);
    expect(decided).not.toHaveBeenCalled();
    expect(proposalBoxes()).toHaveLength(1);

    // Elle a suivi l'appel inséré avant elle : acceptée, le brouillon tombe derrière le 3e paragraphe,
    // en bloc à part.
    acceptProposal();
    expect(docText()).toBe(`${P1}[^1]\n\n${P2}\n\n${P3}\n\n${DRAFT}\n\n${P4}\n\n[^1]: `);
    expect(adjudications.map((e) => e.decision)).toEqual(['accepted']);
    expect(decided).toHaveBeenCalledWith('accepted');
  });

  it('témoin : une proposition avant le curseur reste aussi', async () => {
    await mountArticle();
    proposeDraftAt(0);

    placeCursor(endOfP3);
    pressFootnote();

    expect(adjudications).toEqual([]);
    expect(proposalBoxes()).toHaveLength(1);
  });

  it('témoin : une proposition à l’endroit de l’appel est retirée, comme le veut le contrat', async () => {
    await mountArticle();
    proposeDraftAt(endOfP1);

    placeCursor(endOfP1);
    pressFootnote();

    expect(adjudications.map((e) => e.decision)).toEqual(['invalidated']);
    expect(proposalBoxes()).toHaveLength(0);
  });

  it('un seul Cmd+Z retire la note, et rend le curseur où il était', async () => {
    await mountArticle();
    placeCursor(endOfP1);
    pressFootnote();
    expect(cursor()).toBe(docText().length);

    undoOnce();
    expect(docText()).toBe(TEXT);
    expect(cursor()).toBe(endOfP1);
  });
});

/**
 * La définition d'une note va au bout du document : là même où attend un brouillon envoyé sans
 * curseur posé (`insertDraftAtCursor`), ou celui d'un auteur qui écrit la fin d'un texte sans fin
 * de ligne finale. Elle le touchait, et il était retiré et journalisé `invalidated` (revue L01-6).
 */
describe('insérer une note : une proposition au bout du document reste devant la définition', () => {
  const endOfP1 = TEXT.indexOf(P1) + P1.length;
  const noted = (text: string) => text.replace(P1, `${P1}[^1]`);

  it('brouillon envoyé sans curseur posé : il attend au bout du document, la note ne le retire pas', async () => {
    await mountArticle();
    // Aucun curseur posé par l'auteur : le brouillon va au bout du document, après la fin de ligne finale.
    let insertion = { mode: 'unavailable' } as DraftInsertion;
    act(() => {
      insertion = editor().insertDraftAtCursor(DRAFT, { model: 'modele', task: 'brainstorm' });
    });
    if (insertion.mode !== 'cursor') throw new Error('La proposition n’a pas été posée');
    const decided = vi.fn();
    onceProposalDecided(insertion.proposalId, decided);
    expect(proposalBoxes()).toHaveLength(1);

    placeCursor(endOfP1);
    pressFootnote();

    // Les blancs de fin restent devant le brouillon, la définition vient après lui.
    expect(docText()).toBe(`${noted(TEXT)}\n\n[^1]: `);
    expect(adjudications).toEqual([]);
    expect(proposalBoxes()).toHaveLength(1);

    // Le texte de la note se tape après le brouillon, sans le toucher.
    type('Source.');
    expect(adjudications).toEqual([]);

    // Accepté, le brouillon tombe à la fin du texte, en bloc à part, et la définition reste séparée
    // de lui par une ligne vide : collée, pandoc l'imprimerait en clair.
    acceptProposal();
    expect(docText()).toBe(`${noted(TEXT)}\n${DRAFT}\n\n[^1]: Source.`);
    expect(adjudications.map((e) => e.decision)).toEqual(['accepted']);
    expect(decided).toHaveBeenCalledWith('accepted');
  });

  it('Cmd+Z retire la note et son texte sans toucher le brouillon, qui reste au bout', async () => {
    await mountArticle();
    act(() => {
      editor().insertDraftAtCursor(DRAFT, { model: 'modele', task: 'brainstorm' });
    });
    placeCursor(endOfP1);
    pressFootnote();
    type('Source.');

    undoOnce();
    undoOnce();
    expect(docText()).toBe(TEXT);
    expect(adjudications).toEqual([]);
    expect(proposalBoxes()).toHaveLength(1);

    acceptProposal();
    expect(docText()).toBe(`${TEXT}\n${DRAFT}`);
    expect(adjudications.map((e) => e.decision)).toEqual(['accepted']);
  });

  it('texte sans fin de ligne finale, curseur et proposition au bout : la note plus haut ne la retire pas', async () => {
    const text = TEXT.trimEnd();
    await mountArticle(text);
    proposeDraftAt(text.length);

    placeCursor(endOfP1);
    pressFootnote();

    // Rien à garder au bout : le même texte que sans proposition.
    expect(docText()).toBe(`${noted(text)}\n\n[^1]: `);
    expect(adjudications).toEqual([]);
    expect(proposalBoxes()).toHaveLength(1);

    acceptProposal();
    expect(docText()).toBe(`${noted(text)}\n\n${DRAFT}\n\n[^1]: `);
    expect(adjudications.map((e) => e.decision)).toEqual(['accepted']);
  });

  it('proposition dans les blancs de fin : acceptée, elle ne colle pas la définition', async () => {
    const text = `${TEXT}\n\n`;
    await mountArticle(text);
    // Entre deux des trois fins de ligne finales.
    proposeDraftAt(TEXT.length);

    placeCursor(endOfP1);
    pressFootnote();
    expect(adjudications).toEqual([]);

    acceptProposal();
    expect(docText()).toMatch(new RegExp(`${DRAFT}\\n\\n+\\[\\^1\\]: $`));
    expect(adjudications.map((e) => e.decision)).toEqual(['accepted']);
  });

  it('témoin : au bout du dernier paragraphe, avant la fin de ligne finale, le texte est celui d’avant', async () => {
    await mountArticle();
    proposeDraftAt(TEXT.length - 1);

    placeCursor(endOfP1);
    pressFootnote();

    expect(docText()).toBe(`${noted(TEXT)}\n[^1]: `);
    expect(adjudications).toEqual([]);
    expect(proposalBoxes()).toHaveLength(1);
  });

  /**
   * Seconde revue L01-6 : la note au bout du dernier paragraphe, cas courant, avant le brouillon
   * envoyé sans curseur posé. L'appel et la définition remplaçaient d'un seul tenant la fin de ligne
   * finale, et le brouillon qui attendait après elle était retiré, alors qu'une frappe au même
   * curseur le laisse.
   */
  it('brouillon envoyé sans curseur posé, note au bout du dernier paragraphe : le brouillon reste, accepté à part', async () => {
    await mountArticle();
    let insertion = { mode: 'unavailable' } as DraftInsertion;
    act(() => {
      insertion = editor().insertDraftAtCursor(DRAFT, { model: 'modele', task: 'brainstorm' });
    });
    if (insertion.mode !== 'cursor') throw new Error('La proposition n’a pas été posée');
    const decided = vi.fn();
    onceProposalDecided(insertion.proposalId, decided);

    placeCursor(TEXT.indexOf(P4) + P4.length);
    pressFootnote();

    const notedP4 = TEXT.replace(P4, `${P4}[^1]`);
    // La fin de ligne finale reste devant le brouillon, la définition vient après lui.
    expect(docText()).toBe(`${notedP4}\n\n[^1]: `);
    expect(adjudications).toEqual([]);
    expect(proposalBoxes()).toHaveLength(1);

    type('Source.');
    acceptProposal();
    expect(docText()).toBe(`${notedP4}\n${DRAFT}\n\n[^1]: Source.`);
    expect(adjudications.map((e) => e.decision)).toEqual(['accepted']);
    expect(decided).toHaveBeenCalledWith('accepted');
  });

  it('témoin : une proposition posée dans la définition est retirée par Cmd+Z, le brouillon d’avant reste', async () => {
    await mountArticle();
    act(() => {
      editor().insertDraftAtCursor(DRAFT, { model: 'modele', task: 'brainstorm' });
    });
    placeCursor(endOfP1);
    pressFootnote();
    // Le curseur est resté dans la définition : le second brouillon s'y pose, après elle.
    act(() => {
      editor().insertDraftAtCursor('Texte de note proposé.', { model: 'modele', task: 'brainstorm' });
    });
    expect(proposalBoxes()).toHaveLength(2);
    expect(adjudications).toEqual([]);

    undoOnce();

    expect(docText()).toBe(TEXT);
    expect(adjudications.map((e) => e.decision)).toEqual(['invalidated']);
    expect(proposalBoxes()).toHaveLength(1);
    acceptProposal();
    expect(docText()).toBe(`${TEXT}\n${DRAFT}`);
  });

  it('témoin : un curseur dans les blancs de fin pose la note sur la proposition qui y attend, qui est retirée', async () => {
    await mountArticle();
    proposeDraftAt(TEXT.length);

    placeCursor(TEXT.length);
    pressFootnote();

    expect(adjudications.map((e) => e.decision)).toEqual(['invalidated']);
    expect(proposalBoxes()).toHaveLength(0);
  });
});

describe('renuméroter les notes : le curseur reste là où était l’auteur', () => {
  const NOTES =
    '# Titre\n\nPremier appel[^3] dans le texte, puis la suite de la phrase.\n\nSecond appel[^1].\n\n[^1]: un.\n[^3]: trois.\n';
  const RENUMBERED =
    '# Titre\n\nPremier appel[^1] dans le texte, puis la suite de la phrase.\n\nSecond appel[^2].\n\n[^2]: un.\n[^1]: trois.\n';
  const renumber = () =>
    act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.renumberFootnotes'));
    });

  it('S14-1-12, document isolé : curseur 31 → 31, la frappe suivante tombe au même endroit', async () => {
    await mountArticle(NOTES);
    const at = 31;
    expect(NOTES.slice(0, at)).toMatch(/\[\^3\] dans$/);
    placeCursor(at);

    await renumber();

    expect(docText()).toBe(RENUMBERED);
    expect(cursor()).toBe(at);
    type('X');
    expect(docText()).toBe(`${RENUMBERED.slice(0, at)}X${RENUMBERED.slice(at)}`);
  });

  it('un seul Cmd+Z défait la renumérotation, et rien de ce qui a été tapé juste avant', async () => {
    await mountArticle(NOTES);
    placeCursor(NOTES.indexOf(' puis'));
    type(' vite');
    const typed = docText();

    await renumber();
    undoOnce();

    expect(docText()).toBe(typed);
  });

  it('une proposition entre deux notes renumérotées, qu’aucun changement ne touche, reste', async () => {
    await mountArticle(NOTES);
    proposeDraftAt(NOTES.indexOf(' puis'));

    await renumber();

    expect(docText()).toBe(RENUMBERED);
    expect(adjudications).toEqual([]);
    expect(proposalBoxes()).toHaveLength(1);
  });

  it('témoin : une proposition collée à une étiquette qui change est retirée', async () => {
    await mountArticle(NOTES);
    proposeDraftAt(NOTES.indexOf('3]'));

    await renumber();

    expect(adjudications.map((e) => e.decision)).toEqual(['invalidated']);
  });

  it('fichier CRLF : seules les étiquettes changent, le curseur reste, et le fichier reste CRLF uniforme', async () => {
    const crlf = NOTES.replace(/\n/g, '\r\n');
    await mountArticle(crlf);
    // Offsets du document : une fin de ligne y vaut 1.
    const at = NOTES.indexOf(' dans le texte');
    placeCursor(at);

    await renumber();
    expect(cursor()).toBe(at);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3400);
    });

    expect(disk[DOC]).toBe(RENUMBERED.replace(/\n/g, '\r\n'));
    undoOnce();
    expect(editor().getLiveContent()).toBe(crlf);
  });

  it('S14-1-12, livre : le chapitre ouvert renuméroté garde le curseur, et le fichier reçoit la frappe là', async () => {
    await mountBook(NOTES);
    const at = NOTES.indexOf(' dans le texte');
    placeCursor(at);

    await renumber();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(disk[CHAPTER]).toBe(RENUMBERED);
    expect(cursor()).toBe(at);
    type('X');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3400);
    });
    expect(disk[CHAPTER]).toBe(`${RENUMBERED.slice(0, at)}X${RENUMBERED.slice(at)}`);
  });
});

describe('renommer le chapitre ouvert : seul le titre change', () => {
  const BODY = '\n\nUn long texte de chapitre, au milieu duquel l’auteur écrit.\n';

  async function rename(title: string): Promise<void> {
    const open = document.querySelector<HTMLButtonElement>('button.chapter-item-open');
    if (!open) throw new Error('Pas de chapitre dans le navigateur');
    fireEvent.doubleClick(open);
    const input = screen.getByPlaceholderText('book.titlePlaceholder');
    fireEvent.change(input, { target: { value: title } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it('S14-1-12 : le curseur reste dans le texte, la frappe suivante aussi, et un Cmd+Z rend le titre', async () => {
    await mountBook(`# Chapitre A${BODY}`);
    const inBody = `# Chapitre A${BODY}`.indexOf(' au milieu');
    placeCursor(inBody);

    await rename('Danzig en 1932');

    const renamed = `# Danzig en 1932${BODY}`;
    expect(docText()).toBe(renamed);
    // Le même endroit du texte : le titre s'est allongé devant lui.
    expect(docText().slice(cursor())).toBe(renamed.slice(renamed.indexOf(' au milieu')));
    type('X');
    expect(docText()).toBe(renamed.replace(' au milieu', 'X au milieu'));

    undoOnce();
    undoOnce();
    expect(docText()).toBe(`# Chapitre A${BODY}`);
  });
});
