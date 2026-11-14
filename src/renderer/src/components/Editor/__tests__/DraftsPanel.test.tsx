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
import { insertDraftAtOffset } from '../../Brainstorm/messageToDraft';
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
let adjudications: Array<{ decision: string }>;

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
  adjudications = [];
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
    // Le canal des deux journaux : ce qui y part est une décision de l'auteur.
    proposals: {
      recordAdjudication: (event: { decision: string }) => {
        adjudications.push(event);
      },
    },
    ipcRenderer: { on: () => () => undefined },
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
  vi.restoreAllMocks();
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

/**
 * D9 : glisser une carte dans le texte la propose au point de dépôt, comme son bouton au curseur.
 *
 * La carte partait en `text/plain` et le dépôt natif de CM6 l'insérait : seul chemin où du texte
 * d'IA entrait sans proposition, et sans décision au journal. Au `dragend`, elle quittait la file
 * avant toute décision. Du navigateur, seul ce que jsdom n'a pas est simulé : le `DataTransfer`, le
 * lâcher sur une cible qui l'accepte, et l'offset que la mise en page donne au point de dépôt.
 */
describe('glisser une carte dans le texte (D9)', () => {
  /** « Texte| du chapitre A. » : au milieu du paragraphe, loin du curseur, posé au bout du texte. */
  const DROP_AT = TEXT_A.indexOf(' du chapitre');
  const DROPPED = '# Chapitre A\n\nTexte\n\nTEXTE DU BROUILLON\n\n du chapitre A.\n';
  const DROP_POINT = { x: 140, y: 52 };

  const dragType = (type: string) => (type.toLowerCase() === 'text' ? 'text/plain' : type.toLowerCase());

  /** Le `DataTransfer` d'un vrai glisser : types en minuscules, `Text` vaut `text/plain`. */
  class DragData {
    private readonly data = new Map<string, string>();
    dropEffect = 'none';
    effectAllowed = 'uninitialized';
    readonly files: File[] = [];
    get types(): string[] {
      return [...this.data.keys()];
    }
    setData(type: string, value: string): void {
      this.data.set(dragType(type), value);
    }
    getData(type: string): string {
      return this.data.get(dragType(type)) ?? '';
    }
  }

  const card = () => {
    const found = document.querySelector<HTMLElement>('.drafts-panel__card');
    if (!found) throw new Error('Pas de carte dans le panneau');
    return found;
  };
  const docText = () => currentView().state.doc.toString();
  const notified = () => useNotificationStore.getState().notifications.map((n) => n.title);

  /** La mise en page, que jsdom n'a pas : le point de dépôt tombe à cet offset, et nul autre. */
  function layoutDropPointAt(offset: number): void {
    const view = currentView();
    vi.spyOn(view, 'posAtCoords').mockImplementation(((coords: { x: number; y: number }) =>
      coords.x === DROP_POINT.x && coords.y === DROP_POINT.y ? offset : null) as typeof view.posAtCoords);
  }

  function dragEvent(type: string, data: DragData): MouseEvent {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: DROP_POINT.x, clientY: DROP_POINT.y });
    Object.defineProperty(event, 'dataTransfer', { value: data });
    return event;
  }

  /**
   * Ce que fait le navigateur au-dessus du texte : il ne lâche que sur une cible qui accepte
   * (`dragover` annulé, ou zone éditable), et `dragend` dit l'opération faite, `none` sinon.
   */
  function releaseOverText(data: DragData, source?: HTMLElement): void {
    const view = currentView();
    const target = view.contentDOM.querySelector('.cm-line') ?? view.contentDOM;
    const over = dragEvent('dragover', data);
    act(() => void target.dispatchEvent(over));
    if (over.defaultPrevented || view.contentDOM.getAttribute('contenteditable') === 'true') {
      act(() => void target.dispatchEvent(dragEvent('drop', data)));
      data.dropEffect = 'copy';
    }
    if (source) act(() => void fireEvent.dragEnd(source, { dataTransfer: data }));
  }

  function dragCardTo(offset: number): void {
    layoutDropPointAt(offset);
    const data = new DragData();
    const source = card();
    act(() => void fireEvent.dragStart(source, { dataTransfer: data }));
    releaseOverText(data, source);
  }

  it('le texte ne change pas : une proposition attend au point de dépôt, et aucune décision ne part aux journaux', () => {
    dragCardTo(DROP_AT);

    expect(docText()).toBe(TEXT_A);
    expect(proposalBox()).not.toBeNull();
    expect(editor().editorFacade?.getProposalRanges()).toEqual([{ from: DROP_AT, to: DROP_AT }]);
    expect(adjudications).toEqual([]);
    // Le `dragend` qui suit le dépôt ne retire pas la carte : elle attend la décision, comme après
    // son bouton, et ne se glisse plus.
    expect(queued()).toEqual([DRAFT_ID]);
    expect(insertButton().disabled).toBe(true);
    expect(card().getAttribute('draggable')).toBe('false');
  });

  it('accepté : le texte entre au point de dépôt, avec le padding de bloc du bouton, et la carte quitte la file', () => {
    dragCardTo(DROP_AT);
    act(() => void fireEvent.mouseDown(proposalButton(0)));

    expect(docText()).toBe(DROPPED);
    expect(DROPPED).toBe(insertDraftAtOffset(TEXT_A, DROP_AT, DRAFT_TEXT));
    expect(adjudications.map((e) => e.decision)).toEqual(['accepted']);
    expect(queued()).toEqual([]);
  });

  it('rejeté : le texte reste tel quel, et la carte reste dans la file, de nouveau glissable', async () => {
    dragCardTo(DROP_AT);
    act(() => void fireEvent.mouseDown(proposalButton(1)));
    await wait(700);

    expect(docText()).toBe(TEXT_A);
    expect(adjudications.map((e) => e.decision)).toEqual(['rejected']);
    expectDraftKeptAndButtonBack();
    expect(card().getAttribute('draggable')).toBe('true');
  });

  it('même endroit que le bouton : déposée où le bouton aurait proposé, acceptée, le même texte', () => {
    act(() => {
      currentView().dispatch({ selection: EditorSelection.cursor(DROP_AT) });
    });
    insert();
    act(() => void fireEvent.mouseDown(proposalButton(0)));

    expect(docText()).toBe(DROPPED);
  });

  it('une carte déjà proposée par son bouton ne se glisse pas', () => {
    insert();

    expect(card().getAttribute('draggable')).toBe('false');
  });

  it('fichier CRLF : la proposition attend au point de dépôt, et acceptée, le fichier reste CRLF uniforme', async () => {
    const crlf = TEXT_A.replace(/\n/g, '\r\n');
    await act(async () => {
      useEditorStore.setState((s) => ({ content: crlf, documentVersion: s.documentVersion + 1 }));
    });
    // Offsets du document : une fin de ligne y vaut 1.
    dragCardTo(DROP_AT);

    expect(editor().getLiveContent()).toBe(crlf);
    expect(editor().editorFacade?.getProposalRanges()).toEqual([{ from: DROP_AT, to: DROP_AT }]);
    act(() => void fireEvent.mouseDown(proposalButton(0)));

    expect(editor().getLiveContent()).toBe(DROPPED.replace(/\n/g, '\r\n'));
  });

  it('témoin : un texte glissé d’une autre application garde le dépôt natif, au point de dépôt', () => {
    layoutDropPointAt(DROP_AT);
    const data = new DragData();
    data.setData('text/plain', 'Texte venu d’ailleurs');

    releaseOverText(data);

    expect(docText()).toBe(`${TEXT_A.slice(0, DROP_AT)}Texte venu d’ailleurs${TEXT_A.slice(DROP_AT)}`);
    expect(proposalBox()).toBeNull();
    expect(queued()).toEqual([DRAFT_ID]);
  });

  it('vue en lecture seule : rien n’entre, la carte reste, et l’auteur le sait', async () => {
    await act(async () => {
      await editor().replaceBuffer({ kind: 'detach' }, 'project-switch');
    });
    const before = docText();

    dragCardTo(0);

    expect(docText()).toBe(before);
    expect(proposalBox()).toBeNull();
    expectDraftKeptAndButtonBack();
    expect(notified()).toContain('editor.proposalUnavailable');
  });

  it('livre sans chapitre ouvert : rien n’entre dans le tampon, pas même par le dépôt natif, et l’auteur le sait', async () => {
    await act(async () => {
      await editor().replaceBuffer({ kind: 'untitled' }, 'new-document');
    });

    dragCardTo(0);

    expect(docText()).toBe('');
    expect(proposalBox()).toBeNull();
    expectDraftKeptAndButtonBack();
    expect(notified()).toContain('editor.proposalUnavailable');
  });

  it('une proposition qui échoue ne retombe jamais sur le dépôt natif : rien n’entre, la carte reste', () => {
    const facade = editor().editorFacade;
    if (!facade) throw new Error('Pas de façade');
    vi.spyOn(facade, 'propose').mockImplementation(() => {
      throw new Error('panne simulée');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    dragCardTo(DROP_AT);

    expect(docText()).toBe(TEXT_A);
    expectDraftKeptAndButtonBack();
    expect(notified()).toContain('editor.proposalUnavailable');
  });

  it('un point de dépôt qui ne se calcule pas : le dépôt natif est déjà empêché, rien n’entre, la carte reste, et l’auteur le sait', () => {
    const view = currentView();
    const target = view.contentDOM.querySelector('.cm-line') ?? view.contentDOM;
    const data = new DragData();
    act(() => void fireEvent.dragStart(card(), { dataTransfer: data }));
    const drop = dragEvent('drop', data);
    // Le premier appel est celui du gestionnaire de la carte. Les suivants seraient ceux du dépôt
    // natif, s'il prenait la main : ils tombent au milieu du paragraphe, et le texte y entrerait.
    const preventedAtFirstCall: boolean[] = [];
    vi.spyOn(view, 'posAtCoords').mockImplementation((() => {
      if (preventedAtFirstCall.length > 0) return DROP_AT;
      preventedAtFirstCall.push(drop.defaultPrevented);
      throw new Error('mise en page indisponible');
    }) as typeof view.posAtCoords);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    act(() => void target.dispatchEvent(drop));

    // Empêché avant tout calcul : une erreur qui sortirait du gestionnaire n'ouvrirait pas la voie
    // au dépôt natif, que CM6 lance après un gestionnaire qui lève.
    expect(preventedAtFirstCall).toEqual([true]);
    expect(docText()).toBe(TEXT_A);
    expect(proposalBox()).toBeNull();
    expect(adjudications).toEqual([]);
    expectDraftKeptAndButtonBack();
    expect(notified()).toContain('editor.proposalUnavailable');
  });
});
