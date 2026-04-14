/**
 * Brainstorm chat store (fusion phase 3.2).
 *
 * Holds the message history and in-flight stream state for the Brainstorm
 * mode. Messages are richer than provider `ChatMessage` only in two ways:
 * `id` for React keys and `pending` so the UI can render the in-progress
 * assistant turn. Citations are first-class via `meta.ragCitation` (carried
 * through to the provider via `ChatMessageMeta` from phase 4.2).
 *
 * The store does NOT directly call IPC — `useBrainstormChat` (a hook) wires
 * the IPC subscription so unit tests can drive the store with synthesized
 * envelopes.
 */

import { create } from 'zustand';

export interface BrainstormSource {
  kind: 'archive' | 'bibliographie' | 'note';
  sourceType: 'primary' | 'secondary' | 'vault';
  title: string;
  snippet: string;
  similarity: number;
  relativePath?: string;
}

export interface BrainstormMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  pending?: boolean;
  /** True if this turn carries a verbatim RAG citation that must be preserved. */
  ragCitation?: boolean;
  finishReason?: string;
  error?: string;
  /** Retrieval hits attached to the assistant turn (RAG sources). */
  sources?: BrainstormSource[];
  /** Tool calls performed during this assistant turn (in order). */
  toolCalls?: BrainstormToolCall[];
}

export interface BrainstormToolCall {
  id: string;
  name: string;
  status: 'started' | 'done';
  startedAt?: number;
  durationMs?: number;
  ok?: boolean;
  errorMessage?: string;
}

interface State {
  messages: BrainstormMessage[];
  /** Active server-side sessionId; null when idle. */
  sessionId: string | null;
  /** Per-session id of the assistant message currently being filled. */
  pendingAssistantId: string | null;

  appendUser: (content: string) => string;
  beginAssistant: (sessionId: string) => string;
  appendDelta: (assistantId: string, delta: string) => void;
  setSources: (assistantId: string, sources: BrainstormSource[]) => void;
  addToolCall: (assistantId: string, toolCall: BrainstormToolCall) => void;
  updateToolCall: (
    assistantId: string,
    callId: string,
    patch: Partial<BrainstormToolCall>
  ) => void;
  finishAssistant: (
    assistantId: string,
    finishReason?: string,
    error?: string
  ) => void;
  cancel: () => void;
  reset: () => void;
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export const useBrainstormChatStore = create<State>((set) => ({
  messages: [],
  sessionId: null,
  pendingAssistantId: null,

  appendUser: (content) => {
    const id = nextId('u');
    set((s) => ({
      messages: [...s.messages, { id, role: 'user', content }],
    }));
    return id;
  },

  beginAssistant: (sessionId) => {
    const id = nextId('a');
    set((s) => ({
      sessionId,
      pendingAssistantId: id,
      messages: [
        ...s.messages,
        { id, role: 'assistant', content: '', pending: true },
      ],
    }));
    return id;
  },

  appendDelta: (assistantId, delta) => {
    if (!delta) return;
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === assistantId ? { ...m, content: m.content + delta } : m
      ),
    }));
  },

  setSources: (assistantId, sources) => {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === assistantId ? { ...m, sources } : m
      ),
    }));
  },

  addToolCall: (assistantId, toolCall) => {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === assistantId
          ? { ...m, toolCalls: [...(m.toolCalls ?? []), toolCall] }
          : m
      ),
    }));
  },

  updateToolCall: (assistantId, callId, patch) => {
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id !== assistantId || !m.toolCalls) return m;
        return {
          ...m,
          toolCalls: m.toolCalls.map((tc) =>
            tc.id === callId ? { ...tc, ...patch } : tc
          ),
        };
      }),
    }));
  },

  finishAssistant: (assistantId, finishReason, error) => {
    set((s) => ({
      sessionId: null,
      pendingAssistantId: null,
      messages: s.messages.map((m) =>
        m.id === assistantId
          ? { ...m, pending: false, finishReason, error }
          : m
      ),
    }));
  },

  cancel: () => {
    set((s) => {
      if (!s.pendingAssistantId) return {};
      return {
        sessionId: null,
        pendingAssistantId: null,
        messages: s.messages.map((m) =>
          m.id === s.pendingAssistantId
            ? { ...m, pending: false, finishReason: 'cancelled' }
            : m
        ),
      };
    });
  },

  reset: () => {
    set({ messages: [], sessionId: null, pendingAssistantId: null });
  },
}));
