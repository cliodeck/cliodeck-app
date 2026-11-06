// @vitest-environment jsdom
/**
 * Les commandes de mise en forme sur la vraie vue : ce qu'elles font du texte sélectionné, de
 * l'annulation, des fins de ligne d'un fichier CRLF, et d'une vue qui n'a pas le droit d'écrire.
 *
 * Lien, citation et citation en bloc remplaçaient la sélection par leur gabarit. Une vue en lecture
 * seule ne bloque que le clavier, pas un `dispatch` : seuls les filtres de changements la tenaient,
 * et `isDirty` passait à vrai sans que rien ait changé. Et `state.replaceSelection('x\ny')` sur un
 * état CRLF laisse un `\n` à l'intérieur d'une « ligne » : le fichier devenait mixte.
 *
 * Vraie vue CM6, vrai keymap, vrais stores ; seul le disque est simulé, derrière l'IPC. Les
 * touches sont envoyées à la vue : jamais au système, où Cmd+Maj+Q ferme la session.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { EditorSelection, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { DEFAULT_BOOK_SETTINGS } from '@backend/types/book';
import { openFootnotePopup } from '@/editor/cm/scholarly/footnote-popup';
import { parseSlides } from '@/editor/slides';

import { CodeMirrorEditor } from '../CodeMirrorEditor';
import { EditorPanel } from '../EditorPanel';
import { resetEditorStates } from '../editor-state-memory';
import i18n from '../../../i18n';
import { useAutoSave } from '../../../hooks/useAutoSave';
import { useEditorStore } from '../../../stores/editorStore';
import { useProjectStore } from '../../../stores/projectStore';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

const PROJECT = '/p/article';
const DOC = `${PROJECT}/document.md`;
const TEXT = 'Les archives nationales conservent le fonds.\n\nUn paragraphe entier à citer.\n';
const DELAY = 3000;
// Le store lit le vrai i18n : ces gabarits sont écrits dans le manuscrit, pas dans l'interface.
const KEY = i18n.t('snippets.citationKey');

let disk: Record<string, string>;
let writes: Array<[string, string]>;
let onInsertText: ((raw: unknown) => void) | null;

const editor = () => useEditorStore.getState();

function currentView(): EditorView {
  const dom = document.querySelector<HTMLElement>('.cm-editor');
  const view = dom && EditorView.findFromDOM(dom);
  if (!view) throw new Error('Pas de vue CM6 montée');
  return view;
}

const docText = () => currentView().state.doc.toString();
const selected = () => {
  const { state } = currentView();
  const { from, to } = state.selection.main;
  return state.doc.sliceString(from, to);
};

type Command = 'bold' | 'italic' | 'link' | 'citation' | 'table' | 'footnote' | 'blockquote';

const KEYS: Record<Command, KeyboardEventInit & { keyCode: number }> = {
  bold: { key: 'b', keyCode: 66 },
  italic: { key: 'i', keyCode: 73 },
  link: { key: 'l', keyCode: 76 },
  citation: { key: "'", keyCode: 222 },
  table: { key: 'T', shiftKey: true, keyCode: 84 },
  footnote: { key: 'F', shiftKey: true, keyCode: 70 },
  blockquote: { key: 'Q', shiftKey: true, keyCode: 81 },
};
const COMMANDS = Object.keys(KEYS) as Command[];

/** Le vrai keymap, tel qu'il reçoit la touche : sous jsdom, Mod vaut Ctrl. */
function press(command: Command): void {
  act(() => {
    currentView().contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { ...KEYS[command], ctrlKey: true, bubbles: true, cancelable: true })
    );
  });
}

function select(text: string): void {
  const from = docText().indexOf(text);
  if (from < 0) throw new Error(`« ${text} » n'est pas dans le document`);
  selectRange(from, from + text.length);
}

function selectRange(from: number, to: number): void {
  act(() => {
    currentView().dispatch({ selection: EditorSelection.range(from, to) });
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

/** Un vrai événement `paste` vers la vue : le presse-papiers du système n'y est pour rien. */
function paste(text: string): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (format: string) => (format === 'text/plain' ? text : '') },
  });
  act(() => {
    currentView().contentDOM.dispatchEvent(event);
  });
}

