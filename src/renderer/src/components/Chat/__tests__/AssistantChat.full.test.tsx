// @vitest-environment jsdom
/**
 * AssistantChat variant="full" (ex-BrainstormChat, étape 5 de la fusion) —
 * round-trip + tool-call + explanation.
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
vi.mock('../RAGSettingsPanel', () => ({ RAGSettingsPanel: () => null }));
vi.mock('../ModeSelector', () => ({ ModeSelector: () => null }));
vi.mock('../useChatSettingsProjection', () => ({
  useChatSettingsProjection: () => undefined,
}));

import { AssistantChat } from '../AssistantChat';
import { useChatStore, type BrainstormSource } from '../../../stores/chatStore';

type ChunkCb = (env: { sessionId: string; chunk: { delta: string; done?: boolean; finishReason?: string } }) => void;
type CtxCb = (env: { sessionId: string; sources: BrainstormSource[] }) => void;
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
  _emitContext: CtxCb;
  _emitTool: ToolCb;
  _emitExplanation: ExplCb;
}

function installFusionMock(): MockApi {
  let chunkCb: ChunkCb = () => {};
  let ctxCb: CtxCb = () => {};
  let toolCb: ToolCb = () => {};
  let explCb: ExplCb = () => {};
  const api = {
    start: vi.fn(async () => ({ success: true, sessionId: 'sess-b-1' })),
    cancel: vi.fn(async () => ({ success: true, cancelled: true })),
    onChunk: vi.fn((cb: ChunkCb) => {
      chunkCb = cb;
      return () => undefined;
    }),
    onContext: vi.fn((cb: CtxCb) => {
      ctxCb = cb;
      return () => undefined;
    }),
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
    // AssistantChat lit la config LLM au montage (garde de consentement +
    // modèle actif pour les propositions) — sans ce mock, l'effet crashe.
    config: { get: vi.fn(async () => null) },
  } as never;
  Object.defineProperty(api, '_emitChunk', { get: () => chunkCb });
  Object.defineProperty(api, '_emitContext', { get: () => ctxCb });
  Object.defineProperty(api, '_emitTool', { get: () => toolCb });
  Object.defineProperty(api, '_emitExplanation', { get: () => explCb });
  return api as unknown as MockApi;
}

describe('AssistantChat full (fusion step 6)', () => {
  beforeEach(() => {
    useChatStore.getState().reset();
  });
  afterEach(() => {
    cleanup();
  });

  it('send → start → stream → done renders the assistant reply', async () => {
    const api = installFusionMock();
    render(<AssistantChat variant="full" />);

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
    render(<AssistantChat variant="full" />);

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
    render(<AssistantChat variant="full" />);

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

  /** Un tour complet dont le contexte porte `sources`, jusqu'au rendu de la liste. */
  async function roundTripWithSources(api: MockApi, sources: BrainstormSource[]): Promise<HTMLElement> {
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'q' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(api.start).toHaveBeenCalled());
    await waitFor(() => expect(useChatStore.getState().pendingAssistantId).not.toBeNull());
    act(() => {
      api._emitContext({ sessionId: 'sess-b-1', sources });
    });
    act(() => {
      api._emitChunk({ sessionId: 'sess-b-1', chunk: { delta: 'x', done: true, finishReason: 'stop' } });
    });
    return screen.findByTestId('sources-summary');
  }

  // Le manuscrit n'est pas une source : le prompt le dit au modèle, l'en-tête
  // doit le dire à l'auteur (docs/poids-du-manuscrit.md). Le mock de
  // react-i18next (vitest.setup.ts) rend la clé : un badge traduit se
  // reconnaît à sa clé, un badge brut au mot français.
  it('compte le manuscrit à part des sources et traduit le badge', async () => {
    const api = installFusionMock();
    render(<AssistantChat variant="full" />);

    const summary = await roundTripWithSources(api, [
      { kind: 'bibliographie', sourceType: 'secondary', title: 'Papert 1980', snippet: 'p', similarity: 0.8 },
      { kind: 'manuscrit', sourceType: 'manuscript', title: 'Chapitre 2', snippet: 'm', similarity: 0.9 },
    ]);
    expect(summary.textContent).toContain('chat.brainstorm.sourcesLabel (1)');
    expect(summary.textContent).toContain('chat.brainstorm.manuscriptLabel (1)');
    expect(summary.textContent).not.toContain('readingNotesLabel');

    const badge = screen.getByTestId('source-badge-1').querySelector('.brainstorm-chat__source-kind');
    expect(badge?.textContent).toBe('chat.sourceKind.manuscrit');
    expect(screen.queryByText('manuscrit')).not.toBeInTheDocument();
    // La teinte neutre du CSS est accrochée au sourceType, pas au kind.
    expect(screen.getByTestId('source-badge-1').closest('li')?.className).toContain(
      'brainstorm-chat__source--manuscript'
    );
  });

  it('affiche « Sources (0) » quand seul le texte de l’auteur a été retenu', async () => {
    const api = installFusionMock();
    render(<AssistantChat variant="full" />);

    const summary = await roundTripWithSources(api, [
      { kind: 'manuscrit', sourceType: 'manuscript', title: 'Chapitre 2', snippet: 'm', similarity: 0.9 },
      { kind: 'lecture', sourceType: 'readingNotes', title: 'Note Papert', snippet: 'n', similarity: 0.7 },
    ]);
    expect(summary.textContent).toContain('chat.brainstorm.sourcesLabel (0)');
    expect(summary.textContent).toContain('chat.brainstorm.manuscriptLabel (1)');
    expect(summary.textContent).toContain('chat.brainstorm.readingNotesLabel (1)');
  });
});
