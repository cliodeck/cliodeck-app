// @vitest-environment jsdom
/**
 * Les éditions du store sur la façade réelle d'un fichier CRLF, mixte ou LF (S14-1-5, S14-1-24).
 *
 * Le texte du fichier compte deux caractères par fin de ligne CRLF, la vue un : une note calculée
 * sur l'un et posée dans l'autre levait une RangeError, et un brouillon tombait ailleurs qu'au
 * curseur. Un fichier mixte garde ses `\r` comme des caractères : rien ne les réécrit en douce.
 *
 * Vraie vue CM6, vraie façade, vrais stores ; seul le disque est simulé, derrière l'IPC.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { EditorSelection, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { DEFAULT_BOOK_SETTINGS } from '@backend/types/book';

import { CodeMirrorEditor } from '../../components/Editor/CodeMirrorEditor';
import { resetEditorStates } from '../../components/Editor/editor-state-memory';
import { useEditorStore } from '../editorStore';
import { useProjectStore } from '../projectStore';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

const CORPUS = path.resolve(__dirname, '../../../../../test-fixtures/editor');
const fixture = (name: string): string => readFileSync(path.join(CORPUS, name), 'utf-8');

const PROJECT = '/p/article';
const DOC = `${PROJECT}/document.md`;
const LF = 'Un.\n\nDeux.\nTrois.\n\nQuatre.\n';
const CRLF = LF.replace(/\n/g, '\r\n');
const DRAFT = 'Brouillon venu du Brainstorm.';

let saved: string[];

const editor = () => useEditorStore.getState();

function currentView(): EditorView {
  const dom = document.querySelector<HTMLElement>('.cm-editor');
  const view = dom && EditorView.findFromDOM(dom);
  if (!view) throw new Error('Pas de vue CM6 montée');
  return view;
}

const docText = () => currentView().state.doc.toString();

function placeCursor(at: number): void {
  act(() => {
    currentView().dispatch({ selection: EditorSelection.cursor(at) });
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

async function mount(text: string): Promise<void> {
  useEditorStore.setState((s) => ({
    filePath: DOC,
    content: text,
    isDirty: false,
    documentVersion: s.documentVersion + 1,
  }));
  await act(async () => {
    render(<CodeMirrorEditor />);
  });
}

async function save(): Promise<string> {
  await act(async () => {
    await editor().saveFile();
  });
  const written = saved.at(-1);
  if (written === undefined) throw new Error('Rien n’a été écrit');
  return written;
}

beforeEach(() => {
  resetEditorStates();
  saved = [];
  (window as unknown as { electron: unknown }).electron = {
    project: { getChapters: vi.fn(async () => ({ success: true, chapters: [], unattached: [] })) },
    editor: {
      loadFile: vi.fn(async () => ({ success: false, code: 'absent' })),
      saveFile: vi.fn(async (_path: string, content: string) => {
        saved.push(content);
        return { success: true };
      }),
      onInsertText: () => () => undefined,
    },
    pdf: { getAllDocuments: vi.fn(async () => ({ success: true, documents: [] })) },
    proposals: { recordAdjudication: () => undefined },
    ipcRenderer: { on: () => () => undefined },
  };
  useProjectStore.setState({
    currentProject: { id: 'p1', name: 'Projet', path: PROJECT, type: 'article', createdAt: new Date(), lastOpenedAt: new Date() },
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

describe('setValue(getValue()) ne change rien', () => {
  it.each([
    ['CRLF', CRLF],
    ['LF', LF],
    ['mixte', fixture('line-endings-mixed.md')],
    ['CRLF avec un `\\r` isolé', 'Un.\r\nDeux.\rTrois.\r\n'],
  ])('fichier %s : aucune transaction, le texte reste octet pour octet', async (_name, source) => {
    await mount(source);
    const before = currentView().state;

    act(() => editor().editorFacade?.setValue(editor().getLiveContent()));

    expect(currentView().state).toBe(before);
    expect(editor().getLiveContent()).toBe(source);
  });

  it('fichier CRLF : un texte changé ne change que ce qui diffère, et reste CRLF', async () => {
    await mount(CRLF);
    placeCursor(docText().indexOf('Quatre'));

    act(() => editor().editorFacade?.setValue(CRLF.replace('Deux.', 'Deux, revu.')));

    expect(editor().getLiveContent()).toBe(CRLF.replace('Deux.', 'Deux, revu.'));
    expect(currentView().state.selection.main.head).toBe(docText().indexOf('Quatre'));
  });
});

describe('un fichier CRLF', () => {
  it('une note au curseur : pas de RangeError, l’appel au curseur, la définition en fin de fichier', async () => {
    await mount(CRLF);
    const endOfTrois = docText().indexOf('Trois.') + 'Trois.'.length;
    placeCursor(endOfTrois);

    let result: ReturnType<ReturnType<typeof editor>['insertFootnoteAtPosition']> = null;
    act(() => {
      result = editor().insertFootnoteAtPosition(editor().editorFacade?.getCursorOffset() ?? -1);
    });

    expect(result).not.toBeNull();
    expect(await save()).toBe('Un.\r\n\r\nDeux.\r\nTrois.[^1]\r\n\r\nQuatre.\r\n\r\n[^1]: ');
    expect(currentView().state.selection.main.head).toBe(docText().length);
  });

  it('un brouillon au curseur : la proposition attend au curseur, et acceptée, le fichier reste CRLF', async () => {
    await mount(CRLF);
    const endOfTrois = docText().indexOf('Trois.') + 'Trois.'.length;
    placeCursor(endOfTrois);

    act(() => {
      expect(editor().insertDraftAtCursor(DRAFT, { model: 'm', task: 't' }).mode).toBe('cursor');
    });
    expect(editor().editorFacade?.getProposalRanges()).toEqual([{ from: endOfTrois, to: endOfTrois }]);

    const accept = document.querySelector<HTMLButtonElement>('.cm-proposal-box .cm-proposal-btn');
    if (!accept) throw new Error('Aucune proposition à l’écran');
    act(() => {
      accept.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });

    expect(await save()).toBe(`Un.\r\n\r\nDeux.\r\nTrois.\r\n\r\n${DRAFT}\r\n\r\nQuatre.\r\n`);
  });

  it('une saisie de plusieurs lignes : le fichier reste CRLF', async () => {
    await mount(CRLF);
    placeCursor(docText().indexOf('Quatre'));

    type('Trois bis.\n\n');

    expect(await save()).toBe(CRLF.replace('Quatre', 'Trois bis.\r\n\r\nQuatre'));
  });
});

describe('un fichier déjà mixte reste mixte', () => {
  it('une frappe n’y réécrit aucune fin de ligne : ses `\\r` restent où ils sont', async () => {
    const source = fixture('line-endings-mixed.md');
    await mount(source);
    const at = docText().indexOf('\n\n') + 1;
    placeCursor(at);

    type('Ajout.\n');

    expect(await save()).toBe(source.slice(0, at) + 'Ajout.\n' + source.slice(at));
  });

  it('un texte remplacé par la porte y garde ses `\\r` : `applyChanges` ne coupe que sur `\\n`', async () => {
    // Couper le texte inséré sur `\r\n?` aussi (`toDocText`) ferait de ces `\r` des fins de ligne
    // et réécrirait en douce les fins de ligne du passage changé.
    const source = fixture('line-endings-mixed.md');
    const next = source.replace('Ce paragraphe', 'Ajout.\r\n\r\nCe paragraphe');
    expect(next).not.toBe(source);
    await mount(source);

    act(() => editor().editorFacade?.setValue(next));

    expect(docText()).toBe(next);
    expect(await save()).toBe(next);
  });
});
