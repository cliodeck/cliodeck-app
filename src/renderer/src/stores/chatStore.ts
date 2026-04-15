/**
 * Unified chat store (fusion step 4b).
 *
 * Replaces the legacy `chatStore` (RAG Write mode) and the Brainstorm
 * `brainstormChatStore` with one canonical store. Both Write and
 * Brainstorm UIs now drive the same backend pipeline (`fusion:chat:*`).
 *
 * Shape: session-oriented (sessionId, pendingAssistantId) like the
 * previous Brainstorm store, with optional legacy RAG fields
 * (`ragUsed`, `explanation`, `modeId`, `timestamp`, `isError`) carried on
 * each message so existing Write-side consumers keep working unchanged.
 *
 * Soft migration: if a legacy `cliodeck-chat` key is found in
 * localStorage at first import, we best-effort translate it into the new
 * format under `cliodeck-chat-v2` and delete the old key. Migration
 * failure is swallowed — UX must never break because of a stale key.
 */

import { create } from 'zustand';
import type { RAGExplanation as RAGExplanationBackend } from '../../../../backend/types/chat-source';

// MARK: - Types (brainstorm, canonical)

export interface BrainstormSource {
  kind: 'archive' | 'bibliographie' | 'note';
  sourceType: 'primary' | 'secondary' | 'vault';
  title: string;
  snippet: string;
  similarity: number;
  relativePath?: string;
  documentId?: string;
  pageNumber?: number;
  chunkOffset?: number;
  itemId?: string;
  imagePath?: string;
  notePath?: string;
  lineNumber?: number;
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

export interface BrainstormMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  pending?: boolean;
  ragCitation?: boolean;
  finishReason?: string;
  error?: string;
  sources?: BrainstormSource[];
  toolCalls?: BrainstormToolCall[];
  // Legacy-parity fields (carried for Write mode):
  ragUsed?: boolean;
  explanation?: RAGExplanationBackend;
  modeId?: string;
  /** Legacy Write mode populates this; Brainstorm leaves it unset. */
  timestamp?: Date;
  /** Error flag used by the Write UI (error messages rendered in red). */
  isError?: boolean;
}

// MARK: - Legacy aliases (consumers still import these names)

/**
 * Historical RAGExplanation shape used by `ExplanationPanel`. The backend
 * emits a structurally compatible object through `fusion:chat:explanation`.
 */
export type RAGExplanation = RAGExplanationBackend;

/**
 * Legacy ChatMessage alias — kept so Write-mode components compile.
 * Structurally identical to BrainstormMessage for purposes of rendering.
 */
export type ChatMessage = BrainstormMessage;

/**
 * Legacy ChatSource alias — the Write-mode source shape used by
 * `RAGMessageExtras` + `SourceCard`. Modeled after the original
 * PDF-centric source; kept assignable from BrainstormSource via the
 * `chatSourceToUnified` adapter in `backend/types/chat-source.ts`.
 */
export interface ChatSource {
  documentId: string;
  documentTitle: string;
  author?: string;
  year?: string;
  pageNumber: number;
  chunkContent: string;
  similarity: number;
}

// MARK: - Chat settings (pass-through to fusion:chat:start)

export interface BrainstormChatRetrievalSettings {
  documentIds?: string[];
  collectionKeys?: string[];
  sourceType?: 'primary' | 'secondary' | 'both' | 'vault';
  /**
   * Opt-in to the Obsidian vault even when `sourceType` is not 'vault'.
   * Lets the user mix notes with primary/secondary without forcing a
   * vault-only search. `sourceType === 'vault'` implies vault-only and
   * this flag is ignored.
   */
  includeVault?: boolean;
  topK?: number;
}

export interface BrainstormChatSettings {
  modeId?: string;
  customSystemPrompt?: string;
  retrieval?: BrainstormChatRetrievalSettings;
}

// MARK: - Store

interface State {
  messages: BrainstormMessage[];
  sessionId: string | null;
  pendingAssistantId: string | null;
  chatSettings: BrainstormChatSettings;

