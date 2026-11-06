// @vitest-environment jsdom
/**
 * L'autosave vit au-dessus du panneau d'écriture.
 *
 * Monté dans EditorPanel, il mourait avec lui : la frappe des dernières secondes attendait le retour
 * en Écriture ou la fermeture, le message d'échec s'effaçait au changement de mode sans que rien soit
 * écrit, et un panneau planté n'écrivait plus rien. Maintenant qu'aucune commande n'ajoute plus de
 * gabarit au miroir, ce qu'il y trouve est bien le texte de l'auteur.
 *
 * Vrais App, EditorPanel, vue CM6, autosave et stores ; le disque est simulé derrière l'IPC, et
 * MainLayout réduit à ce qui compte ici : le panneau d'écriture n'est monté qu'en mode Écriture. Le
 * vrai est joué dans le parcours e2e.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent, screen } from '@testing-library/react';
import { EditorSelection, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { ResolvedChapter } from '@backend/types/book';
import { DEFAULT_BOOK_SETTINGS } from '@backend/types/book';

import App from '../App';
import { resetEditorStates } from '../components/Editor/editor-state-memory';
import { flushOpenDocument } from '../hooks/useSaveOnQuit';
import { useDialogStore } from '../stores/dialogStore';
import { useEditorStore } from '../stores/editorStore';
import { useManuscriptStore } from '../stores/manuscriptStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useProjectStore } from '../stores/projectStore';
import { useWorkspaceModeStore, type WorkspaceMode } from '../stores/workspaceModeStore';

const counts = vi.hoisted(() => ({ layout: 0, center: 0, crash: false }));

vi.mock('../components/Layout/MainLayout', async () => {
  const { Profiler } = await import('react');
  const { useWorkspaceModeStore: modes } = await import('../stores/workspaceModeStore');
  const Bomb = (): null => {
    if (counts.crash) throw new Error('Plantage du panneau');
    return null;
  };
  const MainLayout = ({ centerPanel }: { centerPanel: React.ReactNode }): React.ReactElement => {
    counts.layout += 1;
    const active = modes((s) => s.active);
    return (
      <>
        <Bomb />
        {active === 'write' ? (
          <Profiler
            id="center"
            onRender={() => {
              counts.center += 1;
            }}
          >
            {centerPanel}
          </Profiler>
        ) : (
          <textarea aria-label="saisie du chat" />
        )}
      </>
    );
  };
  return { MainLayout };
});

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

const PROJECT = '/p/article';
const DOC = `${PROJECT}/document.md`;
const OTHER = `${PROJECT}/autre.md`;
const TEXT = '# Article\n\nHuit mille mots.\n';
const PHRASE = 'Une frappe.';
const TYPED = `${TEXT}${PHRASE}`;
const DELAY = 3000;

type WriteVerdict = { success: boolean; error?: string };

let disk: Record<string, string>;
let writes: Array<[string, string]>;
/** Ce que fait le disque à chaque écriture : réponse immédiate par défaut. */
let onWrite: () => Promise<WriteVerdict>;

const healthy = async (): Promise<WriteVerdict> => ({ success: true });
const diskFull = async (): Promise<WriteVerdict> => ({ success: false, error: 'ENOSPC: no space left on device' });

const editor = () => useEditorStore.getState();
const toasts = () => useNotificationStore.getState().notifications;

function hold(): { wait: () => Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait: () => held, release };
}

function currentView(): EditorView {
  const dom = document.querySelector<HTMLElement>('.cm-editor');
  const view = dom && EditorView.findFromDOM(dom);
  if (!view) throw new Error('Pas de vue CM6 montée');
  return view;
}

