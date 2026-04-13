/**
 * useBrainstormChat (fusion phase 3.2).
 *
 * Glue hook: subscribes to the `fusion:chat:chunk` stream, dispatches into
 * `useBrainstormChatStore`, and exposes a `send(content)` / `cancel()`
 * pair for the UI. Hook is separate from the store so unit tests can
 * stimulate the store directly with synthesized envelopes.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useBrainstormChatStore } from '../../stores/brainstormChatStore';

interface FusionChatApi {
  start(
    messages: Array<{ role: string; content: string }>,
    opts?: { model?: string; temperature?: number; maxTokens?: number }
  ): Promise<{ success: boolean; sessionId?: string; error?: string }>;
  cancel(sessionId: string): Promise<{ success: boolean; cancelled?: boolean }>;
  onChunk(
    cb: (env: {
      sessionId: string;
      chunk: {
        delta: string;
        done?: boolean;
        finishReason?: string;
      };
      error?: { code: string; message: string };
    }) => void
  ): () => void;
}

function api(): FusionChatApi | null {
  const f = (window as unknown as { electron?: { fusion?: { chat?: FusionChatApi } } })
    .electron?.fusion?.chat;
  return f ?? null;
}

export interface UseBrainstormChat {
  send: (content: string) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
  isStreaming: boolean;
  error: string | null;
}

export function useBrainstormChat(): UseBrainstormChat {
  const store = useBrainstormChatStore();
  // Remember the current assistant id per active session so we don't mix
  // them up when the user sends fast follow-ups.
  const assistantIdBySession = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const chat = api();
    if (!chat) return;
    const unsub = chat.onChunk((env) => {
      const aId = assistantIdBySession.current.get(env.sessionId);
      if (!aId) return;
      if (env.error) {
        store.finishAssistant(
          aId,
          env.chunk.finishReason ?? 'error',
          env.error.message
        );
        assistantIdBySession.current.delete(env.sessionId);
        return;
      }
      if (env.chunk.delta) store.appendDelta(aId, env.chunk.delta);
      if (env.chunk.done) {
        store.finishAssistant(aId, env.chunk.finishReason);
        assistantIdBySession.current.delete(env.sessionId);
      }
    });
    return unsub;
    // store methods are stable references (zustand), deps intentionally minimal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      const chat = api();
      if (!chat) {
        // eslint-disable-next-line no-console
        console.warn('[brainstorm] fusion API not exposed');
        return;
      }
      // Capture user message, then prep the assistant placeholder before
      // firing IPC — chunks may land before the IPC promise resolves.
      const priorMessages = useBrainstormChatStore.getState().messages;
      store.appendUser(trimmed);

      const payload = [
        ...priorMessages.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user' as const, content: trimmed },
      ];
      const res = await chat.start(payload);
      if (!res.success || !res.sessionId) {
        // eslint-disable-next-line no-console
        console.error('[brainstorm] start failed', res.error);
        return;
      }
      const aId = store.beginAssistant(res.sessionId);
      assistantIdBySession.current.set(res.sessionId, aId);
    },
    [store]
  );

  const cancel = useCallback(async () => {
    const sid = useBrainstormChatStore.getState().sessionId;
    if (!sid) return;
    const chat = api();
    await chat?.cancel(sid);
    store.cancel();
    assistantIdBySession.current.delete(sid);
  }, [store]);

  const isStreaming = store.pendingAssistantId !== null;
  const lastError =
    store.messages.slice(-1)[0]?.error ?? null;

  return {
    send,
    cancel,
    reset: store.reset,
    isStreaming,
    error: lastError,
  };
}