  setChatSettings: (patch: Partial<BrainstormChatSettings>) => void;
  appendUser: (content: string) => string;
  beginAssistant: (sessionId: string) => string;
  appendDelta: (assistantId: string, delta: string) => void;
  setSources: (assistantId: string, sources: BrainstormSource[]) => void;
  setExplanation: (assistantId: string, explanation: RAGExplanationBackend) => void;
  setRagUsed: (assistantId: string, ragUsed: boolean) => void;
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

// MARK: - Soft localStorage migration (legacy key → new key)
//
// Legacy Write mode persisted nothing by default, but we defensively
// check a handful of plausible keys and migrate the shape if found.
// Failures are swallowed — UX must never break because of a stale key.

const LEGACY_KEYS = ['cliodeck-chat', 'clio-chat', 'chat-store'];
const NEW_KEY = 'cliodeck-chat-v2';

function runLegacyLocalStorageMigration(): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (window.localStorage.getItem(NEW_KEY)) return;
    for (const key of LEGACY_KEYS) {
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { messages?: unknown };
        const legacyMsgs = Array.isArray(parsed?.messages) ? parsed.messages : [];
        const migrated: BrainstormMessage[] = legacyMsgs.map((m, i) => {
          const src = m as Partial<BrainstormMessage> & { timestamp?: string | Date };
          const ts = src.timestamp
            ? typeof src.timestamp === 'string'
              ? new Date(src.timestamp)
              : src.timestamp
            : undefined;
          return {
            id: src.id ?? `migrated-${i}`,
            role: (src.role as BrainstormMessage['role']) ?? 'user',
            content: src.content ?? '',
            ragUsed: src.ragUsed,
            explanation: src.explanation,
            modeId: src.modeId,
            isError: src.isError,
            timestamp: ts,
          };
        });
        window.localStorage.setItem(
          NEW_KEY,
          JSON.stringify({ messages: migrated })
        );
        window.localStorage.removeItem(key);
      } catch {
        // swallow per-key parse errors; try next
      }
    }
  } catch {
    // Best-effort: never throw from module initialization.
  }
}

runLegacyLocalStorageMigration();

export const useChatStore = create<State>((set) => ({
  messages: [],
  sessionId: null,
  pendingAssistantId: null,
  chatSettings: {},

  setChatSettings: (patch) => {
    set((s) => ({
      chatSettings: {
        ...s.chatSettings,
        ...patch,
        retrieval: patch.retrieval
          ? { ...s.chatSettings.retrieval, ...patch.retrieval }
          : s.chatSettings.retrieval,
      },
    }));
  },

  appendUser: (content) => {
    const id = nextId('u');
    // Capture active mode for display/history, mirroring legacy behaviour.
    let modeId: string | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { useModeStore } = require('./modeStore');
      modeId = useModeStore.getState().activeModeId;
    } catch {
      /* modeStore not available (tests) */
    }
    set((s) => ({
      messages: [
        ...s.messages,
        { id, role: 'user', content, modeId, timestamp: new Date() },
      ],
    }));
    return id;
  },

  beginAssistant: (sessionId) => {
    const id = nextId('a');
    let modeId: string | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { useModeStore } = require('./modeStore');
      modeId = useModeStore.getState().activeModeId;
    } catch {
      /* modeStore not available */
    }
    set((s) => ({
      sessionId,
      pendingAssistantId: id,
      messages: [
        ...s.messages,
        {
          id,
          role: 'assistant',
          content: '',
          pending: true,
          modeId,
          timestamp: new Date(),
        },
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

  setExplanation: (assistantId, explanation) => {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === assistantId ? { ...m, explanation } : m
      ),
    }));
  },

  setRagUsed: (assistantId, ragUsed) => {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === assistantId ? { ...m, ragUsed } : m
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
          ? {
              ...m,
              pending: false,
              finishReason,
              error,
              isError: error ? true : m.isError,
            }
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
    // Preserve chatSettings across reset (user-selected mode / filters
    // should survive a cleared conversation).
    set((s) => ({
      messages: [],
      sessionId: null,
      pendingAssistantId: null,
      chatSettings: s.chatSettings,
    }));
  },
}));

/**
 * Deprecated alias — kept for one release to minimize diff noise.
 * New code should import `useChatStore` directly.
 * @deprecated use `useChatStore`
 */
export const useBrainstormChatStore = useChatStore;
