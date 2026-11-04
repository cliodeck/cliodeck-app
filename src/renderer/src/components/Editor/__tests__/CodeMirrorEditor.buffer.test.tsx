// @vitest-environment jsdom
/**
 * La vue CM6 face aux remplacements du document.
 *
 * L'appartenance d'une vue se lisait sur le chemin : rouvrir le fichier ouvert
 * changeait le document sous une vue qui se croyait toujours propriétaire, et le
 * premier enregistrement d'un tampon sans titre recréait la vue alors que seul son
 * chemin changeait. Elle se lit désormais sur `documentVersion`.
 *
 * Vraie vue CM6, vrais navigateur, autosave et stores ; seul le disque est simulé,
 * derrière l'IPC.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { EditorSelection, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo, undoDepth } from '@codemirror/commands';
import type { ResolvedChapter } from '@backend/types/book';
import { DEFAULT_BOOK_SETTINGS } from '@backend/types/book';

import { CodeMirrorEditor } from '../CodeMirrorEditor';
import { resetEditorStates } from '../editor-state-memory';
import { ChapterNavigator } from '../../Book/ChapterNavigator';
import { useAutoSave } from '../../../hooks/useAutoSave';
import { useEditorStore } from '../../../stores/editorStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useDialogStore } from '../../../stores/dialogStore';

const PROJECT = '/p/livre';
const A = `${PROJECT}/chapters/a.md`;
const B = `${PROJECT}/chapters/b.md`;
const TEXT_A = '# Chapitre A\n\nTexte du chapitre A.\n';
const TEXT_B = '# Chapitre B\n\nTexte du chapitre B.\n';
const PHRASE = ' Une phrase tapée.';

let disk: Record<string, string>;
let writes: Array<[string, string]>;
let beforeWrite: () => Promise<void> | void;
let adjudications: Array<{ decision: string; filePath?: string }>;

function chapterOf(id: string): ResolvedChapter {
  return { id, title: `Chapitre ${id}`, filePath: `chapters/${id}.md`, order: 0, kind: 'chapter' };
}

const AutoSaved: React.FC = () => {
  useAutoSave();
  return null;
};

function currentView(): EditorView {
  const dom = document.querySelector<HTMLElement>('.cm-editor');
  if (!dom) throw new Error('Pas de vue CM6 montée');
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error('Vue CM6 introuvable');
  return view;
}

/** Une frappe réelle pour CM6 : annotée, au curseur, et entrée dans l'historique. */
function type(view: EditorView, text: string): void {
  const head = view.state.selection.main.head;
  view.dispatch({
    changes: { from: head, insert: text },
    selection: EditorSelection.cursor(head + text.length),
    annotations: Transaction.userEvent.of('input.type'),
  });
}

function placeCursorAtEnd(view: EditorView): void {
  view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
}

const text = (view: EditorView) => view.state.doc.toString();
const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

