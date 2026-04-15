/**
 * useBrainstormChat (fusion phase 3.2).
 *
 * Glue hook: subscribes to the `fusion:chat:chunk` stream, dispatches into
 * `useBrainstormChatStore`, and exposes a `send(content)` / `cancel()`
 * pair for the UI. Hook is separate from the store so unit tests can
 * stimulate the store directly with synthesized envelopes.
 */

import { useCallback, useEffect, useRef } from 'react';
import {
  useBrainstormChatStore,
  type BrainstormSource,
  type BrainstormToolCall,
} from '../../stores/brainstormChatStore';
import type { RAGExplanation } from '../../../../../backend/types/chat-source';

interface ToolCallEnv {
  sessionId: string;
  callId: string;
  name: string;
  status: 'started' | 'done';
  startedAt?: number;
  durationMs?: number;
  ok?: boolean;
  errorMessage?: string;
}

interface FusionChatApi {
  start(
    messages: Array<{ role: string; content: string }>,
    opts?: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
      retrievalOptions?: {
        documentIds?: string[];
        collectionKeys?: string[];
        sourceType?: 'primary' | 'secondary' | 'both' | 'vault';
        topK?: number;
      };
      systemPrompt?: { modeId?: string; customText?: string };
    }
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
  onContext(
    cb: (env: { sessionId: string; sources: BrainstormSource[] }) => void
  ): () => void;
  onToolCall(cb: (env: ToolCallEnv) => void): () => void;
  onExplanation?(
    cb: (env: { sessionId: string; explanation: RAGExplanation }) => void
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
  // Context can arrive before beginAssistant — buffer until the assistant
  // message exists so we can attach sources to it.
  const pendingSources = useRef<Map<string, BrainstormSource[]>>(new Map());
  // Tool-call events may arrive before beginAssistant — buffer by sessionId.
  const pendingToolCalls = useRef<Map<string, ToolCallEnv[]>>(new Map());
  // Explanation may arrive before beginAssistant (unlikely) or after — buffer.
  const pendingExplanation = useRef<Map<string, RAGExplanation>>(new Map());

  useEffect(() => {
    const chat = api();
    if (!chat) return;
    const unsubChunk = chat.onChunk((env) => {
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
    const unsubCtx = chat.onContext((env) => {
      const aId = assistantIdBySession.current.get(env.sessionId);
      if (aId) {
        store.setSources(aId, env.sources);
      } else {
        pendingSources.current.set(env.sessionId, env.sources);
      }
    });
    const applyToolCallEnv = (aId: string, env: ToolCallEnv): void => {
      if (env.status === 'started') {
        const tc: BrainstormToolCall = {
          id: env.callId,
          name: env.name,
          status: 'started',
          startedAt: env.startedAt,
        };
        store.addToolCall(aId, tc);
      } else {
        store.updateToolCall(aId, env.callId, {
          status: 'done',
          durationMs: env.durationMs,
          ok: env.ok,
          errorMessage: env.errorMessage,
        });
      }
    };
    const unsubTool = chat.onToolCall((env) => {
      const aId = assistantIdBySession.current.get(env.sessionId);
      if (aId) {
        applyToolCallEnv(aId, env);
      } else {
        const arr = pendingToolCalls.current.get(env.sessionId) ?? [];
        arr.push(env);
        pendingToolCalls.current.set(env.sessionId, arr);
      }
    });
    const unsubExpl = chat.onExplanation?.((env) => {
      const aId = assistantIdBySession.current.get(env.sessionId);
      if (aId) {
        store.setExplanation(aId, env.explanation);
      } else {
        pendingExplanation.current.set(env.sessionId, env.explanation);
      }
    });
    return () => {
      unsubChunk();
      unsubCtx();
      unsubTool();
      unsubExpl?.();
    };
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
      // Pull the persisted chat settings off the store and forward them
      // every turn. Undefined fields are fine — the main-side handler
      // treats the whole bag as optional.
      const settings = useBrainstormChatStore.getState().chatSettings;
      const startOpts: Parameters<typeof chat.start>[1] = {};
      if (settings.retrieval) startOpts.retrievalOptions = settings.retrieval;
      if (settings.modeId || settings.customSystemPrompt) {
        startOpts.systemPrompt = {
          modeId: settings.modeId,
          customText: settings.customSystemPrompt,
        };
      }
      const res = await chat.start(payload, startOpts);
      if (!res.success || !res.sessionId) {
        // eslint-disable-next-line no-console
        console.error('[brainstorm] start failed', res.error);
        return;
      }
      const aId = store.beginAssistant(res.sessionId);
      assistantIdBySession.current.set(res.sessionId, aId);
      // Flush any context event that raced ahead of beginAssistant.
      const buffered = pendingSources.current.get(res.sessionId);
      if (buffered) {
        store.setSources(aId, buffered);
        pendingSources.current.delete(res.sessionId);
      }
      const bufferedTools = pendingToolCalls.current.get(res.sessionId);
      if (bufferedTools) {
        for (const env of bufferedTools) {
          if (env.status === 'started') {
            store.addToolCall(aId, {
              id: env.callId,
              name: env.name,
              status: 'started',
              startedAt: env.startedAt,
            });
          } else {
            store.updateToolCall(aId, env.callId, {
              status: 'done',
              durationMs: env.durationMs,
              ok: env.ok,
              errorMessage: env.errorMessage,
            });
          }
        }
        pendingToolCalls.current.delete(res.sessionId);
      }
      const bufferedExpl = pendingExplanation.current.get(res.sessionId);
      if (bufferedExpl) {
        store.setExplanation(aId, bufferedExpl);
        pendingExplanation.current.delete(res.sessionId);
      }
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
