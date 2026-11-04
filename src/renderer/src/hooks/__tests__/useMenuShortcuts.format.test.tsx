// @vitest-environment jsdom
/**
 * Le menu Édition : Gras, Italique, Lien, Citation, Tableau, Note, Citation en bloc.
 *
 * Leurs accélérateurs sont ceux de toute la fenêtre : la touche pressée dans le chat, que le champ
 * ne traite pas, revient au menu. La commande s'appliquait alors à l'éditeur, focus en plus, ou, sans
 * éditeur à l'écran, ajoutait son gabarit à la fin du miroir : invisible, et écrit sur le disque à la
 * fermeture ou 3 s après le retour en Écriture.
 *
 * Vrais hook, vue CM6 et stores ; le disque est simulé derrière l'IPC, et le menu natif réduit à ses
 * gestionnaires capturés. Le main y envoie ce que Playwright envoie par `webContents.send`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, cleanup, act } from '@testing-library/react';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { openSearchPanel } from '@codemirror/search';

import { useMenuShortcuts } from '../useMenuShortcuts';
import { flushOpenDocument } from '../useSaveOnQuit';
import { CodeMirrorEditor } from '../../components/Editor/CodeMirrorEditor';
import { resetEditorStates } from '../../components/Editor/editor-state-memory';
import { needsFlush, useEditorStore } from '../../stores/editorStore';
import { useProjectStore } from '../../stores/projectStore';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

const DOC = '/p/article/document.md';
const TEXT = '# Chapitre\n\nTexte du mot ici.\n';
const WORD = 'mot';

const CHANNELS = [
  'menu:format-bold',
  'menu:format-italic',
  'menu:insert-link',
  'menu:insert-citation',
  'menu:insert-table',
  'menu:insert-footnote',
  'menu:insert-blockquote',
] as const;

let handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
let writes: Array<[string, string]>;

const store = () => useEditorStore.getState();

const menu = (channel: string) =>
  act(() => {
    for (const handler of handlers.get(channel) ?? []) void handler({});
  });

function currentView(): EditorView {
  const dom = document.querySelector<HTMLElement>('.cm-editor');
  const view = dom && EditorView.findFromDOM(dom);
  if (!view) throw new Error('Pas de vue CM6 montée');
  return view;
}

/** La vue, le mot sélectionné, et un champ à côté d'elle, comme la saisie du chat. */
async function mountEditor(): Promise<HTMLTextAreaElement> {
  const { container } = await act(async () =>
    render(
      <>
        <textarea aria-label="saisie du chat" />
        <button type="button">Enregistrer</button>
        <CodeMirrorEditor />
      </>
    )
  );
  const from = TEXT.indexOf(WORD);
  act(() => {
    currentView().dispatch({ selection: EditorSelection.range(from, from + WORD.length) });
  });
  const field = container.querySelector('textarea');
  if (!field) throw new Error('Pas de champ');
  return field;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetEditorStates();
  handlers = new Map();
  writes = [];
  (window as unknown as { electron: unknown }).electron = {
    editor: {
      saveFile: async (path: string, content: string) => {
        writes.push([path, content]);
        return { success: true };
      },
      onInsertText: () => () => undefined,
    },
    proposals: { recordAdjudication: () => undefined },
    ipcRenderer: {
      on: (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
      },
      removeListener: (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, (handlers.get(channel) ?? []).filter((h) => h !== handler));
      },
    },
  };
  useProjectStore.setState({ currentProject: null });
  useEditorStore.setState((s) => ({
    filePath: DOC,
    content: TEXT,
    isDirty: false,
    lastSavedAt: null,
    documentVersion: s.documentVersion + 1,
    editorFacade: null,
    bufferDetached: false,
    switchLock: null,
  }));
  renderHook(() => useMenuShortcuts());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  useEditorStore.setState({ filePath: null, content: '', isDirty: false, editorFacade: null });
});

describe('sans éditeur à l’écran (Brainstorm, Explorer, Export)', () => {
  it.each(CHANNELS)('%s : le miroir ne bouge pas, et il n’y a rien à écrire', async (channel) => {
    menu(channel);

    expect(store().content).toBe(TEXT);
    expect(store().isDirty).toBe(false);
    expect(
      needsFlush({ filePath: DOC, isDirty: store().isDirty, live: store().getLiveContent(), mirror: store().content })
    ).toBe(false);
    await expect(flushOpenDocument()).resolves.toEqual({ outcome: 'clean' });
    expect(writes).toEqual([]);
  });

  it('insertFormatting appelé directement, sans façade : rien non plus', () => {
    for (const type of ['bold', 'italic', 'link', 'citation', 'table', 'footnote', 'blockquote'] as const) {
      act(() => store().insertFormatting(type));
    }

    expect(store().content).toBe(TEXT);
    expect(store().isDirty).toBe(false);
  });
});

describe('éditeur à l’écran, focus ailleurs', () => {
  it.each(CHANNELS)('%s, focus dans la saisie du chat : rien, et le focus y reste', async (channel) => {
    const field = await mountEditor();
    field.focus();

    menu(channel);

    expect(currentView().state.doc.toString()).toBe(TEXT);
    expect(store().isDirty).toBe(false);
    expect(document.activeElement).toBe(field);
  });

  it('focus dans le champ de recherche de l’éditeur : rien, il n’a pas de sélection à mettre en forme', async () => {
    await mountEditor();
    act(() => {
      openSearchPanel(currentView());
    });
    const search = document.querySelector<HTMLInputElement>('.cm-search input');
    if (!search) throw new Error('Pas de panneau de recherche');
    search.focus();

    for (const channel of CHANNELS) menu(channel);

    expect(currentView().state.doc.toString()).toBe(TEXT);
    expect(document.activeElement).toBe(search);
  });

  it('focus sur un bouton de la barre d’outils : le menu ne fait rien, comme la frappe', async () => {
    await mountEditor();
    document.querySelector('button')?.focus();

    for (const channel of CHANNELS) menu(channel);

    expect(currentView().state.doc.toString()).toBe(TEXT);
  });

  it('focus nulle part : rien non plus', async () => {
    await mountEditor();
    (document.activeElement as HTMLElement | null)?.blur();

    for (const channel of CHANNELS) menu(channel);

    expect(currentView().state.doc.toString()).toBe(TEXT);
  });
});

describe('focus dans l’éditeur', () => {
  it.each(CHANNELS)('%s s’applique', async (channel) => {
    await mountEditor();
    act(() => currentView().focus());

    menu(channel);

    expect(currentView().state.doc.toString()).not.toBe(TEXT);
    expect(currentView().state.doc.toString()).toContain(WORD);
    expect(store().isDirty).toBe(true);
  });

  // `view.hasFocus` demande aussi `document.hasFocus()`. Un clic dans un menu natif, sous Windows et
  // Linux, peut le rendre faux alors que le curseur est toujours dans le texte : le menu ne ferait
  // plus rien du tout.
  it('la fenêtre a perdu le focus le temps du menu : le curseur est dans le texte, la commande s’applique', async () => {
    await mountEditor();
    act(() => currentView().focus());
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    expect(currentView().hasFocus).toBe(false);

    menu('menu:format-bold');

    expect(currentView().state.doc.toString()).toContain(`**${WORD}**`);
  });
});
