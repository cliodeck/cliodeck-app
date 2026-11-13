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
import type { SecurityEvent } from '../../../../backend/security/events';
import { useModeStore } from './modeStore';
import { projectLifecycle } from '../lifecycle/projectLifecycle';

// MARK: - Types (brainstorm, canonical)

export interface BrainstormSource {
  /**
   * `manuscrit` : extrait du texte de l'auteur lui-même.
   * `lecture` : extrait d'une note de lecture de l'auteur sur une référence.
   */
  kind: 'archive' | 'bibliographie' | 'note' | 'manuscrit' | 'lecture';
  sourceType: 'primary' | 'secondary' | 'vault' | 'manuscript' | 'readingNotes';
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
  /** Manuscrit : chapitre d'origine, pour rouvrir au bon endroit. */
  chapterId?: string;
  /** Événements de l'inspecteur de sécurité pour ce chunk (#8). */
  securityEvents?: SecurityEvent[];
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
  /** Raisonnement d'un modèle pensant, accumulé à part de la réponse. */
  thinking?: string;
  pending?: boolean;
  ragCitation?: boolean;
  finishReason?: string;
  error?: string;
  /**
   * Le modèle qui a écrit la réponse, dit par le main au terminal du tour. Il signe les brouillons
   * et les propositions (S16-1-23). Une réponse arrêtée par l'auteur le reçoit du terminal
   * `cancelled`, arrivé après l'arrêt (`setModel`). Absent tant que ce terminal n'est pas arrivé, ou
   * quand le tour n'a atteint aucun fournisseur : la réponse est alors signée « unknown ».
   */
  model?: string;
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
  /**
   * `manuscript` = no source ticked, « Mon manuscrit » is (main accepts
   * `includeReadingNotes: true` alongside: manuscript + notes, no sources).
   * `readingNotes` = « Notes de lecture » alone ticked (notes-only).
   */
  sourceType?: 'primary' | 'secondary' | 'both' | 'vault' | 'manuscript' | 'readingNotes';
  /**
   * EFFECTIVE manuscript toggle, already resolved by the renderer against
   * the workspace mode (brainstorm → off by default, elsewhere on).
   * `undefined` is read as `true` by main for legacy callers.
   */
  includeManuscript?: boolean;
  /**
   * EFFECTIVE reading-notes toggle, resolved the same way. `undefined` =
   * legacy caller, admitted by main.
   */
  includeReadingNotes?: boolean;
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
  /** Langue des consignes écrites par l'application (mode par défaut, bloc de contexte). */
  promptLanguage?: 'fr' | 'en';
  retrieval?: BrainstormChatRetrievalSettings;
  /**
   * Posé quand l'utilisateur a coché des cases dont AUCUNE ne sera consultée
   * — son texte seul, écarté pour ce tour (fournisseur distant sans
   * consentement, index coupé, posture du mode). Le tour ne part pas : on
   * n'élargit jamais la portée en silence, et un tour sans aucun contexte
   * sous une case cochée tromperait autant. Clés i18n des raisons.
   */
  sendBlockedReasons?: string[];
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
  appendThinking: (assistantId: string, delta: string) => void;
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
    error?: string,
    model?: string
  ) => void;
  /** Le modèle d'une réponse déjà close (arrêtée), sans rien changer d'autre. */
  setModel: (assistantId: string, model: string) => void;
  cancel: () => void;
  reset: () => void;
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

// NOTE : l'ancienne « migration localStorage » (clé cliodeck-chat-v2) a été
// supprimée à l'étape 5 de la fusion — elle écrivait une clé que rien ne
// relisait (docs/chat-unification-etat-des-lieux.md §2.2). Les messages de
// chat ne sont pas persistés côté UI ; le journal de recherche (brain.db)
// est la seule persistance des conversations.

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
    const modeId = useModeStore.getState().activeModeId;
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
    const modeId = useModeStore.getState().activeModeId;
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

  appendThinking: (assistantId, delta) => {
    if (!delta) return;
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === assistantId ? { ...m, thinking: (m.thinking ?? '') + delta } : m
      ),
    }));
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

  finishAssistant: (assistantId, finishReason, error, model) => {
    // Seule la fin du tour en cours le clôt : celle d'un tour effacé, arrivée après l'envoi du
    // suivant, ôtait à celui-ci son bouton Stop et sa session (S16-1-3).
    set((s) => ({
      ...(assistantId === s.pendingAssistantId && { sessionId: null, pendingAssistantId: null }),
      messages: s.messages.map((m) =>
        m.id === assistantId
          ? {
              ...m,
              pending: false,
              finishReason,
              error,
              ...(model !== undefined && { model }),
              isError: error ? true : m.isError,
            }
          : m
      ),
    }));
  },

  setModel: (assistantId, model) => {
    set((s) => ({
      messages: s.messages.map((m) => (m.id === assistantId ? { ...m, model } : m)),
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

// La conversation appartient au projet où elle a eu lieu (S16-1-22, Q11) : ouvrir un autre projet la
// vide à l'écran, sans quoi elle repartait en historique dans ses tours. Le main a déjà annulé le
// tour en cours, dont la réponse partielle reste au journal du projet quitté. Les réglages restent.
projectLifecycle.onReset('chat', () => useChatStore.getState().reset());
