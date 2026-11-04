// @vitest-environment jsdom
/**
 * « Envoyer vers Write » depuis un mode où l'éditeur n'est pas monté.
 *
 * L'insertion précédait la bascule : sans façade, le texte de l'IA entrait dans le miroir,
 * en fin de fichier, comme du texte définitif. L'éditeur est ici un faux qui se monte quand
 * le mode passe en Écriture, comme le fait MainLayout : ce qu'on vérifie est l'enchaînement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorFacade } from '@/editor/facade';
import type { Proposal } from '@/editor/proposals';
import { sendDraftToWrite } from '../send-draft-to-write';
import { ensureWriteEditor } from '../wait-for-facade';
import { useEditorStore } from '../../stores/editorStore';
import { useProjectStore } from '../../stores/projectStore';
import { useWorkspaceModeStore } from '../../stores/workspaceModeStore';

const TEXT = '# Titre\n\nDu texte.\n';
const BLOCK = 'TEXTE DU BROUILLON';

function fakeFacade(proposals: Array<Partial<Proposal>>, accepts = true): EditorFacade {
  return {
    engine: 'cm6',
    getValue: () => TEXT,
    getCursorOffset: () => 9,
    hasKnownCursor: () => true,
    getSelectionText: () => null,
    replaceSelection: () => undefined,
    setValue: () => undefined,
    appendText: () => undefined,
    propose: (p) => {
      proposals.push(p);
      return accepts;
    },
    revealLine: () => undefined,
    focus: () => undefined,
    onContentChange: () => () => undefined,
  };
}

/** Le montage asynchrone de l'éditeur au passage en Écriture. */
function editorMountsOnWrite(facade: EditorFacade): () => void {
  return useWorkspaceModeStore.subscribe((state, previous) => {
    if (state.active === 'write' && previous.active !== 'write') {
      setTimeout(() => useEditorStore.getState().setEditorFacade(facade), 20);
    }
  });
}

let stopMounting: () => void = () => undefined;

beforeEach(() => {
  useEditorStore.setState({
    content: TEXT,
    filePath: '/p/document.md',
    isDirty: false,
    editorFacade: null,
    bufferDetached: false,
    switchLock: null,
  });
  useProjectStore.setState({ currentProject: null, loadState: { kind: 'idle' } });
  useWorkspaceModeStore.setState({ active: 'brainstorm' });
});

afterEach(() => {
  stopMounting();
  stopMounting = () => undefined;
  vi.useRealTimers();
  useWorkspaceModeStore.setState({ active: 'write' });
  useEditorStore.setState({ editorFacade: null, filePath: null, content: '', bufferDetached: false });
});

