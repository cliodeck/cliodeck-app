// @vitest-environment jsdom
/**
 * Le modèle qui signe un brouillon ou une proposition est celui qui a écrit la réponse (S16-1-23).
 *
 * Le chat le devinait à partir des réglages : le modèle Ollama du panneau, ou celui des réglages,
 * lu au montage et relu seulement quand le panneau changeait. En génération embarquée (Mac sans
 * Ollama), chaque brouillon et chaque proposition étaient signés du modèle Ollama, et le journal
 * d'usage, qui reçoit le modèle avec l'adjudication, le publiait (ADR 0007). Le main connaît le
 * modèle du tour : le chunk terminal le porte, et la réponse le garde.
 *
 * Vrai chat, vrai flux (`chatStream`), vraie vue CM6, vrais stores ; simulé : le pont `fusion:chat`
 * du preload, dont le test émet les enveloppes comme le main.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

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
import { useProjectStore } from '../../../stores/projectStore';
import { useRAGQueryStore } from '../../../stores/ragQueryStore';
import { useWorkspaceModeStore } from '../../../stores/workspaceModeStore';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

const DOC = '/p/article/document.md';
const TEXT = '# Titre\n\nPremier paragraphe.\n';
const ANSWER = 'Le préfet Chiappe a interdit la manifestation.';
/** Le modèle embarqué qui a répondu, Ollama absent. */
const EMBEDDED = 'qwen3-4b-instruct';

interface ChunkEnv {
  sessionId: string;
  chunk: { delta: string; done?: boolean; finishReason?: string };
  model?: string;
}

let emitChunk: (env: ChunkEnv) => void = () => undefined;
let start: ReturnType<typeof vi.fn>;
let recordAdjudication: ReturnType<typeof vi.fn>;

const queued = () => useDraftsStore.getState().drafts;
const session = (): string =>
  (start.mock.calls.at(-1) as [unknown, { sessionId: string }] | undefined)?.[1].sessionId ?? '';

const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** Comme MainLayout : le chat au centre du Brainstorm, l'éditeur au centre de l'Écriture. */
const Brainstormer: React.FC = () => {
  const mode = useWorkspaceModeStore((s) => s.active);
  return mode === 'write' ? <CodeMirrorEditor /> : <AssistantChat variant="full" />;
};

/** Pose une question, et le main répond par `ANSWER`, terminal compris, comme `fusion-chat-service`. */
async function answer(terminal: Partial<ChunkEnv> = {}): Promise<void> {
  const textarea = screen.getByRole('textbox');
  fireEvent.change(textarea, { target: { value: 'Qui a interdit la manifestation ?' } });
  await act(async () => {
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
  });
  await wait(10);
  act(() => emitChunk({ sessionId: session(), chunk: { delta: ANSWER } }));
  act(() =>
    emitChunk({ sessionId: session(), chunk: { delta: '', done: true, finishReason: 'stop' }, ...terminal })
  );
  await wait(10);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetEditorStates();
  start = vi.fn(async (_messages: unknown, opts?: { sessionId?: string }) => ({
    success: true,
    sessionId: opts?.sessionId,
  }));
  recordAdjudication = vi.fn();
  (window as unknown as { electron: unknown }).electron = {
    fusion: {
      chat: {
        start,
        cancel: vi.fn(async () => ({ success: true })),
        onChunk: (cb: (env: ChunkEnv) => void) => {
          emitChunk = cb;
          return () => undefined;
        },
        onContext: () => () => undefined,
        onToolCall: () => () => undefined,
        onExplanation: () => () => undefined,
        onStatus: () => () => undefined,
      },
    },
    // Les réglages : Ollama, `llama3.2`. C'est d'eux que le chat devinait le modèle.
    config: {
      get: vi.fn(async (key: string) =>
        key === 'llm' ? { backend: 'ollama', ollamaChatModel: 'llama3.2', generationProvider: 'embedded' } : null
      ),
    },
    editor: {
      saveFile: vi.fn(async () => ({ success: true })),
      onInsertText: () => () => undefined,
    },
    proposals: { recordAdjudication },
    ipcRenderer: { on: () => () => undefined },
  };
  // Le modèle Ollama choisi dans le panneau du chat : le main ne l'applique pas à l'embarqué.
  useRAGQueryStore.setState((s) => ({ params: { ...s.params, model: 'mistral-nemo' } }));
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
  useDraftsStore.setState({ drafts: [], isPanelOpen: false });
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

describe('le modèle d’une réponse, jusqu’au brouillon et au journal d’usage', () => {
  it('« Mettre en brouillon » : le brouillon est signé du modèle qui a répondu, pas du modèle Ollama du panneau', async () => {
    await act(async () => {
      render(<AssistantChat variant="full" />);
    });
    await answer({ model: EMBEDDED });

    fireEvent.click(screen.getByText('drafts.enqueue'));

    expect(queued()).toHaveLength(1);
    expect(queued()[0].source?.model).toBe(EMBEDDED);
  });

  it('« Envoyer vers l’écriture » : la proposition acceptée inscrit au journal le modèle qui a répondu', async () => {
    await act(async () => {
      render(<Brainstormer />);
    });
    await answer({ model: EMBEDDED });

    await act(async () => {
      fireEvent.click(screen.getByText('chat.brainstorm.sendToWrite'));
    });
    await wait(10);
    const accept = document.querySelector('.cm-proposal-box')?.querySelectorAll('button')[0];
    if (!accept) throw new Error('Aucune proposition à l’écran');
    act(() => void fireEvent.mouseDown(accept));

    expect(recordAdjudication).toHaveBeenCalledTimes(1);
    expect(recordAdjudication.mock.calls[0][0]).toMatchObject({ decision: 'accepted', model: EMBEDDED });
  });

  it('une réponse dont le terminal ne dit pas le modèle est signée « unknown », jamais devinée', async () => {
    await act(async () => {
      render(<AssistantChat variant="full" />);
    });
    await answer();

    fireEvent.click(screen.getByText('drafts.enqueue'));

    expect(queued()[0].source?.model).toBe('unknown');
  });
});
