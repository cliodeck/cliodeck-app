// @vitest-environment jsdom
/**
 * Une présentation en CRLF (S14-1-5) : le navigateur et l'aperçu découpaient le texte du fichier,
 * où une fin de ligne vaut deux caractères, et y cherchaient le curseur de la vue, où elle en vaut
 * un. Plus le curseur descendait, plus la diapositive surlignée restait en arrière.
 *
 * Vraie vue CM6, vrais stores ; seuls le disque et le rendu de l'aperçu sont simulés, derrière l'IPC.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { EditorSelection, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { DEFAULT_BOOK_SETTINGS } from '@backend/types/book';

import { CodeMirrorEditor } from '../../Editor/CodeMirrorEditor';
import { resetEditorStates } from '../../Editor/editor-state-memory';
import { SlideNavigator } from '../SlideNavigator';
import { SlidePreviewPanel } from '../SlidePreviewPanel';
import { useEditorStore } from '../../../stores/editorStore';
import { useProjectStore } from '../../../stores/projectStore';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

const PROJECT = '/p/deck';
const SLIDES = `${PROJECT}/slides.md`;
const DECK = `${['# Une', '# Deux', '# Trois', '# Quatre'].join('\r\n\r\n---\r\n\r\n')}\r\n`;

let getPreviewHtml: ReturnType<typeof vi.fn>;

function currentView(): EditorView {
  const dom = document.querySelector<HTMLElement>('.cm-editor');
  const view = dom && EditorView.findFromDOM(dom);
  if (!view) throw new Error('Pas de vue CM6 montée');
  return view;
}

/** Le curseur dans le titre d'une diapositive, en offsets de la vue. */
function cursorInto(title: string): void {
  const view = currentView();
  const at = view.state.doc.toString().indexOf(title) + 2;
  act(() => {
    view.dispatch({ selection: EditorSelection.cursor(at) });
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

const active = () => document.querySelector('.slide-navigator-item.active .slide-number')?.textContent;

async function mount(panel: 'navigator' | 'preview'): Promise<void> {
  useEditorStore.setState((s) => ({
    filePath: SLIDES,
    content: DECK,
    isDirty: false,
    documentVersion: s.documentVersion + 1,
  }));
  await act(async () => {
    render(
      <>
        <CodeMirrorEditor />
        {panel === 'navigator' ? <SlideNavigator /> : <SlidePreviewPanel />}
      </>
    );
  });
}

beforeEach(() => {
  resetEditorStates();
  getPreviewHtml = vi.fn(async (options: { activeSlideIndex: number }) => ({
    success: true,
    html: `<p>diapositive ${options.activeSlideIndex}</p>`,
  }));
  (window as unknown as { electron: unknown }).electron = {
    project: { getChapters: vi.fn(async () => ({ success: true, chapters: [], unattached: [] })) },
    editor: {
      loadFile: vi.fn(async () => ({ success: true, content: DECK })),
      saveFile: vi.fn(async () => ({ success: true })),
      onInsertText: () => () => undefined,
    },
    slides: { getPreviewHtml },
    pdf: { getAllDocuments: vi.fn(async () => ({ success: true, documents: [] })) },
    proposals: { recordAdjudication: () => undefined },
    ipcRenderer: { on: () => () => undefined },
  };
  useProjectStore.setState({
    currentProject: { id: 'p1', name: 'Deck', path: PROJECT, type: 'presentation', createdAt: new Date(), lastOpenedAt: new Date() },
    bookSettings: { ...DEFAULT_BOOK_SETTINGS },
    chapters: [],
    loadState: { kind: 'ready', loadedAt: 'avant', path: PROJECT },
  });
  useEditorStore.setState({ bufferDetached: false, switchLock: null });
});

afterEach(() => {
  cleanup();
  useEditorStore.setState({ editorFacade: null, filePath: null, content: '', isDirty: false });
  useProjectStore.setState({ currentProject: null, chapters: [], currentChapterId: null, loadState: { kind: 'idle' } });
});

describe('une présentation en CRLF', () => {
  it('le navigateur surligne la diapositive du curseur, jusqu’à la dernière', async () => {
    await mount('navigator');

    cursorInto('# Trois');
    expect(active()).toBe('3');

    cursorInto('# Quatre');
    expect(active()).toBe('4');
  });

  it('après une frappe, le navigateur suit toujours le curseur', async () => {
    await mount('navigator');
    cursorInto('# Une');
    type('x');
    await waitFor(() => expect(useEditorStore.getState().content).toContain('# xUne'));

    cursorInto('# Quatre');
    expect(active()).toBe('4');
  });

  it('l’aperçu rend la diapositive du curseur', async () => {
    await mount('preview');
    await waitFor(() => expect(getPreviewHtml).toHaveBeenCalled());

    cursorInto('# Quatre');

    await waitFor(() => expect(getPreviewHtml.mock.lastCall?.[0].activeSlideIndex).toBe(3));
  });
});
