// @vitest-environment jsdom
/**
 * « Envoyer vers Write » : ce que voit l'auteur, jusqu'au texte du document.
 *
 * Vrai chat, vraie vue CM6, vrais stores. Le bouton insérait AVANT de basculer de mode : sans
 * éditeur monté, la réponse entrait dans le miroir en fin de fichier, comme du texte définitif,
 * sans rien à accepter ni à annuler.
 */
import React, { useEffect, useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

vi.mock('../RAGSettingsPanel', () => ({ RAGSettingsPanel: () => null }));
vi.mock('../ModeSelector', () => ({ ModeSelector: () => null }));
vi.mock('../useChatSettingsProjection', () => ({ useChatSettingsProjection: () => undefined }));
vi.mock('../../Methodology/HelperTooltip', () => ({ HelperTooltip: () => null }));
vi.mock('../../Brainstorm/ContextGraph', () => ({ ContextGraph: () => null }));

import { AssistantChat } from '../AssistantChat';
import { CodeMirrorEditor } from '../../Editor/CodeMirrorEditor';
import { resetEditorStates } from '../../Editor/editor-state-memory';
import { useChatStore } from '../../../stores/chatStore';
import { useDraftsStore } from '../../../stores/draftsStore';
import { useEditorStore } from '../../../stores/editorStore';
import { useNotificationStore } from '../../../stores/notificationStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useWorkspaceModeStore } from '../../../stores/workspaceModeStore';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

const DOC = '/p/article/document.md';
const TEXT = '# Titre\n\nPremier paragraphe.\n\nSecond paragraphe.\n';
const CURSOR = TEXT.indexOf('Second');
const ANSWER = 'Réponse du modèle, à proposer.';

const editor = () => useEditorStore.getState();
const notices = () => useNotificationStore.getState().notifications.map((n) => n.title);
const queued = () => useDraftsStore.getState().drafts;
const proposalBoxes = () => document.querySelectorAll<HTMLElement>('.cm-proposal-box');

const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** Comme MainLayout : le chat plein au centre du Brainstorm, l'éditeur au centre de l'Écriture. */
const Brainstormer: React.FC = () => {
  const mode = useWorkspaceModeStore((s) => s.active);
  return mode === 'write' ? <CodeMirrorEditor /> : <AssistantChat variant="full" />;
};

/** Le panneau droit reste à l'écran d'un mode à l'autre, et l'éditeur met du temps à monter. */
const SlowEditor: React.FC = () => {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 300);
    return () => clearTimeout(timer);
  }, []);
  return ready ? <CodeMirrorEditor /> : null;
};
const Explorer: React.FC = () => {
  const mode = useWorkspaceModeStore((s) => s.active);
  return (
    <>
      {mode === 'write' && <SlowEditor />}
      <AssistantChat variant="panel" />
    </>
  );
};

/** Le mode Écriture ne monte aucun éditeur : le cas où l'on ne peut pas proposer. */
const NoEditor: React.FC = () => {
  const mode = useWorkspaceModeStore((s) => s.active);
  return mode === 'write' ? null : <AssistantChat variant="full" />;
};

const sendButton = () => screen.getByText('chat.brainstorm.sendToWrite');

async function mount(element: React.ReactElement): Promise<void> {
  await act(async () => {
    render(element);
  });
}