async function mountBook(open: string = A): Promise<void> {
  useProjectStore.setState({
    currentProject: {
      id: 'p1',
      name: 'Livre',
      path: PROJECT,
      type: 'book',
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
    chapters: [chapterOf('a'), chapterOf('b')],
    currentChapterId: open === A ? 'a' : 'b',
    bookSettings: { ...DEFAULT_BOOK_SETTINGS },
    loadState: { kind: 'ready', loadedAt: 'avant', path: PROJECT },
  });
  useEditorStore.setState((s) => ({
    filePath: open,
    content: disk[open],
    isDirty: false,
    lastSavedAt: null,
    documentVersion: s.documentVersion + 1,
  }));
  await act(async () => {
    render(
      <>
        <AutoSaved />
        <ChapterNavigator />
        <CodeMirrorEditor />
      </>
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetEditorStates();
  disk = { [A]: TEXT_A, [B]: TEXT_B };
  writes = [];
  beforeWrite = () => undefined;
  adjudications = [];
  (window as unknown as { electron: unknown }).electron = {
    project: {
      readChapters: vi.fn(async (data: { filePaths: string[] }) => ({
        success: true,
        files: data.filePaths.map((filePath) => ({
          filePath,
          content: disk[`${PROJECT}/${filePath}`],
        })),
      })),
      getChapters: vi.fn(async () => ({ success: true, chapters: [], unattached: [] })),
    },
    editor: {
      loadFile: vi.fn(async (path: string) => ({ success: true, content: disk[path] })),
      saveFile: vi.fn(async (path: string, content: string) => {
        await beforeWrite();
        writes.push([path, content]);
        disk[path] = content;
        return { success: true };
      }),
      onInsertText: () => () => undefined,
    },
    proposals: {
      recordAdjudication: (event: { decision: string; filePath?: string }) => {
        adjudications.push(event);
      },
    },
    ipcRenderer: { on: () => undefined, removeListener: () => undefined },
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useEditorStore.setState({ editorFacade: null, switchLock: null, bufferDetached: false } as never);
  useProjectStore.setState({ currentProject: null, chapters: [], currentChapterId: null });
  while (useDialogStore.getState().confirmOpen) useDialogStore.getState().resolveConfirm(false);
  while (useDialogStore.getState().alertOpen) useDialogStore.getState().closeAlert();
});

describe('cliquer sur le chapitre déjà ouvert', () => {
  it('garde la frappe, la vue et l’annulation (plus de 300 ms après la frappe)', async () => {
    await mountBook();
    const view = currentView();
    placeCursorAtEnd(view);
    type(view, PHRASE);
    await wait(1000);

    await act(async () => {
      fireEvent.click(screen.getByText('Chapitre a'));
    });

    expect(currentView()).toBe(view);
    expect(text(currentView())).toContain(PHRASE);
    expect(useEditorStore.getState().isDirty).toBe(true);
    expect(undoDepth(currentView().state)).toBeGreaterThan(0);
    expect(undo(currentView())).toBe(true);
    expect(text(currentView())).not.toContain(PHRASE);
  });

  it('laisse l’autosave écrire la frappe ensuite', async () => {
    await mountBook();
    const view = currentView();
    placeCursorAtEnd(view);
    type(view, PHRASE);
    await wait(1000);

    await act(async () => {
      fireEvent.click(screen.getByText('Chapitre a'));
    });
    await wait(3100);

    expect(disk[A]).toContain(PHRASE);
  });
});

describe('frappe de moins de 300 ms puis bascule (piège de 285380c)', () => {
  it('le fichier B ne reçoit aucun texte de A, et A reçoit sa frappe', async () => {
    await mountBook();
    const view = currentView();
    placeCursorAtEnd(view);
    type(view, PHRASE);
    await wait(100);

    await act(async () => {
      fireEvent.click(screen.getByText('Chapitre b'));
    });
    await wait(3500);

    expect(disk[A]).toBe(`${TEXT_A}${PHRASE}`);
    expect(disk[B]).toBe(TEXT_B);
    expect(useEditorStore.getState().filePath).toBe(B);
    expect(useEditorStore.getState().content).toBe(TEXT_B);
    expect(text(currentView())).toBe(TEXT_B);
  });

  it('frappe dans le second chapitre, puis retour : chacun garde son texte et A son annulation', async () => {
    await mountBook();
    placeCursorAtEnd(currentView());
    type(currentView(), PHRASE);

    await act(async () => {
      fireEvent.click(screen.getByText('Chapitre b'));
    });
    placeCursorAtEnd(currentView());
    type(currentView(), ' Dans B.');
    await wait(3500);
    expect(disk[B]).toBe(`${TEXT_B} Dans B.`);
    expect(disk[A]).toBe(`${TEXT_A}${PHRASE}`);

    await act(async () => {
      fireEvent.click(screen.getByText('Chapitre a'));
    });

    expect(text(currentView())).toBe(`${TEXT_A}${PHRASE}`);
    expect(undo(currentView())).toBe(true);
    expect(text(currentView())).toBe(TEXT_A);
  });
});

describe('nouveau tampon, puis retour au chapitre', () => {
  it('la frappe est écrite et l’annulation restaurée', async () => {
    await mountBook();
    placeCursorAtEnd(currentView());
    type(currentView(), PHRASE);
    await wait(1000);

    await act(async () => {
      await useEditorStore.getState().createNewFile();
    });
    expect(disk[A]).toBe(`${TEXT_A}${PHRASE}`);
    expect(text(currentView())).toBe('');
    expect(useEditorStore.getState().filePath).toBeNull();

    await act(async () => {
      await useEditorStore.getState().loadFile(A);
    });

    expect(text(currentView())).toBe(`${TEXT_A}${PHRASE}`);
    expect(undo(currentView())).toBe(true);
    expect(text(currentView())).toBe(TEXT_A);
  });
});

describe('premier enregistrement d’un tampon sans titre', () => {
  const NEW_PATH = '/ailleurs/images/note.md';

  async function untitledWithPage(page: string): Promise<EditorView> {
    await mountBook();
    await act(async () => {
      await useEditorStore.getState().createNewFile();
    });
    const view = currentView();
    type(view, page);
    return view;
  }

  it('même vue, même curseur, annulation possible, aucune proposition expirée', async () => {
    const view = await untitledWithPage('Première ligne.\n\nSeconde ligne.');
    view.dispatch({ selection: EditorSelection.cursor(5) });
    const proposal = (
      window as unknown as {
        __cliodeckProposals: { inject: (p: Record<string, unknown>) => { id: string } };
      }
    ).__cliodeckProposals.inject({
      range: { from: 0, to: 0 },
      original: '',
      proposed: 'Proposition.',
      category: 'ai-insert',
      source: { model: 'm', task: 't' },
    });
    expect(proposal.id).toBeTruthy();
    adjudications.length = 0;

    await act(async () => {
      await useEditorStore.getState().saveFileAs(NEW_PATH);
    });
    await wait(0);

    expect(useEditorStore.getState().filePath).toBe(NEW_PATH);
    expect(currentView()).toBe(view);
    expect(view.state.selection.main.head).toBe(5);
    expect(undoDepth(view.state)).toBeGreaterThan(0);
    expect(adjudications.filter((e) => e.decision === 'expired')).toEqual([]);
  });

  it('la page garde son cache sous le nouveau chemin : le retour restaure l’annulation', async () => {
    const page = 'Une page.';
    await untitledWithPage(page);
    await act(async () => {
      await useEditorStore.getState().saveFileAs(NEW_PATH);
    });

    await act(async () => {
      await useEditorStore.getState().loadFile(B);
    });
    await act(async () => {
      await useEditorStore.getState().loadFile(NEW_PATH);
    });

    expect(text(currentView())).toBe(page);
    expect(undo(currentView())).toBe(true);
    expect(text(currentView())).toBe('');
  });

  it('une image relative se résout dès que le tampon a un chemin', async () => {
    await untitledWithPage('![carte](carte.png)\n\nSuite.');
    await wait(0);
    expect(document.querySelector('.cm-live-image img')).toBeNull();
    expect(document.querySelector('.cm-live-image-missing')).not.toBeNull();

    await act(async () => {
      await useEditorStore.getState().saveFileAs(NEW_PATH);
    });
    await wait(0);

    expect(document.querySelector<HTMLImageElement>('.cm-live-image img')?.src).toBe(
      'file:///ailleurs/images/carte.png'
    );
  });

  it('une proposition décidée après l’enregistrement est rattachée au nouveau chemin', async () => {
    const view = await untitledWithPage('Une page.');
    (
      window as unknown as {
        __cliodeckProposals: { inject: (p: Record<string, unknown>) => { id: string } };
      }
    ).__cliodeckProposals.inject({
      range: { from: 0, to: 0 },
      original: '',
      proposed: 'Proposition.',
      category: 'ai-insert',
      source: { model: 'm', task: 't' },
    });
    await act(async () => {
      await useEditorStore.getState().saveFileAs(NEW_PATH);
    });
    adjudications.length = 0;

    await act(async () => {
      await useEditorStore.getState().loadFile(B);
    });

    expect(view).not.toBe(currentView());
    expect(adjudications.find((e) => e.decision === 'expired')?.filePath).toBe(NEW_PATH);
  });
});

describe('une vue qui n’est plus propriétaire n’écrit jamais dans le store', () => {
  it('dès la validation, le texte vivant est celui du document entrant', async () => {
    await mountBook();
    const seen: string[] = [];
    const unsubscribe = useEditorStore.subscribe((state, previous) => {
      if (state.documentVersion !== previous.documentVersion) seen.push(state.getLiveContent());
    });

    await act(async () => {
      await useEditorStore.getState().loadFile(B);
    });
    unsubscribe();

    expect(seen).toEqual([TEXT_B]);
  });

  it('une transaction tombée entre le remplacement et la destruction ne salit pas le suivant', async () => {
    await mountBook();
    const view = currentView();

    // Pas d'`act` : la vue ne sera détruite qu'au commit React suivant.
    useEditorStore.setState((s) => ({
      filePath: B,
      content: TEXT_B,
      isDirty: false,
      documentVersion: s.documentVersion + 1,
    }));
    placeCursorAtEnd(view);
    type(view, PHRASE);
    expect(useEditorStore.getState().isDirty).toBe(false);

    await wait(400);
    expect(useEditorStore.getState().content).toBe(TEXT_B);
    expect(useEditorStore.getState().isDirty).toBe(false);
  });

  it('une synchro échue avant la destruction ne touche pas au miroir du suivant', async () => {
    await mountBook();
    const view = currentView();
    placeCursorAtEnd(view);
    type(view, PHRASE);

    // Sans `act` ni attente : le minuteur tombe avant le commit React.
    useEditorStore.setState((s) => ({
      filePath: B,
      content: TEXT_B,
      isDirty: false,
      documentVersion: s.documentVersion + 1,
    }));
    vi.advanceTimersByTime(400);

    expect(useEditorStore.getState().content).toBe(TEXT_B);
    expect(useEditorStore.getState().isDirty).toBe(false);
  });

  it('même chemin, nouvelle version : la synchro en attente ne recouvre pas le disque', async () => {
    await mountBook();
    const view = currentView();
    placeCursorAtEnd(view);
    type(view, PHRASE);
    const reloaded = '# Chapitre A relu\n';

    await act(async () => {
      useEditorStore.setState((s) => ({
        content: reloaded,
        isDirty: false,
        documentVersion: s.documentVersion + 1,
      }));
    });
    await wait(400);

    expect(useEditorStore.getState().content).toBe(reloaded);
    expect(useEditorStore.getState().isDirty).toBe(false);
    expect(text(currentView())).toBe(reloaded);
  });
});

describe('la synchro ne repose pas isDirty après une sauvegarde', () => {
  it('écriture avant la synchro différée : le document reste propre', async () => {
    await mountBook();
    const view = currentView();
    placeCursorAtEnd(view);
    type(view, PHRASE);
    await act(async () => {
      await useEditorStore.getState().saveFile();
    });
    expect(useEditorStore.getState().isDirty).toBe(false);

    await wait(400);

    expect(useEditorStore.getState().content).toBe(`${TEXT_A}${PHRASE}`);
    expect(useEditorStore.getState().isDirty).toBe(false);
  });

  it('témoin : une frappe qui suit la sauvegarde remet bien le document à écrire', async () => {
    await mountBook();
    const view = currentView();
    placeCursorAtEnd(view);
    type(view, PHRASE);
    await act(async () => {
      await useEditorStore.getState().saveFile();
    });

    type(view, ' Encore.');
    await wait(400);

    expect(useEditorStore.getState().content).toBe(`${TEXT_A}${PHRASE} Encore.`);
    expect(useEditorStore.getState().isDirty).toBe(true);
  });

  it('frappe pendant l’écriture : la synchro remet le document à écrire, et l’autosave le fait', async () => {
    await mountBook();
    const view = currentView();
    placeCursorAtEnd(view);
    type(view, PHRASE);
    let release: () => void = () => undefined;
    beforeWrite = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const saving = useEditorStore.getState().saveFile();

    type(view, ' Pendant l’écriture.');
    beforeWrite = () => undefined;
    await act(async () => {
      release();
      await saving;
    });
    await wait(400);

    expect(useEditorStore.getState().isDirty).toBe(true);
    await wait(3100);
    expect(disk[A]).toBe(`${TEXT_A}${PHRASE} Pendant l’écriture.`);
  });

  it('témoin : la frappe suit le miroir, plan et statistiques ne se figent pas', async () => {
    await mountBook();
    const view = currentView();
    placeCursorAtEnd(view);
    type(view, PHRASE);
    expect(useEditorStore.getState().content).toBe(TEXT_A);

    await wait(400);

    expect(useEditorStore.getState().content).toBe(`${TEXT_A}${PHRASE}`);
  });
});

describe('vue détachée, le temps d’un changement de projet', () => {
  it('est en lecture seule, n’est pas mise en cache, et la suivante redevient éditable', async () => {
    await mountBook();
    const view = currentView();
    placeCursorAtEnd(view);
    type(view, PHRASE);

    await act(async () => {
      await useEditorStore.getState().replaceBuffer({ kind: 'detach' }, 'project-switch');
    });

    const detached = currentView();
    expect(detached).not.toBe(view);
    expect(detached.state.readOnly).toBe(true);
    expect(detached.contentDOM.getAttribute('contenteditable')).toBe('false');
    expect(disk[A]).toBe(`${TEXT_A}${PHRASE}`);

    await act(async () => {
      await useEditorStore.getState().replaceBuffer({ kind: 'open', filePath: A }, 'project-restore');
    });

    expect(currentView().state.readOnly).toBe(false);
    expect(currentView().contentDOM.getAttribute('contenteditable')).toBe('true');
    expect(text(currentView())).toBe(`${TEXT_A}${PHRASE}`);
    expect(undo(currentView())).toBe(true);
  });

  it('dit ce qui se passe : l’auteur ne tape pas dans le vide sans le savoir', async () => {
    await mountBook();

    await act(async () => {
      await useEditorStore.getState().replaceBuffer({ kind: 'detach' }, 'project-switch');
    });

    expect(currentView().contentDOM.textContent).toContain('project.loading');

    await act(async () => {
      await useEditorStore.getState().replaceBuffer({ kind: 'open', filePath: B }, 'project-open');
    });

    expect(currentView().contentDOM.textContent).not.toContain('project.loading');
  });

  it('une insertion par programme n’y entre pas : la lecture seule ne protège que du clavier', async () => {
    await mountBook();
    await act(async () => {
      await useEditorStore.getState().replaceBuffer({ kind: 'detach' }, 'project-switch');
    });

    await act(async () => {
      useEditorStore.getState().editorFacade?.replaceSelection('[@cle]');
    });
    await wait(400);

    expect(text(currentView())).toBe('');
    expect(useEditorStore.getState().content).toBe('');
    expect(useEditorStore.getState().isDirty).toBe(false);
  });
});
