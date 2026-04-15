// @vitest-environment jsdom
/**
 * ChatInterface (Write mode) post-fusion (step 4b) roundtrip.
 *
 * Drives the fusion:chat:* mock IPC through a single user→assistant
 * exchange and asserts the rendered bubbles match the synthesized
 * stream, proving the Write UI now runs on the unified pipeline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// Silence the RAGSettingsPanel — it pulls heavy stores we don't need here.
vi.mock('../RAGSettingsPanel', () => ({
  RAGSettingsPanel: () => null,
}));
vi.mock('../ModeSelector', () => ({
  ModeSelector: () => null,
}));
vi.mock('../../Methodology/HelperTooltip', () => ({
  HelperTooltip: () => null,
}));

import { ChatInterface } from '../ChatInterface';
import { useChatStore } from '../../../stores/chatStore';

type ChunkCb = (env: { sessionId: string; chunk: { delta: string; done?: boolean; finishReason?: string } }) => void;

interface MockApi {
  start: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  onChunk: ReturnType<typeof vi.fn>;
  onContext: ReturnType<typeof vi.fn>;
  onToolCall: ReturnType<typeof vi.fn>;
  onExplanation: ReturnType<typeof vi.fn>;
  onStatus: ReturnType<typeof vi.fn>;
  // Test handles:
  _emitChunk: ChunkCb;
}

function installFusionMock(): MockApi {
  let chunkCb: ChunkCb = () => {};
  const api = {
    start: vi.fn(async () => ({ success: true, sessionId: 'sess-test-1' })),
    cancel: vi.fn(async () => ({ success: true, cancelled: true })),
    onChunk: vi.fn((cb: ChunkCb) => {
      chunkCb = cb;
      return () => undefined;
    }),
    onContext: vi.fn(() => () => undefined),
    onToolCall: vi.fn(() => () => undefined),
    onExplanation: vi.fn(() => () => undefined),
    onStatus: vi.fn(() => () => undefined),
  };
  (window as unknown as { electron: { fusion: { chat: unknown } } }).electron = {
    fusion: { chat: api },
  } as never;
  Object.defineProperty(api, '_emitChunk', {
    get: () => chunkCb,
  });
  return api as unknown as MockApi;
}

describe('ChatInterface (fusion step 4b)', () => {
  beforeEach(() => {
    useChatStore.getState().reset();
  });
  afterEach(() => {
    cleanup();
  });

  it('send → start → stream → done renders the assistant reply', async () => {
    const api = installFusionMock();
    render(<ChatInterface />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'bonjour' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));

    // The server acknowledges → the store assigns a pending assistant.
    await waitFor(() => {
      expect(useChatStore.getState().pendingAssistantId).not.toBeNull();
    });

    // Emit a delta then done.
    act(() => {
      api._emitChunk({ sessionId: 'sess-test-1', chunk: { delta: 'Salut !' } });
    });
    act(() => {
      api._emitChunk({ sessionId: 'sess-test-1', chunk: { delta: '', done: true, finishReason: 'stop' } });
    });

    await waitFor(() => {
      const msgs = useChatStore.getState().messages;
      expect(msgs.some((m) => m.role === 'user' && m.content === 'bonjour')).toBe(true);
      expect(
        msgs.some((m) => m.role === 'assistant' && m.content === 'Salut !' && !m.pending)
      ).toBe(true);
    });
  });
});