function placeCursorInSavedState(): void {
  // L'auteur avait posé son curseur au milieu avant de quitter l'Écriture.
  const dom = document.querySelector<HTMLElement>('.cm-editor');
  const view = dom && EditorView.findFromDOM(dom);
  if (!view) throw new Error('Pas de vue CM6 montée');
  act(() => {
    view.dispatch({ selection: EditorSelection.cursor(CURSOR) });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetEditorStates();
  (window as unknown as { electron: unknown }).electron = {
    fusion: {
      chat: {
        start: vi.fn(),
        cancel: vi.fn(),
        onChunk: () => () => undefined,
        onContext: () => () => undefined,
        onToolCall: () => () => undefined,
        onExplanation: () => () => undefined,
        onStatus: () => () => undefined,
      },
    },
    config: { get: vi.fn(async () => null) },
    editor: {
      saveFile: vi.fn(async () => ({ success: true })),
      onInsertText: () => () => undefined,
    },
    proposals: { recordAdjudication: () => undefined },
    ipcRenderer: { on: () => () => undefined },
  };
  useProjectStore.setState({
    currentProject: {
      id: 'p1',
      name: 'Article',
      path: '/p/article',
      type: 'article',
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
    loadState: { kind: 'ready', loadedAt: 'avant', path: '/p/article' },
  });
  useEditorStore.setState((s) => ({
    filePath: DOC,
    content: TEXT,
    isDirty: false,
    documentVersion: s.documentVersion + 1,
    settings: { ...s.settings, autoSave: true },
  }));
  useChatStore.getState().reset();
  useChatStore.setState({
    messages: [{ id: 'm1', role: 'assistant', content: ANSWER, timestamp: 1 }],
  } as never);
  useDraftsStore.setState({ drafts: [], isPanelOpen: false });
  useNotificationStore.getState().dismissAll();
  useWorkspaceModeStore.setState({ active: 'brainstorm' });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useEditorStore.setState({ editorFacade: null, filePath: null, content: '', isDirty: false, bufferDetached: false });
  useProjectStore.setState({ currentProject: null, loadState: { kind: 'idle' } });
  useDraftsStore.setState({ drafts: [], isPanelOpen: false });
  useWorkspaceModeStore.setState({ active: 'write' });
});

describe('depuis Brainstorm', () => {
  it('une proposition à l’écran, au curseur conservé, et rien d’écrit : ni miroir, ni fichier', async () => {
    useWorkspaceModeStore.setState({ active: 'write' });
    await mount(<Brainstormer />);
    placeCursorInSavedState();
    await act(async () => {
      useWorkspaceModeStore.getState().setActive('brainstorm');
    });

    await act(async () => {
      fireEvent.click(sendButton());
    });
    await wait(10);

    expect(useWorkspaceModeStore.getState().active).toBe('write');
    expect(proposalBoxes()).toHaveLength(1);
    expect(proposalBoxes()[0].textContent).toContain(ANSWER);
    expect(editor().content).toBe(TEXT);
    expect(editor().isDirty).toBe(false);
    const view = EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!);
    expect(view?.state.doc.toString()).toBe(TEXT);
    expect(view?.posAtDOM(proposalBoxes()[0])).toBe(CURSOR);
    expect(queued()).toEqual([]);
    expect(notices()).toEqual([]);
  });
});

describe('quand on ne peut pas proposer', () => {
  it('l’éditeur ne monte pas : la réponse part au brouillon malgré le chat démonté, et l’auteur le sait', async () => {
    await mount(<NoEditor />);
    await act(async () => {
      fireEvent.click(sendButton());
    });
    expect(useWorkspaceModeStore.getState().active).toBe('write');
    expect(screen.queryByText('chat.brainstorm.sendToWrite')).toBeNull();

    // Au-delà du délai d'attente de l'éditeur, en deçà de la durée du message.
    await wait(5100);

    expect(queued()).toHaveLength(1);
    expect(queued()[0].content).toContain(ANSWER);
    expect(editor().content).toBe(TEXT);
    expect(editor().isDirty).toBe(false);
    expect(notices()).toContain('editor.proposalUnavailable');
  });

  it('livre sans chapitre ouvert : on reste dans le Brainstorm, et le bouton dit « En brouillon »', async () => {
    useProjectStore.setState((s) => ({ currentProject: s.currentProject && { ...s.currentProject, type: 'book' } }));
    useEditorStore.setState({ filePath: null, content: '' });
    await mount(<Brainstormer />);

    await act(async () => {
      fireEvent.click(sendButton());
    });
    await wait(10);

    expect(useWorkspaceModeStore.getState().active).toBe('brainstorm');
    expect(queued()).toHaveLength(1);
    expect(screen.getByText('drafts.enqueued')).toBeTruthy();
    expect(notices()).toContain('editor.proposalUnavailable');
  });
});

describe('deux clics', () => {
  it('pendant l’attente de l’éditeur : une seule proposition', async () => {
    useWorkspaceModeStore.setState({ active: 'explore' });
    await mount(<Explorer />);

    await act(async () => {
      fireEvent.click(sendButton());
    });
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await wait(400);

    expect(useWorkspaceModeStore.getState().active).toBe('write');
    expect(proposalBoxes()).toHaveLength(1);
  });

  it('un double clic dans le panneau, éditeur déjà là : une seule proposition', async () => {
    useWorkspaceModeStore.setState({ active: 'write' });
    await mount(<Explorer />);
    await wait(400);

    // Le premier a tout fait quand le second arrive : c'est le navigateur qui compte les clics.
    await act(async () => {
      fireEvent.click(sendButton(), { detail: 1 });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('chat.brainstorm.sentToWrite'), { detail: 2 });
    });
    await wait(10);

    expect(proposalBoxes()).toHaveLength(1);
  });

  it('renvoyer ensuite, d’un clic simple, reste possible', async () => {
    useWorkspaceModeStore.setState({ active: 'write' });
    await mount(<Explorer />);
    await wait(400);

    await act(async () => {
      fireEvent.click(sendButton(), { detail: 1 });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('chat.brainstorm.sentToWrite'), { detail: 1 });
    });
    await wait(10);

    expect(proposalBoxes()).toHaveLength(2);
  });
});