describe('sendDraftToWrite', () => {
  it('depuis Brainstorm : bascule, attend l’éditeur, propose, et le miroir ne bouge pas', async () => {
    const proposals: Array<Partial<Proposal>> = [];
    stopMounting = editorMountsOnWrite(fakeFacade(proposals));

    const outcome = await sendDraftToWrite(BLOCK, { model: 'm', task: 't' });

    expect(outcome).toBe('proposed');
    expect(useWorkspaceModeStore.getState().active).toBe('write');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposed).toContain(BLOCK);
    expect(proposals[0].source).toEqual({ model: 'm', task: 't' });
    expect(useEditorStore.getState().content).toBe(TEXT);
    expect(useEditorStore.getState().isDirty).toBe(false);
  });

  it('l’éditeur ne monte pas : unavailable, miroir intact', async () => {
    vi.useFakeTimers();
    const sending = sendDraftToWrite(BLOCK, {});
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await sending).toBe('unavailable');
    expect(useEditorStore.getState().content).toBe(TEXT);
    expect(useEditorStore.getState().isDirty).toBe(false);
  });

  it('la vue refuse la proposition : unavailable', async () => {
    useWorkspaceModeStore.setState({ active: 'write' });
    useEditorStore.setState({ editorFacade: fakeFacade([], false) });

    expect(await sendDraftToWrite(BLOCK, {})).toBe('unavailable');
    expect(useEditorStore.getState().content).toBe(TEXT);
  });

  it('vue détachée pendant un changement de projet : unavailable, sans toucher au mode', async () => {
    const proposals: Array<Partial<Proposal>> = [];
    useEditorStore.setState({ bufferDetached: true, filePath: null, editorFacade: fakeFacade(proposals) });

    expect(await sendDraftToWrite(BLOCK, {})).toBe('unavailable');
    expect(proposals).toEqual([]);
    expect(useWorkspaceModeStore.getState().active).toBe('brainstorm');
  });

  it('changement de projet en cours : unavailable', async () => {
    const proposals: Array<Partial<Proposal>> = [];
    useProjectStore.setState({ loadState: { kind: 'loading', path: '/q' } });
    useEditorStore.setState({ editorFacade: fakeFacade(proposals) });

    expect(await sendDraftToWrite(BLOCK, {})).toBe('unavailable');
    expect(proposals).toEqual([]);
  });

  it('un changement de projet commencé pendant l’attente : unavailable', async () => {
    const proposals: Array<Partial<Proposal>> = [];
    stopMounting = editorMountsOnWrite(fakeFacade(proposals));

    const sending = sendDraftToWrite(BLOCK, {});
    useProjectStore.setState({ loadState: { kind: 'loading', path: '/q' } });

    expect(await sending).toBe('unavailable');
    expect(proposals).toEqual([]);
  });

  it('livre sans chapitre ouvert : unavailable, le tampon n’est pas le manuscrit', async () => {
    const proposals: Array<Partial<Proposal>> = [];
    useProjectStore.setState({
      currentProject: {
        id: 'b',
        name: 'Livre',
        path: '/b',
        type: 'book',
        createdAt: new Date(),
        lastOpenedAt: new Date(),
      },
    });
    useEditorStore.setState({ filePath: null, content: '', editorFacade: fakeFacade(proposals) });

    expect(await sendDraftToWrite(BLOCK, {})).toBe('unavailable');
    expect(proposals).toEqual([]);
  });

  it('livre avec un chapitre ouvert : proposé', async () => {
    const proposals: Array<Partial<Proposal>> = [];
    useProjectStore.setState({
      currentProject: {
        id: 'b',
        name: 'Livre',
        path: '/b',
        type: 'book',
        createdAt: new Date(),
        lastOpenedAt: new Date(),
      },
    });
    useWorkspaceModeStore.setState({ active: 'write' });
    useEditorStore.setState({ filePath: '/b/chapters/a.md', editorFacade: fakeFacade(proposals) });

    expect(await sendDraftToWrite(BLOCK, {})).toBe('proposed');
    expect(proposals).toHaveLength(1);
  });
});

describe('ensureWriteEditor', () => {
  it('déjà en Écriture : la façade tout de suite, sans bascule de mode', async () => {
    const facade = fakeFacade([]);
    useWorkspaceModeStore.setState({ active: 'write' });
    useEditorStore.setState({ editorFacade: facade });
    const setActive = vi.fn();
    useWorkspaceModeStore.setState({ setActive });
    vi.useFakeTimers();

    // Aucune horloge n'avance : si la façade dépendait d'une attente, ce test resterait bloqué.
    expect(await ensureWriteEditor()).toBe(facade);
    expect(setActive).not.toHaveBeenCalled();
    useWorkspaceModeStore.setState({ setActive: (active) => useWorkspaceModeStore.setState({ active }) });
  });

  it('depuis Explorer : rend la façade dès qu’elle arrive', async () => {
    const facade = fakeFacade([]);
    useWorkspaceModeStore.setState({ active: 'explore' });
    stopMounting = editorMountsOnWrite(facade);

    expect(await ensureWriteEditor()).toBe(facade);
    expect(useWorkspaceModeStore.getState().active).toBe('write');
  });

  it('une façade en train de partir n’est pas celle qu’on rend', async () => {
    const leaving = fakeFacade([]);
    const arriving = fakeFacade([]);
    useEditorStore.setState({ editorFacade: leaving });
    stopMounting = editorMountsOnWrite(arriving);

    expect(await ensureWriteEditor()).toBe(arriving);
  });

  it('en Écriture, pendant qu’un document remplace l’autre : attend la façade suivante', async () => {
    const facade = fakeFacade([]);
    useWorkspaceModeStore.setState({ active: 'write' });
    const waiting = ensureWriteEditor();
    useEditorStore.getState().setEditorFacade(facade);

    expect(await waiting).toBe(facade);
  });

  it('rien ne monte : null à l’échéance, et l’appelant décide', async () => {
    vi.useFakeTimers();
    const waiting = ensureWriteEditor(100);
    await vi.advanceTimersByTimeAsync(100);

    expect(await waiting).toBeNull();
  });
});
