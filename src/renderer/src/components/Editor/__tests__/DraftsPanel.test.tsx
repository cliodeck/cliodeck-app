// @vitest-environment jsdom
/**
 * Un brouillon ne quitte la file qu'une fois accepté.
 *
 * « Insérer » le retirait 600 ms après, quelle que soit l'issue : une proposition rejetée,
 * expirée ou invalidée emportait un texte qui n'était plus nulle part. Vraie vue CM6, vraies
 * propositions : les décisions se prennent sur les boutons à l'écran, ou par ce qui les provoque
 * vraiment (frappe, changement de chapitre, de projet, de mode).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent, screen } from '@testing-library/react';
import { EditorSelection, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import { CodeMirrorEditor } from '../CodeMirrorEditor';
import { DraftsPanel } from '../DraftsPanel';
import { resetEditorStates } from '../editor-state-memory';
import { useDraftsStore } from '../../../stores/draftsStore';
import { useEditorStore } from '../../../stores/editorStore';
import { useNotificationStore } from '../../../stores/notificationStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useWorkspaceModeStore, type WorkspaceMode } from '../../../stores/workspaceModeStore';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

const PROJECT = '/p/livre';
const A = `${PROJECT}/chapters/a.md`;
const B = `${PROJECT}/chapters/b.md`;
const OTHER = '/p/autre';
const OTHER_DOC = `${OTHER}/document.md`;
const TEXT_A = '# Chapitre A\n\nTexte du chapitre A.\n';
const DRAFT_ID = 'brouillon-1';
const DRAFT_TEXT = 'TEXTE DU BROUILLON';

let disk: Record<string, string>;

const editor = () => useEditorStore.getState();
const drafts = () => useDraftsStore.getState();
const queued = () => drafts().drafts.map((d) => d.id);

const Workspace: React.FC = () => {
  const mode = useWorkspaceModeStore((s) => s.active);
  const open = useDraftsStore((s) => s.isPanelOpen);
  if (mode !== 'write') return null;
  return (
    <>
      <CodeMirrorEditor />
      {open && <DraftsPanel />}
    </>
  );
};

function currentView(): EditorView {
  const dom = document.querySelector<HTMLElement>('.cm-editor');
  const view = dom && EditorView.findFromDOM(dom);
  if (!view) throw new Error('Pas de vue CM6 montée');
  return view;
}

const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const insertButton = () => screen.getByTitle('drafts.insertTitle') as HTMLButtonElement;
const insert = () => act(() => void fireEvent.click(insertButton()));
const proposalBox = () => document.querySelector<HTMLElement>('.cm-proposal-box');
const proposalButton = (index: number) => {
  const button = proposalBox()?.querySelectorAll('button')[index];
  if (!button) throw new Error('Pas de bouton sur la proposition');
  return button;
};

function expectDraftKeptAndButtonBack(): void {
  expect(queued()).toEqual([DRAFT_ID]);
  expect(insertButton().disabled).toBe(false);
  expect(screen.queryByText('drafts.inserted')).toBeNull();
}

async function switchMode(mode: WorkspaceMode): Promise<void> {
  await act(async () => {
    useWorkspaceModeStore.getState().setActive(mode);
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  resetEditorStates();
  disk = {
    [A]: TEXT_A,
    [B]: '# Chapitre B\n\nTexte du chapitre B.\n',
    [OTHER_DOC]: '# Autre\n',
  };
  const manifest = (root: string) => ({
    id: root,
    name: 'Projet',
    path: root,
    type: 'article',
    createdAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
  });
  (window as unknown as { electron: unknown }).electron = {
    project: {
      getMetadata: vi.fn(async (json: string) => ({ success: true, project: manifest(json.replace('/project.json', '')) })),
      load: vi.fn(async (json: string) => ({ success: true, project: manifest(json.replace('/project.json', '')) })),
      getRecent: vi.fn(async () => []),
      getChapters: vi.fn(async () => ({ success: true, chapters: [], unattached: [] })),
    },
    editor: {
      loadFile: vi.fn(async (path: string) => ({ success: true, content: disk[path] })),
      saveFile: vi.fn(async (path: string, content: string) => {
        disk[path] = content;
        return { success: true };
      }),
      onInsertText: () => () => undefined,
    },
    proposals: { recordAdjudication: () => undefined },
    ipcRenderer: { on: () => undefined, removeListener: () => undefined },
  };
  useProjectStore.setState({
    currentProject: {
      id: 'p1',
      name: 'Livre',
      path: PROJECT,
      type: 'book',
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
    loadState: { kind: 'ready', loadedAt: 'avant', path: PROJECT },
  });
  useEditorStore.setState((s) => ({
    filePath: A,
    content: TEXT_A,
    isDirty: false,
    documentVersion: s.documentVersion + 1,
  }));
  useWorkspaceModeStore.setState({ active: 'write' });
  useNotificationStore.getState().dismissAll();
  useDraftsStore.setState({
    drafts: [
      {
        id: DRAFT_ID,
        content: DRAFT_TEXT,
        createdAt: '2026-11-04T10:00:00Z',
        source: { model: 'm', task: 't' },
      },
    ],
    isPanelOpen: true,
  });
  await act(async () => {
    render(<Workspace />);
  });
  act(() => {
    currentView().dispatch({ selection: EditorSelection.cursor(TEXT_A.length) });
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useEditorStore.setState({ editorFacade: null, filePath: null, content: '', isDirty: false, bufferDetached: false });
  useProjectStore.setState({ currentProject: null, loadState: { kind: 'idle' } });
  useDraftsStore.setState({ drafts: [], isPanelOpen: false });
  useWorkspaceModeStore.setState({ active: 'write' });
});

describe('sans décision', () => {
  it('après 700 ms, le brouillon est toujours dans la file, et le bouton dit « Proposé »', async () => {
    insert();
    expect(proposalBox()).not.toBeNull();

    await wait(700);

    expect(queued()).toEqual([DRAFT_ID]);
    expect(insertButton().disabled).toBe(true);
    expect(screen.getByText('drafts.inserted')).toBeTruthy();
    expect(currentView().state.doc.toString()).toBe(TEXT_A);
  });

  it('le panneau refermé puis rouvert ne propose pas une seconde fois', async () => {
    insert();
    await act(async () => {
      drafts().closePanel();
    });
    await act(async () => {
      drafts().openPanel();
    });

    expect(insertButton().disabled).toBe(true);
  });
});

describe('au redémarrage', () => {
  it('« proposé » ne se persiste pas : la proposition ne survit pas à la fermeture, et le bouton resterait bloqué', async () => {
    insert();
    expect(drafts().proposedIds).toEqual([DRAFT_ID]);

    const persisted = JSON.parse(localStorage.getItem('cliodeck-drafts') ?? '{}') as { state?: object };

    expect(persisted.state).toHaveProperty('drafts');
    expect(persisted.state).not.toHaveProperty('proposedIds');
  });
});

describe('une décision qui fait entrer le texte', () => {
  it('accepté : le brouillon quitte la file', async () => {
    insert();
    act(() => void fireEvent.mouseDown(proposalButton(0)));

    expect(queued()).toEqual([]);
    expect(currentView().state.doc.toString()).toContain(DRAFT_TEXT);
  });

  it('modifié : le brouillon quitte la file', async () => {
    insert();
    act(() => void fireEvent.mouseDown(proposalButton(2)));
    const apply = proposalBox()?.querySelector('button');
    if (!apply) throw new Error('Pas de bouton Appliquer');
    act(() => void fireEvent.mouseDown(apply));

    expect(queued()).toEqual([]);
  });

  it('panneau fermé entre-temps : la décision s’applique quand même', async () => {
    insert();
    await act(async () => {
      drafts().closePanel();
    });
    expect(screen.queryByTitle('drafts.insertTitle')).toBeNull();

    act(() => void fireEvent.mouseDown(proposalButton(0)));

    expect(queued()).toEqual([]);
  });
});

describe('une décision qui laisse le brouillon', () => {
  it('rejeté : il reste, le bouton redevient actif, et rien n’est entré dans le texte', async () => {
    insert();
    act(() => void fireEvent.mouseDown(proposalButton(1)));
    await wait(700);

    expectDraftKeptAndButtonBack();
    expect(currentView().state.doc.toString()).toBe(TEXT_A);
  });

  it('invalidé par une frappe à son ancre : il reste, le bouton redevient actif', async () => {
    insert();
    const view = currentView();
    act(() => {
      view.dispatch({
        changes: { from: TEXT_A.length, insert: 'x' },
        annotations: Transaction.userEvent.of('input.type'),
      });
    });
    await wait(700);

    expect(proposalBox()).toBeNull();
    expectDraftKeptAndButtonBack();
  });

  it('expiré par un changement de chapitre : il reste, le bouton redevient actif', async () => {
    insert();
    await act(async () => {
      await editor().loadFile(B);
    });
    await wait(700);

    expect(editor().filePath).toBe(B);
    expect(proposalBox()).toBeNull();
    expectDraftKeptAndButtonBack();
    expect(disk[A]).toBe(TEXT_A);
  });

  it('expiré par un changement de projet : il reste, et le nouveau projet ne l’a pas retiré', async () => {
    insert();
    await act(async () => {
      await useProjectStore.getState().loadProject(`${OTHER}/project.json`);
    });
    await wait(700);

    expect(editor().filePath).toBe(OTHER_DOC);
    expect(proposalBox()).toBeNull();
    expectDraftKeptAndButtonBack();
    expect(disk[OTHER_DOC]).toBe('# Autre\n');
  });

  it('expiré par un changement de mode : il reste, et le bouton revient actif au retour', async () => {
    insert();
    await switchMode('brainstorm');
    await wait(700);
    expect(queued()).toEqual([DRAFT_ID]);

    await switchMode('write');

    expect(proposalBox()).toBeNull();
    expectDraftKeptAndButtonBack();
  });

  it('un second « Insérer » après un rejet, accepté cette fois : le brouillon part', async () => {
    insert();
    act(() => void fireEvent.mouseDown(proposalButton(1)));
    insert();
    act(() => void fireEvent.mouseDown(proposalButton(0)));

    expect(queued()).toEqual([]);
  });
});

describe('aucun document pour la recevoir', () => {
  it('vue détachée : pas de proposition, le brouillon reste, le bouton aussi, et l’auteur le sait', async () => {
    await act(async () => {
      await editor().replaceBuffer({ kind: 'detach' }, 'project-switch');
    });

    insert();
    await wait(700);

    expect(proposalBox()).toBeNull();
    expectDraftKeptAndButtonBack();
    expect(useNotificationStore.getState().notifications.map((n) => n.title)).toContain('editor.proposalUnavailable');
  });

  it('livre sans chapitre ouvert : pas de proposition dans le tampon, et l’auteur le sait', async () => {
    await act(async () => {
      await editor().replaceBuffer({ kind: 'untitled' }, 'new-document');
    });

    insert();

    expect(proposalBox()).toBeNull();
    expectDraftKeptAndButtonBack();
    expect(useNotificationStore.getState().notifications.map((n) => n.title)).toContain('editor.proposalUnavailable');
  });
});
