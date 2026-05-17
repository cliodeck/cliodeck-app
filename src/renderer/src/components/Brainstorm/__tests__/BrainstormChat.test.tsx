// @vitest-environment jsdom
/**
 * BrainstormChat (fusion step 6) — round-trip + tool-call + explanation.
 *
 * Drives the unified `fusion:chat:*` IPC through a single user→assistant
 * turn and asserts:
 *   1. The streamed assistant content lands in the store & DOM.
 *   2. A tool-call envelope (started → done) surfaces a badge in the UI.
 *   3. An explanation envelope renders the collapsible ExplanationPanel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

// Heavy siblings — silence for the round-trip under test.
vi.mock('../../Chat/RAGSettingsPanel', () => ({ RAGSettingsPanel: () => null }));
vi.mock('../../Chat/ModeSelector', () => ({ ModeSelector: () => null }));
vi.mock('../../Chat/useChatSettingsProjection', () => ({
  useChatSettingsProjection: () => undefined,
}));

import { BrainstormChat } from '../BrainstormChat';
import { useChatStore } from '../../../stores/chatStore';

type ChunkCb = (env: { sessionId: string; chunk: { delta: string; done?: boolean; finishReason?: string } }) => void;
type ToolCb = (env: {
  sessionId: string;
  callId: string;
  name: string;
  status: 'started' | 'done';
  startedAt?: number;
  durationMs?: number;
  ok?: boolean;
  errorMessage?: string;
}) => void;
type ExplCb = (env: { sessionId: string; explanation: unknown }) => void;

interface MockApi {
  start: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  onChunk: ReturnType<typeof vi.fn>;
  onContext: ReturnType<typeof vi.fn>;
  onToolCall: ReturnType<typeof vi.fn>;
  onExplanation: ReturnType<typeof vi.fn>;
  onStatus: ReturnType<typeof vi.fn>;
  _emitChunk: ChunkCb;
  _emitTool: ToolCb;
  _emitExplanation: ExplCb;
}

function installFusionMock(): MockApi {
  let chunkCb: ChunkCb = () => {};
  let toolCb: ToolCb = () => {};
  let explCb: ExplCb = () => {};
  const api = {
    start: vi.fn(async () => ({ success: true, sessionId: 'sess-b-1' })),
    cancel: vi.fn(async () => ({ success: true, cancelled: true })),
    onChunk: vi.fn((cb: ChunkCb) => {
      chunkCb = cb;
      return () => undefined;
    }),
    onContext: vi.fn(() => () => undefined),
    onToolCall: vi.fn((cb: ToolCb) => {
      toolCb = cb;
      return () => undefined;
    }),
    onExplanation: vi.fn((cb: ExplCb) => {
      explCb = cb;
      return () => undefined;
    }),
    onStatus: vi.fn(() => () => undefined),
  };
  (window as unknown as { electron: { fusion: { chat: unknown } } }).electron = {
    fusion: { chat: api },
  } as never;
  Object.defineProperty(api, '_emitChunk', { get: () => chunkCb });
  Object.defineProperty(api, '_emitTool', { get: () => toolCb });
  Object.defineProperty(api, '_emitExplanation', { get: () => explCb });
  return api as unknown as MockApi;
}

describe('BrainstormChat (fusion step 6)', () => {
  beforeEach(() => {
    useChatStore.getState().reset();
  });
  afterEach(() => {
    cleanup();
  });

  it('send → start → stream → done renders the assistant reply', async () => {
    const api = installFusionMock();
    render(<BrainstormChat />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(useChatStore.getState().pendingAssistantId).not.toBeNull();
    });

    act(() => {
      api._emitChunk({ sessionId: 'sess-b-1', chunk: { delta: 'Hi!' } });
    });
    act(() => {
      api._emitChunk({ sessionId: 'sess-b-1', chunk: { delta: '', done: true, finishReason: 'stop' } });
    });

    await waitFor(() => {
      const msgs = useChatStore.getState().messages;
      expect(msgs.some((m) => m.role === 'assistant' && m.content === 'Hi!' && !m.pending)).toBe(true);
    });
  });

  it('renders a tool-call badge when onToolCall fires with status=done', async () => {
    const api = installFusionMock();
    render(<BrainstormChat />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'q' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(api.start).toHaveBeenCalled());
    await waitFor(() => expect(useChatStore.getState().pendingAssistantId).not.toBeNull());

    act(() => {
      api._emitTool({
        sessionId: 'sess-b-1',
        callId: 'call-1',
        name: 'searchObsidian',
        status: 'started',
        startedAt: Date.now(),
      });
    });
    act(() => {
      api._emitTool({
        sessionId: 'sess-b-1',
        callId: 'call-1',
        name: 'searchObsidian',
        status: 'done',
        durationMs: 42,
        ok: true,
      });
    });
    act(() => {
      api._emitChunk({ sessionId: 'sess-b-1', chunk: { delta: 'done', done: true, finishReason: 'stop' } });
    });

    await waitFor(() => {
      expect(screen.getByText('searchObsidian')).toBeInTheDocument();
      expect(screen.getByText(/42ms/)).toBeInTheDocument();
    });
  });

  it('renders the ExplanationPanel when onExplanation fires', async () => {
    const api = installFusionMock();
    render(<BrainstormChat />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'q' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(api.start).toHaveBeenCalled());
    await waitFor(() => expect(useChatStore.getState().pendingAssistantId).not.toBeNull());

    const explanation = {
      search: {
        totalResults: 7,
        searchDurationMs: 123,
        cacheHit: false,
        sourceType: 'primary' as const,
        documents: [],
      },
      llm: {
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        contextWindow: 200000,
        temperature: 0.7,
        promptSize: 4200,
      },
      timing: {
        searchMs: 123,
        generationMs: 800,
        totalMs: 923,
      },
    };
    act(() => {
      api._emitExplanation({ sessionId: 'sess-b-1', explanation });
    });
    act(() => {
      api._emitChunk({ sessionId: 'sess-b-1', chunk: { delta: 'x', done: true, finishReason: 'stop' } });
    });

    // Collapsed by default — the toggle is present.
    const toggle = await screen.findByRole('button', { name: /Comment cette réponse|chat.showExplanation/ });
    expect(toggle).toBeInTheDocument();
    // Expand and verify search stats render.
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(screen.getByTestId('explanation-content')).toBeInTheDocument();
      expect(screen.getByTestId('explanation-content').textContent).toContain('7');
      expect(screen.getByTestId('explanation-content').textContent).toContain('123ms');
    });
  });
});