function typeAtEnd(typed: string): void {
  const view = currentView();
  const at = view.state.doc.length;
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

async function mountApp(): Promise<void> {
  await act(async () => {
    render(<App />);
  });
  await wait(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetEditorStates();
  counts.layout = 0;
  counts.center = 0;
  counts.crash = false;
  disk = { [DOC]: TEXT, [OTHER]: '# Autre\n' };
  writes = [];
  onWrite = healthy;
  (window as unknown as { electron: unknown }).electron = {
    config: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
    project: {
      getChapters: vi.fn(async () => ({ success: true, chapters: [], unattached: [] })),
    },
    editor: {
      loadFile: vi.fn(async (path: string) => ({ success: true, content: disk[path] })),
      saveFile: vi.fn(async (path: string, content: string) => {
        writes.push([path, content]);
        const verdict = await onWrite();
        if (verdict.success) disk[path] = content;
        return verdict;
      }),
      onInsertText: () => () => undefined,
    },
    lifecycle: { onFlushBeforeQuit: () => () => undefined, flushDone: () => undefined },
    pdf: { getAllDocuments: vi.fn(async () => ({ success: true, documents: [] })) },
    proposals: { recordAdjudication: () => undefined },
    ipcRenderer: { on: () => () => undefined },
  };
  useProjectStore.setState({
    currentProject: {
      id: 'p1',
      name: 'Projet',
      path: PROJECT,
      type: 'article',
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
    chapters: [],
    loadState: { kind: 'ready', loadedAt: 'avant', path: PROJECT },
  });
  useWorkspaceModeStore.setState({ active: 'write' });
  useNotificationStore.getState().dismissAll();
  useEditorStore.setState((s) => ({
    filePath: DOC,
    content: TEXT,
    isDirty: false,
    lastSavedAt: null,
    documentVersion: s.documentVersion + 1,
    editorFacade: null,
    bufferDetached: false,
    switchLock: null,
    settings: { ...s.settings, autoSave: true, autoSaveDelay: DELAY },
  }));
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
  useNotificationStore.getState().dismissAll();
  while (useDialogStore.getState().alertOpen) useDialogStore.getState().closeAlert();
});

describe('la frappe juste avant de quitter le mode Écriture', () => {
  it('part sur le disque sans revenir en Écriture, synchro différée comprise', async () => {
    await mountApp();
    typeAtEnd(PHRASE);
    expect(editor().content).toBe(TEXT);

    await switchMode('brainstorm');
    expect(document.querySelector('.cm-editor')).toBeNull();
    expect(writes).toEqual([]);

    await wait(DELAY);

    expect(writes).toEqual([[DOC, TYPED]]);
    expect(disk[DOC]).toBe(TYPED);
    expect(editor().isDirty).toBe(false);
  });

  it('une seule écriture, et au retour en Écriture le texte et son annulation sont là', async () => {
    await mountApp();
    typeAtEnd(PHRASE);
    await switchMode('explore');
    await wait(DELAY * 4);
    await switchMode('write');
    await wait(DELAY * 4);

    expect(writes).toEqual([[DOC, TYPED]]);
    expect(currentView().state.doc.toString()).toBe(TYPED);
    expect(editor().isDirty).toBe(false);
  });

  it('témoin : sans frappe, passer d’un mode à l’autre n’écrit rien', async () => {
    await mountApp();
    await switchMode('brainstorm');
    await wait(DELAY * 4);
    await switchMode('write');
    await wait(DELAY * 4);

    expect(writes).toEqual([]);
  });

  it('autosave coupé dans les réglages : rien ne part tout seul, et la fermeture écrit', async () => {
    useEditorStore.setState((s) => ({ settings: { ...s.settings, autoSave: false } }));
    await mountApp();
    typeAtEnd(PHRASE);
    await switchMode('brainstorm');
    await wait(DELAY * 4);
    expect(writes).toEqual([]);

    await act(async () => {
      expect((await flushOpenDocument()).outcome).toBe('saved');
    });
    expect(disk[DOC]).toBe(TYPED);
  });
});

describe('le message d’échec', () => {
  async function failingBeforeBrainstorm(): Promise<void> {
    onWrite = diskFull;
    await mountApp();
    typeAtEnd(PHRASE);
    await wait(DELAY);
    expect(toasts()).toHaveLength(1);
  }

  it('survit au changement de mode : le texte n’est toujours pas écrit', async () => {
    await failingBeforeBrainstorm();

    await switchMode('brainstorm');

    expect(toasts()).toHaveLength(1);
    expect(editor().isDirty).toBe(true);
  });

  it('les essais continuent hors du mode Écriture, un seul message', async () => {
    await failingBeforeBrainstorm();
    const before = writes.length;

    await switchMode('brainstorm');
    await wait(DELAY * 16);

    expect(writes.length).toBeGreaterThan(before);
    expect(new Set(writes.map(([, text]) => text))).toEqual(new Set([TYPED]));
    expect(toasts()).toHaveLength(1);
  });

  it('s’en va à la réussite suivante, même hors du mode Écriture', async () => {
    await failingBeforeBrainstorm();
    await switchMode('brainstorm');

    onWrite = healthy;
    await wait(DELAY * 2);

    expect(disk[DOC]).toBe(TYPED);
    expect(toasts()).toEqual([]);
    expect(editor().isDirty).toBe(false);
  });

  it('s’en va au changement de document', async () => {
    await failingBeforeBrainstorm();
    await switchMode('brainstorm');

    onWrite = healthy;
    await act(async () => {
      await editor().loadFile(OTHER);
    });

    expect(disk[DOC]).toBe(TYPED);
    expect(editor().filePath).toBe(OTHER);
    expect(toasts()).toEqual([]);
  });

  it('une panne qui commence hors du mode Écriture se dit aussi', async () => {
    onWrite = diskFull;
    await mountApp();
    typeAtEnd(PHRASE);
    await switchMode('brainstorm');
    expect(toasts()).toEqual([]);

    await wait(DELAY);

    expect(toasts()).toHaveLength(1);
    expect(editor().isDirty).toBe(true);
  });
});

describe('là où l’autosave ne doit pas écrire', () => {
  it('sous le verrou d’une renumérotation, en Brainstorm : rien tant qu’il tient, puis le texte part', async () => {
    await mountApp();
    typeAtEnd(PHRASE);
    await switchMode('brainstorm');
    act(() => editor().setSwitchLock('book.renumberInProgress'));

    await wait(DELAY * 4);
    expect(writes).toEqual([]);

    act(() => editor().setSwitchLock(null));
    await wait(DELAY);

    expect(writes).toEqual([[DOC, TYPED]]);
  });

  it('sous le verrou, en Écriture : pareil', async () => {
    await mountApp();
    typeAtEnd(PHRASE);
    act(() => editor().setSwitchLock('book.renumberInProgress'));

    await wait(DELAY * 4);
    expect(writes).toEqual([]);

    act(() => editor().setSwitchLock(null));
    await wait(DELAY);

    expect(writes).toEqual([[DOC, TYPED]]);
  });

  it('le verrou tombe pendant le délai : le minuteur armé ne part pas sous lui', async () => {
    await mountApp();
    typeAtEnd(PHRASE);
    await wait(DELAY - 100);
    act(() => editor().setSwitchLock('book.renumberInProgress'));

    await wait(200);

    expect(writes).toEqual([]);
    act(() => editor().setSwitchLock(null));
  });

  it('le minuteur tombe avant que React ait vu le verrou : il ne part pas non plus', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await mountApp();
    typeAtEnd(PHRASE);
    await wait(DELAY - 100);

    // Hors de `act`, et sans laisser passer de microtâche : aucun rendu, aucun effet n'a eu lieu.
    useEditorStore.setState({ switchLock: 'book.renumberInProgress' });
    vi.advanceTimersByTime(200);

    expect(writes).toEqual([]);
    consoleError.mockRestore();
    act(() => editor().setSwitchLock(null));
  });

  it('un changement de projet commencé en Brainstorm : la porte écrit le sortant, puis plus rien', async () => {
    await mountApp();
    typeAtEnd(PHRASE);
    await switchMode('brainstorm');

    await act(async () => {
      await editor().replaceBuffer({ kind: 'detach' }, 'project-switch');
    });
    expect(writes).toEqual([[DOC, TYPED]]);
    expect(editor().bufferDetached).toBe(true);

    await wait(DELAY * 4);

    expect(writes).toEqual([[DOC, TYPED]]);
    expect(editor().isDirty).toBe(false);
  });
});

// L'autosave survit au panneau : l'auteur qui quitte le mode Écriture en pleine renumérotation laisse
// un chapitre ouvert sans vue, dont le texte passe par le miroir (`setContent`).
describe('l’auteur quitte le mode Écriture en pleine renumérotation', () => {
  const chapterPath = (name: string) => `${PROJECT}/chapters/${name}.md`;
  const A = chapterPath('a');
  const B = chapterPath('b');
  const DISORDERED = {
    [A]: '# A\n\nTexte A[^2] suite[^3].\n\n[^2]: une\n\n[^3]: deux\n',
    [B]: '# B\n\nTexte B[^7].\n\n[^7]: trois\n',
  };
  const RENUMBERED_A = '# A\n\nTexte A[^1] suite[^2].\n\n[^1]: une\n\n[^2]: deux\n';
  const RENUMBERED_B = '# B\n\nTexte B[^3].\n\n[^3]: trois\n';
  const lockHeld = () => editor().switchLock;

  function chapterOf(name: string, order: number): ResolvedChapter {
    return { id: name, title: name, filePath: `chapters/${name}.md`, order, kind: 'chapter' };
  }

  /** Renuméroter, la première écriture de `path` retenue, puis passer en Brainstorm. */
  async function leaveWhileWriting(path: string, verdict: WriteVerdict): Promise<() => Promise<void>> {
    disk = { ...DISORDERED };
    const electron = window.electron as unknown as { project: Record<string, unknown> };
    electron.project.readChapters = vi.fn(async (data: { filePaths: string[] }) => ({
      success: true,
      files: data.filePaths.map((filePath) => ({ filePath, content: disk[`${PROJECT}/${filePath}`] })),
    }));
    useProjectStore.setState((s) => ({
      currentProject: s.currentProject ? { ...s.currentProject, type: 'book' } : null,
      chapters: [chapterOf('a', 0), chapterOf('b', 1)],
      bookSettings: { ...DEFAULT_BOOK_SETTINGS },
      currentChapterId: 'a',
    }));
    useEditorStore.setState((s) => ({
      filePath: A,
      content: DISORDERED[A],
      documentVersion: s.documentVersion + 1,
    }));
    await mountApp();

    const stuck = hold();
    onWrite = async () => {
      if (writes.at(-1)?.[0] !== path) return { success: true };
      onWrite = healthy;
      await stuck.wait();
      return verdict;
    };
    await act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.renumberFootnotes'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(lockHeld()).toBe('book.renumberInProgress');
    await switchMode('brainstorm');
    expect(editor().editorFacade).toBeNull();

    return () =>
      act(async () => {
        stuck.release();
        await vi.advanceTimersByTimeAsync(0);
      });
  }

  afterEach(() => {
    useManuscriptStore.setState({ renumbering: false });
  });

  it('une écriture par chapitre, rien de plus pendant le verrou, ni après', async () => {
    const finish = await leaveWhileWriting(A, { success: true });
    expect(writes).toEqual([[A, RENUMBERED_A]]);
    expect(editor().content).toBe(RENUMBERED_A);

    await wait(DELAY * 4);
    expect(writes).toEqual([[A, RENUMBERED_A]]);

    await finish();

    expect(lockHeld()).toBeNull();
    expect(disk[A]).toBe(RENUMBERED_A);
    expect(disk[B]).toBe(RENUMBERED_B);

    await wait(DELAY * 4);
    expect(writes).toEqual([
      [A, RENUMBERED_A],
      [B, RENUMBERED_B],
    ]);
    expect(editor().isDirty).toBe(false);
  });

  it('un chapitre refusé plus loin : la remise en état passe par le miroir, et l’autosave ne la devance pas', async () => {
    const finish = await leaveWhileWriting(B, { success: false, error: 'refusé' });
    expect(writes.map(([path]) => path)).toEqual([A, B]);

    // Le texte renuméroté de A est dans le miroir, et rien ne doit l'écrire de nouveau.
    await wait(DELAY * 4);
    expect(writes.map(([path]) => path)).toEqual([A, B]);

    await finish();

    expect(lockHeld()).toBeNull();
    expect(disk[A]).toBe(DISORDERED[A]);
    expect(disk[B]).toBe(DISORDERED[B]);
    expect(editor().content).toBe(DISORDERED[A]);

    const settled = writes.length;
    await wait(DELAY * 4);
    expect(writes).toHaveLength(settled);
    expect(disk[A]).toBe(DISORDERED[A]);
    expect(toasts()).toEqual([]);
  });
});

// Suivi de #193 : l'autosave part pendant l'écriture de la porte, et le main, qui a déjà basculé, le
// refuse. Ce refus ne parle pas du texte de l'auteur, qui est sur le disque.
describe('un autosave en vol quand le projet change', () => {
  async function inFlightWhenDetached(verdict: WriteVerdict): Promise<void> {
    await mountApp();
    const autosave = hold();
    onWrite = async () => {
      await autosave.wait();
      return verdict;
    };
    typeAtEnd(PHRASE);
    await wait(DELAY);
    expect(writes).toEqual([[DOC, TYPED]]);

    onWrite = healthy;
    await act(async () => {
      await editor().replaceBuffer({ kind: 'detach' }, 'project-switch');
    });
    expect(editor().bufferDetached).toBe(true);

    await act(async () => {
      autosave.release();
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it('refusé par le main après le détachement : aucun faux « enregistrement en échec »', async () => {
    await inFlightWhenDetached({ success: false, error: 'Chemin hors du projet courant' });

    expect(toasts()).toEqual([]);
    expect(useDialogStore.getState().alertOpen).toBe(false);
    await wait(DELAY * 4);
    expect(toasts()).toEqual([]);
    expect(writes.at(-1)).toEqual([DOC, TYPED]);
  });

  it('témoin : le même refus sans changement de projet se dit', async () => {
    onWrite = async () => ({ success: false, error: 'Chemin hors du projet courant' });
    await mountApp();
    typeAtEnd(PHRASE);
    await wait(DELAY);

    expect(toasts()).toHaveLength(1);
  });
});

describe('un panneau d’écriture qui plante', () => {
  async function crash(): Promise<void> {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    counts.crash = true;
    await act(async () => {
      useWorkspaceModeStore.getState().setActive('brainstorm');
      useWorkspaceModeStore.getState().setActive('write');
      useEditorStore.setState((s) => ({ settings: { ...s.settings } }));
    });
    consoleError.mockRestore();
    expect(screen.queryByRole('alert')).not.toBeNull();
    expect(document.querySelector('.cm-editor')).toBeNull();
  }

  it('le texte part quand même, tout seul', async () => {
    await mountApp();
    typeAtEnd(PHRASE);
    await crash();
    expect(writes).toEqual([]);

    await wait(DELAY);

    expect(writes).toEqual([[DOC, TYPED]]);
    expect(editor().isDirty).toBe(false);
  });

  it('« Réessayer » juste après : une écriture, et l’autosave n’en ajoute pas', async () => {
    await mountApp();
    typeAtEnd(PHRASE);
    await crash();

    await act(async () => {
      expect((await flushOpenDocument()).outcome).toBe('saved');
    });
    await wait(DELAY * 4);

    expect(writes).toEqual([[DOC, TYPED]]);
  });

  it('« Réessayer » après l’autosave : rien de plus à écrire', async () => {
    await mountApp();
    typeAtEnd(PHRASE);
    await crash();
    await wait(DELAY);

    await act(async () => {
      expect((await flushOpenDocument()).outcome).toBe('clean');
    });

    expect(writes).toEqual([[DOC, TYPED]]);
  });

  it('« Réessayer » pendant l’écriture de l’autosave : deux écritures du même texte', async () => {
    await mountApp();
    typeAtEnd(PHRASE);
    await crash();
    const autosave = hold();
    onWrite = async () => {
      await autosave.wait();
      return { success: true };
    };
    await wait(DELAY);
    expect(writes).toHaveLength(1);

    onWrite = healthy;
    let report: { outcome: string } | undefined;
    await act(async () => {
      report = await flushOpenDocument();
    });
    await act(async () => {
      autosave.release();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(report?.outcome).toBe('saved');
    expect(new Set(writes.map(([, text]) => text))).toEqual(new Set([TYPED]));
    expect(disk[DOC]).toBe(TYPED);
    expect(editor().isDirty).toBe(false);
  });
});

// Avant ce déplacement : 3 rendus de tout l'arbre (la première frappe, la synchro, l'écriture) et
// 4 du panneau, l'essai terminé relançant le sien. Le hook posé dans App ajoutait un 4e à tout l'arbre.
describe('le nombre de rendus, mesuré en tapant', () => {
  it('une rafale, sa synchro et son écriture : pas un rendu de plus qu’avant', async () => {
    await mountApp();
    counts.layout = 0;
    counts.center = 0;

    for (let keystroke = 0; keystroke < 20; keystroke += 1) {
      typeAtEnd('x');
      await wait(100);
    }
    // La frappe seule ne rend rien de plus que le premier `isDirty` : l'état reste dans CM6.
    expect(counts.layout).toBe(1);
    expect(counts.center).toBe(1);

    // Pas à pas : `act` regroupe les rendus de tout ce qui tombe dans une même attente.
    for (let step = 0; step < 60; step += 1) await wait(100);

    expect(writes).toHaveLength(1);
    expect(counts.layout).toBe(3);
    expect(counts.center).toBe(3);
  });

  // `act` regroupe un essai réussi avec l'écriture du store, selon où tombe la fin de son attente. Un
  // essai en échec ne change rien au store : seul son rendu à lui reste à compter.
  it('un essai terminé ne repasse pas par tout l’arbre', async () => {
    onWrite = diskFull;
    await mountApp();
    typeAtEnd(PHRASE);
    await wait(DELAY - 100);
    counts.layout = 0;
    counts.center = 0;

    await wait(100);
    expect(writes).toHaveLength(1);
    await wait(100);

    expect(toasts()).toHaveLength(1);
    expect(counts.layout).toBe(0);
    expect(counts.center).toBe(0);
  });
});