const undoOnce = () =>
  act(() => {
    expect(undo(currentView())).toBe(true);
  });

const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

function setProject(type: 'article' | 'book' | 'presentation' = 'article'): void {
  useProjectStore.setState({
    currentProject: {
      id: 'p1',
      name: 'Projet',
      path: PROJECT,
      type,
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
    bookSettings: { ...DEFAULT_BOOK_SETTINGS },
    chapters: [],
    loadState: { kind: 'ready', loadedAt: 'avant', path: PROJECT },
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

const Saved: React.FC = () => {
  useAutoSave();
  return <CodeMirrorEditor />;
};

async function mount(text: string = TEXT, path: string = DOC): Promise<void> {
  disk[path] = text;
  openInStore(path);
  await act(async () => {
    render(<Saved />);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetEditorStates();
  disk = {};
  writes = [];
  onInsertText = null;
  (window as unknown as { electron: unknown }).electron = {
    project: { getChapters: vi.fn(async () => ({ success: true, chapters: [], unattached: [] })) },
    editor: {
      loadFile: vi.fn(async (path: string) => ({ success: true, content: disk[path] })),
      saveFile: vi.fn(async (path: string, content: string) => {
        writes.push([path, content]);
        disk[path] = content;
        return { success: true };
      }),
      onInsertText: (callback: (raw: unknown) => void) => {
        onInsertText = callback;
        return () => undefined;
      },
    },
    pdf: { getAllDocuments: vi.fn(async () => ({ success: true, documents: [] })) },
    proposals: { recordAdjudication: () => undefined },
    ipcRenderer: { on: () => () => undefined },
  };
  setProject();
  useEditorStore.setState((s) => ({
    bufferDetached: false,
    switchLock: null,
    settings: { ...s.settings, autoSave: true, autoSaveDelay: DELAY },
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
  useProjectStore.setState({ currentProject: null, chapters: [], currentChapterId: null, loadState: { kind: 'idle' } });
});

describe('une sélection n’est plus écrasée', () => {
  it('Mod-l enveloppe la sélection, `url` sélectionné ; Cmd+Z rend le texte et la sélection', async () => {
    await mount();
    select('archives nationales');

    press('link');

    expect(docText()).toBe(TEXT.replace('archives nationales', '[archives nationales](url)'));
    expect(selected()).toBe('url');
    expect(editor().isDirty).toBe(true);

    undoOnce();
    expect(docText()).toBe(TEXT);
    expect(selected()).toBe('archives nationales');
  });

  it('Mod-\' sur une clé : `[@clé]` ; Cmd+Z rend la clé sélectionnée', async () => {
    await mount('Voir Smith2020 ici.\n');
    select('Smith2020');

    press('citation');

    expect(docText()).toBe('Voir [@Smith2020] ici.\n');
    undoOnce();
    expect(docText()).toBe('Voir Smith2020 ici.\n');
    expect(selected()).toBe('Smith2020');
  });

  it('Mod-\' sur un mot ordinaire : le mot reste, et le gabarit se pose derrière lui, sélectionné', async () => {
    await mount('Une histoire longue.\n');
    select('histoire');

    press('citation');

    expect(docText()).toBe(`Une histoire [@${KEY}] longue.\n`);
    expect(selected()).toBe(KEY);
    expect(docText()).not.toContain('[@histoire]');
    undoOnce();
    expect(docText()).toBe('Une histoire longue.\n');
    expect(selected()).toBe('histoire');
  });

  it('Mod-Shift-q préfixe le paragraphe : plus de gabarit, et Cmd+Z rend tout', async () => {
    await mount();
    select('Un paragraphe entier à citer.');

    press('blockquote');

    expect(docText()).toBe(TEXT.replace('Un paragraphe', '> Un paragraphe'));
    expect(docText()).not.toContain(i18n.t('snippets.quoteFirst'));
    expect(selected()).toBe('> Un paragraphe entier à citer.');

    undoOnce();
    expect(docText()).toBe(TEXT);
    expect(selected()).toBe('Un paragraphe entier à citer.');
  });

  it('Mod-Shift-q sur plusieurs lignes à moitié sélectionnées, ligne vide comprise', async () => {
    await mount('Un mot.\n\nDeux mots.\nTrois.\n');
    select('mot.\n\nDeux');

    press('blockquote');

    expect(docText()).toBe('> Un mot.\n>\n> Deux mots.\nTrois.\n');
  });

  it('Mod-Shift-t pose le tableau après la sélection, qui reste entière', async () => {
    await mount();
    select('archives nationales');

    press('table');

    expect(docText()).toContain('archives nationales');
    expect(docText()).toContain('|---|---|');
    expect(docText().indexOf('|---|---|')).toBeGreaterThan(docText().indexOf('archives nationales'));
    undoOnce();
    expect(docText()).toBe(TEXT);
  });

  it('sans sélection, le gabarit, comme avant', async () => {
    await mount('Avant\n');
    selectRange(5, 5);

    press('link');

    expect(docText()).toBe(`Avant[${i18n.t('snippets.linkText')}](url)\n`);
  });

  it.each([
    ['bold', '**', 'snippets.boldText'],
    ['italic', '_', 'snippets.italicText'],
  ] as const)('%s sans sélection : le gabarit est celui de la langue de l’auteur, sélectionné', async (command, mark, key) => {
    vi.spyOn(i18n, 't').mockImplementation(((asked: string) => `<${asked}>`) as typeof i18n.t);
    await mount('Avant\n');
    selectRange(5, 5);

    press(command);

    expect(docText()).toBe(`Avant${mark}<${key}>${mark}\n`);
    expect(selected()).toBe(`<${key}>`);
  });

  it('Mod-Shift-f : l’appel au curseur, la définition en fin de document, et le curseur dedans', async () => {
    await mount('Un mot ici.\n\nSuite.\n');
    selectRange(6, 6);

    press('footnote');

    expect(docText()).toBe('Un mot[^1] ici.\n\nSuite.\n\n[^1]: ');
    expect(currentView().state.selection.main.head).toBe(docText().length);

    undoOnce();
    expect(docText()).toBe('Un mot ici.\n\nSuite.\n');
    expect(currentView().state.selection.main.head).toBe(6);
  });
});

describe('une seule étape de Cmd+Z', () => {
  // Une transaction sans `userEvent` se fond dans la frappe voisine, si elle la touche et la suit de
  // moins de 500 ms : Cmd+Z emportait alors aussi ce que l'auteur venait de taper.
  it.each(['bold', 'link', 'citation', 'table', 'blockquote', 'footnote'] as const)(
    '%s tout juste après une frappe : la frappe reste',
    async (command) => {
      await mount('Début\n');
      selectRange(5, 5);
      type(' tapé');

      press(command);
      expect(docText()).not.toBe('Début tapé\n');

      undoOnce();
      expect(docText()).toBe('Début tapé\n');
    }
  );
});

describe('une édition qui ne change rien', () => {
  const SLIDES = `${PROJECT}/slides.md`;
  const DECK = '# Une\n\n---\n\n# Deux\n';
  const FRONTMATTER = '---\ntitle: Cours\n---\n\n# Une\n';

  /** Ni texte, ni isDirty, ni écriture, ni étape vide que le Cmd+Z suivant consommerait. */
  async function expectNothingHappened(text: string): Promise<void> {
    await wait(DELAY + 400);
    expect(docText()).toBe(text);
    expect(editor().isDirty).toBe(false);
    expect(writes).toEqual([]);
    act(() => {
      expect(undo(currentView())).toBe(false);
    });
  }

  it('le seul `---` d’un deck sous une citation en bloc', async () => {
    setProject('presentation');
    await mount(DECK, SLIDES);
    select('---');

    press('blockquote');

    await expectNothingHappened(DECK);
    expect(selected()).toBe('---');
  });

  it('une partie du `---` : la sélection reste où l’auteur l’a mise', async () => {
    setProject('presentation');
    await mount(DECK, SLIDES);
    const from = DECK.indexOf('---');
    selectRange(from, from + 2);

    press('blockquote');

    await expectNothingHappened(DECK);
    expect(currentView().state.selection.main.from).toBe(from);
    expect(selected()).toBe('--');
  });

  it('le frontmatter seul, dans un article', async () => {
    await mount(FRONTMATTER);
    selectRange(0, '---\ntitle: Cours\n---'.length);

    press('blockquote');

    await expectNothingHappened(FRONTMATTER);
  });

  it('le focus revient quand même au texte : le bouton ne semble pas mort', async () => {
    setProject('presentation');
    await mount(DECK, SLIDES);
    select('---');
    (document.activeElement as HTMLElement | null)?.blur();

    let applied: boolean | undefined;
    act(() => {
      applied = editor().editorFacade?.editSelection((doc, from, to) => ({
        from,
        to,
        insert: doc.slice(from, to),
        selFrom: from,
        selTo: to,
      }));
    });

    expect(applied).toBe(false);
    expect(document.activeElement).toBe(currentView().contentDOM);
  });
});

describe('l’origine des transactions', () => {
  it.each(COMMANDS)('%s ne fait pas parler la garde', async (command) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await mount();
    select('archives nationales');

    press(command);
    expect(docText()).not.toBe(TEXT);

    expect(warn.mock.calls.filter(([message]) => String(message).includes('changeOrigin'))).toEqual([]);
  });

  it('témoin : une transaction sans origine la fait parler', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await mount();

    act(() => {
      currentView().dispatch({ changes: { from: 0, insert: 'x' } });
    });

    expect(warn.mock.calls.filter(([message]) => String(message).includes('changeOrigin'))).toHaveLength(1);
  });
});

describe('le curseur connu', () => {
  it('une commande qui écrit le pose, comme une frappe', async () => {
    await mount();
    expect(editor().editorFacade?.hasKnownCursor()).toBe(false);

    press('link');

    expect(editor().editorFacade?.hasKnownCursor()).toBe(true);
  });

  it('une commande refusée ne le pose pas', async () => {
    await mount();
    useEditorStore.setState({ switchLock: 'book.renumberInProgress' });

    for (const command of COMMANDS) press(command);

    expect(editor().editorFacade?.hasKnownCursor()).toBe(false);
  });
});

describe('une vue qui n’a pas le droit d’écrire', () => {
  async function mountDetached(): Promise<void> {
    await mount();
    await act(async () => {
      await editor().replaceBuffer({ kind: 'detach' }, 'project-switch');
    });
    expect(currentView().state.readOnly).toBe(true);
  }

  it.each(COMMANDS)('pendant un changement de projet, %s : aucun changement, aucun isDirty', async (command) => {
    await mountDetached();

    press(command);
    await wait(400);

    expect(docText()).toBe('');
    expect(editor().content).toBe('');
    expect(editor().isDirty).toBe(false);
    expect(editor().editorFacade?.hasKnownCursor()).toBe(false);
  });

  it('la façade refuse directement : toggleInline, editSelection, replaceSelection', async () => {
    await mountDetached();
    const facade = editor().editorFacade;

    act(() => {
      facade?.toggleInline?.('bold', 'gras');
      facade?.replaceSelection('x');
    });
    let applied: boolean | undefined;
    act(() => {
      applied = facade?.editSelection(() => ({ from: 0, to: 0, insert: 'x', selFrom: 1, selTo: 1 }));
    });

    expect(applied).toBe(false);
    expect(docText()).toBe('');
    expect(facade?.hasKnownCursor()).toBe(false);
  });

  it('la note de bas de page rend null, et n’écrit pas dans le miroir', async () => {
    await mountDetached();

    let result: unknown = 'non appelé';
    act(() => {
      result = editor().insertFootnoteAtPosition(0);
    });

    expect(result).toBeNull();
    expect(editor().content).toBe('');
    expect(editor().isDirty).toBe(false);
  });

  it('insertTextAtCursor : aucun isDirty sans changement', async () => {
    await mountDetached();

    act(() => editor().insertTextAtCursor('Une citation'));

    expect(docText()).toBe('');
    expect(editor().isDirty).toBe(false);
  });

  it.each(COMMANDS)('sous le verrou d’une renumérotation, %s : aucun changement, aucun isDirty', async (command) => {
    await mount();
    useEditorStore.setState({ switchLock: 'book.renumberInProgress' });
    select('archives nationales');

    press(command);
    await wait(400);

    expect(docText()).toBe(TEXT);
    expect(editor().content).toBe(TEXT);
    expect(editor().isDirty).toBe(false);
  });

  it('sans façade, au commit d’un remplacement, la vue sortante n’écrit nulle part', async () => {
    await mount();
    const view = currentView();
    useEditorStore.setState({ editorFacade: null });

    act(() => {
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { ...KEYS.bold, ctrlKey: true, bubbles: true, cancelable: true })
      );
    });

    expect(view.state.doc.toString()).toBe(TEXT);
    expect(editor().content).toBe(TEXT);
    expect(editor().isDirty).toBe(false);
  });

  it('témoin : une vue ordinaire écrit, et isDirty suit', async () => {
    await mount();
    select('archives nationales');

    press('bold');

    expect(docText()).toContain('**archives nationales**');
    expect(editor().isDirty).toBe(true);
  });
});

describe('un fichier CRLF', () => {
  const CRLF = 'Les archives nationales.\r\n\r\nUn paragraphe.\r\nUne suite.\r\n';
  const noBareLf = (value: string) => expect(value.replace(/\r\n/g, '')).not.toContain('\n');

  /** Le texte qui part sur le disque, puis ce que rend une seule étape de Cmd+Z. */
  async function writtenThenUndone(act_: () => void, undoSteps = 1): Promise<string> {
    act_();
    await wait(DELAY + 400);
    const written = writes.at(-1)?.[1] ?? '';
    noBareLf(written);
    expect(written).not.toBe(CRLF);
    for (let step = 0; step < undoSteps; step += 1) undoOnce();
    expect(editor().getLiveContent()).toBe(CRLF);
    return written;
  }

  it('lien sur une sélection qui passe la fin de ligne', async () => {
    await mount(CRLF);
    select('paragraphe.\nUne');

    const written = await writtenThenUndone(() => press('link'));

    expect(written).toBe('Les archives nationales.\r\n\r\nUn [paragraphe.\r\nUne](url) suite.\r\n');
  });

  it('gras sur une sélection qui passe la fin de ligne', async () => {
    await mount(CRLF);
    select('paragraphe.\nUne');

    const written = await writtenThenUndone(() => press('bold'));

    expect(written).toBe('Les archives nationales.\r\n\r\nUn **paragraphe.\r\nUne** suite.\r\n');
  });

  it('citation en bloc sur plusieurs lignes, ligne vide comprise', async () => {
    await mount(CRLF);
    select('nationales.\n\nUn');

    const written = await writtenThenUndone(() => press('blockquote'));

    expect(written).toBe('> Les archives nationales.\r\n>\r\n> Un paragraphe.\r\nUne suite.\r\n');
  });

  it('tableau, et les offsets restent ceux de la vue', async () => {
    await mount(CRLF);
    select('nationales');

    const written = await writtenThenUndone(() => press('table'));

    expect(written.startsWith(`Les archives nationales\r\n| ${i18n.t('snippets.column', { n: 1 })} |`)).toBe(true);
  });

  it('citation sur un mot : le gabarit tombe juste derrière lui', async () => {
    await mount(CRLF);
    select('suite');

    const written = await writtenThenUndone(() => press('citation'));

    expect(written).toBe(CRLF.replace('suite', `suite [@${KEY}]`));
  });

  it('gabarit de citation en bloc, sans sélection', async () => {
    await mount(CRLF);
    selectRange(0, 0);

    const written = await writtenThenUndone(() => press('blockquote'));

    expect(written.startsWith(`\r\n> ${i18n.t('snippets.quoteFirst')}\r\n> ${i18n.t('snippets.quoteSecond')}\r\n`)).toBe(
      true
    );
  });

  it('note de bas de page : l’appel au bon endroit, et la définition en fin de fichier', async () => {
    await mount(CRLF);
    const at = docText().indexOf(' paragraphe');
    selectRange(at, at);

    const written = await writtenThenUndone(() => press('footnote'));

    expect(written).toBe('Les archives nationales.\r\n\r\nUn[^1] paragraphe.\r\nUne suite.\r\n\r\n[^1]: ');
  });

  it('une note de plus, derrière les définitions déjà là', async () => {
    const withNote = 'Un mot[^1] ici.\r\n\r\n[^1]: Déjà là.\r\n';
    await mount(withNote);
    const at = docText().indexOf(' ici');
    selectRange(at, at);

    press('footnote');

    const live = editor().getLiveContent();
    noBareLf(live);
    expect(live).toBe('Un mot[^1][^2] ici.\r\n\r\n[^1]: Déjà là.\r\n\r\n[^2]: ');
  });

  it('replaceSelection reçoit des `\\n` : le fichier reste uniforme', async () => {
    await mount(CRLF);
    selectRange(0, 0);

    const written = await writtenThenUndone(() => {
      act(() => editor().editorFacade?.replaceSelection('x\ny\n'));
    });

    expect(written).toBe(`x\r\ny\r\n${CRLF}`);
  });

  it('l’insertion IPC reçoit des `\\n` : le fichier reste uniforme', async () => {
    await mount(CRLF);
    selectRange(0, 0);

    const written = await writtenThenUndone(() => {
      act(() => onInsertText?.({ text: 'x\ny\n' }));
    });

    expect(written).toBe(`x\r\ny\r\n${CRLF}`);
  });

  it('un collage en `\\n` : le fichier reste uniforme, et Cmd+Z le rend', async () => {
    await mount(CRLF);
    selectRange(0, 0);

    const written = await writtenThenUndone(() => paste('ligne un\nligne deux\n'));

    expect(written).toBe(`ligne un\r\nligne deux\r\n${CRLF}`);
  });

  it('un collage en vieilles fins de ligne Mac aussi', async () => {
    await mount(CRLF);
    selectRange(0, 0);

    const written = await writtenThenUndone(() => paste('ligne un\rligne deux\r'));

    expect(written).toBe(`ligne un\r\nligne deux\r\n${CRLF}`);
  });

  it('un collage en CRLF reste tel quel', async () => {
    await mount(CRLF);
    selectRange(0, 0);

    const written = await writtenThenUndone(() => paste('ligne un\r\nligne deux\r\n'));

    expect(written).toBe(`ligne un\r\nligne deux\r\n${CRLF}`);
  });

  it('témoin : un collage en CRLF dans un fichier LF ne laisse aucun `\\r` dans le document', async () => {
    await mount(TEXT);
    selectRange(0, 0);

    paste('ligne un\r\nligne deux\r\n');

    expect(editor().getLiveContent()).toBe(`ligne un\nligne deux\n${TEXT}`);
  });

  it('un collage sur une vue en lecture seule ne fait rien', async () => {
    await mount(CRLF);
    await act(async () => {
      await editor().replaceBuffer({ kind: 'detach' }, 'project-switch');
    });

    paste('ligne un\nligne deux\n');

    expect(docText()).toBe('');
    expect(editor().isDirty).toBe(false);
  });

  describe('la popup de note', () => {
    function openPopup(label: string): HTMLTextAreaElement {
      act(() => {
        currentView().dispatch({ effects: openFootnotePopup.of({ label, at: 0 }) });
      });
      const textarea = document.querySelector<HTMLTextAreaElement>('.cm-scholarly-popup textarea');
      if (!textarea) throw new Error('Popup de note absente');
      return textarea;
    }

    function saveInPopup(label: string, text: string): void {
      openPopup(label).value = text;
      act(() => {
        document.querySelector<HTMLButtonElement>('.cm-scholarly-popup-save')?.click();
      });
    }

    // Fermer la popup lui retire le focus en pleine mise à jour de la vue : un `dispatch` à ce moment
    // lèverait, et Vitest ferait échouer la suite sur cette exception.
    it('Échap ferme la popup sans rien écrire', async () => {
      const text = 'Un mot[^1].\r\n\r\n[^1]: Déjà là.\r\n';
      await mount(text);

      const textarea = openPopup('1');
      textarea.value = 'Autre chose.';
      act(() => {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });

      expect(document.querySelector('.cm-scholarly-popup')).toBeNull();
      expect(editor().getLiveContent()).toBe(text);
      expect(editor().isDirty).toBe(false);
    });

    it('un clic ailleurs la ferme aussi : c’est le seul cas où le focus qui s’en va vaut une fermeture', async () => {
      await mount('Un mot[^1].\r\n\r\n[^1]: Déjà là.\r\n');

      const textarea = openPopup('1');
      act(() => {
        textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: currentView().contentDOM }));
      });

      expect(document.querySelector('.cm-scholarly-popup')).toBeNull();
    });

    it('une définition existante, réécrite sur plusieurs lignes', async () => {
      await mount('Un mot[^1].\r\n\r\n[^1]: Déjà là.\r\n');

      saveInPopup('1', 'Première ligne.\nDeuxième ligne.');

      const live = editor().getLiveContent();
      noBareLf(live);
      expect(live).toBe('Un mot[^1].\r\n\r\n[^1]: Première ligne.\r\nDeuxième ligne.\r\n');
    });

    it('une définition créée en fin de document, séparateur compris', async () => {
      await mount('Un mot[^1].');

      saveInPopup('1', 'Texte.');

      expect(editor().getLiveContent()).toBe('Un mot[^1].\n\n[^1]: Texte.');
    });

    it('une définition créée en fin de fichier CRLF, séparateur compris', async () => {
      await mount('Un mot[^1].\r\nSuite.');

      saveInPopup('1', 'Première ligne.\nDeuxième ligne.');

      const live = editor().getLiveContent();
      noBareLf(live);
      expect(live).toBe('Un mot[^1].\r\nSuite.\r\n\r\n[^1]: Première ligne.\r\nDeuxième ligne.');
    });
  });

  it('témoin : un fichier LF reçoit un texte en CRLF et reste en LF', async () => {
    await mount(TEXT);
    selectRange(0, 0);

    act(() => editor().editorFacade?.replaceSelection('x\r\ny'));

    expect(editor().getLiveContent()).toBe(`x\ny${TEXT}`);
  });

  it('fichier mixte : le `\\r` d’une ligne n’est pas une fin de ligne, il reste sous le gras', async () => {
    const mixed = 'Un mot\r\nDeux mots\nTrois.\n';
    await mount(mixed);
    const from = docText().indexOf('mot');
    selectRange(from, docText().indexOf('Deux') + 'Deux'.length);

    press('bold');

    expect(editor().getLiveContent()).toBe('Un **mot\r\nDeux** mots\nTrois.\n');
    undoOnce();
    expect(editor().getLiveContent()).toBe(mixed);
  });
});

describe('présentation et livre', () => {
  const SLIDES = `${PROJECT}/slides.md`;
  const DECK = '# Une\n\nTexte de la une.\n\n---\n\n# Deux\n\nTexte de la deux.\n';

  it('slides.md garde ses frontières sous une citation en bloc qui les traverse', async () => {
    setProject('presentation');
    await mount(DECK, SLIDES);
    const before = parseSlides(DECK).slides.length;
    select('Texte de la une.\n\n---\n\n# Deux');

    press('blockquote');

    expect(docText()).toBe('# Une\n\n> Texte de la une.\n\n---\n\n> # Deux\n\nTexte de la deux.\n');
    expect(parseSlides(docText()).slides).toHaveLength(before);
    undoOnce();
    expect(docText()).toBe(DECK);
  });

  it('une sélection partie de la ligne vide sous le premier `---` : pas de frontmatter de plus, aucune diapositive de moins', async () => {
    setProject('presentation');
    const deck = '---\n\n# Une\n\nNote: un point\n\n---\n\n# Deux\n';
    await mount(deck, SLIDES);
    expect(parseSlides(deck).slides).toHaveLength(3);
    selectRange(4, deck.indexOf('# Une') + '# Une'.length);

    press('blockquote');

    expect(docText()).toBe('---\n\n> # Une\n\nNote: un point\n\n---\n\n# Deux\n');
    expect(parseSlides(docText()).frontmatter).toBeNull();
    expect(parseSlides(docText()).slides).toHaveLength(3);
    undoOnce();
    expect(docText()).toBe(deck);
  });

  it('tout sélectionner sur un deck à frontmatter : il reste un frontmatter, et le compte de diapositives ne change pas', async () => {
    setProject('presentation');
    const deck = '---\ntitle: Cours\n---\n\n# Une\n\n---\n\n# Deux\n';
    await mount(deck, SLIDES);
    selectRange(0, deck.length);

    press('blockquote');

    expect(docText()).toBe('---\ntitle: Cours\n---\n\n> # Une\n\n---\n\n> # Deux\n');
    expect(parseSlides(docText()).frontmatter?.yaml).toBe('title: Cours\n');
    expect(parseSlides(docText()).slides).toHaveLength(2);
    undoOnce();
    expect(docText()).toBe(deck);
  });

  it.each(['article', 'book'] as const)('%s : `---` est du texte, et un titre Setext se cite entier', async (kind) => {
    setProject(kind);
    const text = 'Titre\n---\n\nTexte\n';
    await mount(text);
    select('Titre\n---\n\nTexte');

    press('blockquote');

    expect(docText()).toBe('> Titre\n> ---\n>\n> Texte\n');
    undoOnce();
    expect(docText()).toBe(text);
  });

  it('les boutons de diapositive insèrent après la sélection, sans l’effacer', async () => {
    setProject('presentation');
    disk[SLIDES] = DECK;
    openInStore(SLIDES);
    await act(async () => {
      render(<EditorPanel />);
    });
    select('Texte de la une.');

    await act(async () => {
      fireEvent.click(screen.getByTitle('presentation.addNote'));
    });

    expect(docText()).toContain('Texte de la une.\n\nNote:\nsnippets.speakerNotes\n');
    expect(selected()).toBe('');
    undoOnce();
    expect(docText()).toBe(DECK);
  });

  it('les boutons de diapositive dans un fichier CRLF : aucun LF nu', async () => {
    setProject('presentation');
    disk[SLIDES] = DECK.replace(/\n/g, '\r\n');
    openInStore(SLIDES);
    await act(async () => {
      render(<EditorPanel />);
    });
    selectRange(0, 0);

    await act(async () => {
      fireEvent.click(screen.getByTitle('presentation.addSlide'));
    });

    const live = editor().getLiveContent();
    expect(live).toContain('---');
    expect(live.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('livre : le chapitre ouvert reçoit la mise en forme, et l’autosave l’écrit chez lui', async () => {
    const CHAPTER = `${PROJECT}/chapters/a.md`;
    setProject('book');
    await mount('# A\n\nUn paragraphe.\n', CHAPTER);
    select('Un paragraphe.');

    press('blockquote');
    await wait(DELAY + 400);

    expect(disk[CHAPTER]).toBe('# A\n\n> Un paragraphe.\n');
    expect(writes.map(([path]) => path)).toEqual([CHAPTER]);
  });
});

describe('les boutons de la barre d’outils ne dépendent pas de la garde du menu', () => {
  it('« Citation » : le bouton a pris le focus, et la commande s’applique à la sélection', async () => {
    disk[DOC] = 'Une histoire longue.\n';
    openInStore(DOC);
    await act(async () => {
      render(<EditorPanel />);
    });
    select('histoire');
    const button = screen.getByTitle('toolbar.citation');
    button.focus();
    expect(document.activeElement).toBe(button);

    await act(async () => {
      fireEvent.click(button);
    });

    expect(docText()).toBe(`Une histoire [@${KEY}] longue.\n`);
    expect(selected()).toBe(KEY);
    expect(document.activeElement).toBe(currentView().contentDOM);
  });

  it('« Note » : même chose', async () => {
    disk[DOC] = 'Un mot.\n';
    openInStore(DOC);
    await act(async () => {
      render(<EditorPanel />);
    });
    selectRange(6, 6);
    const button = screen.getByTitle('toolbar.footnote');
    button.focus();

    await act(async () => {
      fireEvent.click(button);
    });

    expect(docText()).toBe('Un mot[^1].\n\n[^1]: ');
    expect(document.activeElement).toBe(currentView().contentDOM);
  });
});
