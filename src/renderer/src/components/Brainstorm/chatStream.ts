/**
 * Le flux du chat, hors de tout composant (L09-6) : un tour appartient à sa session, du premier
 * événement au dernier.
 *
 * Le lien session → bulle vivait dans `useBrainstormChat`, avec ses abonnements. Quitter l'onglet
 * Chat démontait le composant ; l'instance remontée, partie d'une table vide, jetait la suite de la
 * réponse, et la bulle restait « en cours » (S16-1-0). Le lien vit ici, avec un seul abonnement aux
 * événements du main pour toute la vie de l'app. Il se pose avant l'appel à `fusion:chat:start` :
 * un événement émis avant sa réponse — l'erreur d'une clé d'API absente, le refus d'envoi distant —
 * trouve sa bulle (S16-1-20), et rien n'est plus à mettre en attente.
 *
 * Le store se lit par `getState()` et les messages se traduisent par l'instance i18n : un tour se
 * termine sans qu'aucun composant soit monté. Les événements d'une session qu'aucune bulle
 * n'attend (abandonnée, ou d'un projet quitté) sont ignorés.
 */

import i18n from '../../i18n';
import { useChatStore, type BrainstormSource } from '../../stores/chatStore';
import { useRAGQueryStore } from '../../stores/ragQueryStore';
import type { RAGExplanation } from '../../../../../backend/types/chat-source';

export interface ToolCallEnv {
  sessionId: string;
  callId: string;
  name: string;
  status: 'started' | 'done';
  startedAt?: number;
  durationMs?: number;
  ok?: boolean;
  errorMessage?: string;
}

interface ChunkEnv {
  sessionId: string;
  chunk: {
    delta: string;
    thinking?: string;
    done?: boolean;
    finishReason?: string;
  };
  error?: { code: string; message: string };
}

export interface FusionChatApi {
  start(
    messages: Array<{ role: string; content: string }>,
    opts?: {
      /** Identifiant du tour, tiré par le renderer : la bulle est liée avant l'appel. */
      sessionId?: string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
      numCtx?: number;
      topP?: number;
      topK?: number;
      repeatPenalty?: number;
      think?: boolean;
      timeoutMs?: number;
      retrievalOptions?: {
        documentIds?: string[];
        collectionKeys?: string[];
        sourceType?: 'primary' | 'secondary' | 'both' | 'vault' | 'manuscript' | 'readingNotes';
        includeVault?: boolean;
        includeManuscript?: boolean;
        includeReadingNotes?: boolean;
        topK?: number;
      };
      systemPrompt?: { modeId?: string; customText?: string; language?: 'fr' | 'en' };
      enabledTools?: string[];
    }
  ): Promise<{ success: boolean; sessionId?: string; error?: string }>;
  cancel(sessionId: string): Promise<{ success: boolean; cancelled?: boolean }>;
  onChunk(cb: (env: ChunkEnv) => void): () => void;
  onContext(cb: (env: { sessionId: string; sources: BrainstormSource[] }) => void): () => void;
  onToolCall(cb: (env: ToolCallEnv) => void): () => void;
  onExplanation?(
    cb: (env: { sessionId: string; explanation: RAGExplanation }) => void
  ): () => void;
}

/** La bulle de chaque session en cours. */
const assistantBySession = new Map<string, string>();
let subscribedTo: FusionChatApi | null = null;
let unsubscribe: (() => void) | null = null;

/** Le texte d'une erreur de tour. Le main n'a pas la langue de l'interface. */
function errorMessage(error: { code: string; message: string }): string {
  // Le délai d'inactivité est traduit ici : le renderer connaît le délai réglé.
  if (error.code === 'timeout') {
    return i18n.t('chat.timeout', {
      minutes: Math.max(1, Math.round(useRAGQueryStore.getState().params.timeout / 60_000)),
    });
  }
  // Plafond des tours d'outils (S06-1-4) : le moteur écrit sa cause en anglais, pour le journal.
  if (error.code === 'max_tool_turns') return i18n.t('chat.maxToolTurns');
  // Échec côté fournisseur : la cause vient du main, on l'habille. Chaque fournisseur préfixe ses
  // codes de son nom (L09-7).
  if (/^(ollama_|anthropic_|openai_compat_|gemini_|mistral_|embedded_|provider_|stream_)/.test(error.code)) {
    // Les causes que ClioDeck écrit lui-même, faute de message de l'API, se traduisent par leur
    // code : insérées telles quelles, elles restaient en français dans une interface en anglais.
    // Un flux fermé sans signal de fin (un fournisseur, ou `chat-engine` pour un tour d'outils).
    if (/(^|_)stream_incomplete$/.test(error.code)) return i18n.t('chat.streamIncomplete');
    // Un code `_http_2xx` ne naît que d'une réponse acceptée mais sans corps : un refus porte son
    // statut d'échec.
    if (/_http_2\d\d$/.test(error.code)) return i18n.t('chat.emptyResponse');
    // Aucune cause : événement d'erreur vide, ou fournisseur qui n'a rien rangé dans son état
    // (`provider_error`, le repli de `chat-engine`).
    if (error.code === 'provider_error' || !error.message.trim()) {
      return i18n.t('chat.providerNoCause');
    }
    return i18n.t('chat.providerError', { message: error.message });
  }
  return error.message;
}

function onChunk(env: ChunkEnv): void {
  const aId = assistantBySession.get(env.sessionId);
  if (!aId) return;
  const store = useChatStore.getState();
  if (env.error) {
    store.finishAssistant(aId, env.chunk.finishReason ?? 'error', errorMessage(env.error));
    assistantBySession.delete(env.sessionId);
    return;
  }
  // Raisonnement d'un modèle pensant : accumulé à part, jamais dans la réponse. Le compter est ce
  // qui rend l'attente lisible.
  if (env.chunk.thinking) store.appendThinking(aId, env.chunk.thinking);
  if (env.chunk.delta) store.appendDelta(aId, env.chunk.delta);
  if (env.chunk.done) {
    store.finishAssistant(aId, env.chunk.finishReason);
    assistantBySession.delete(env.sessionId);
  }
}

function onContext(env: { sessionId: string; sources: BrainstormSource[] }): void {
  const aId = assistantBySession.get(env.sessionId);
  if (aId) useChatStore.getState().setSources(aId, env.sources);
}

function onToolCall(env: ToolCallEnv): void {
  const aId = assistantBySession.get(env.sessionId);
  if (!aId) return;
  const store = useChatStore.getState();
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

function onExplanation(env: { sessionId: string; explanation: RAGExplanation }): void {
  const aId = assistantBySession.get(env.sessionId);
  if (aId) useChatStore.getState().setExplanation(aId, env.explanation);
}

/** Défait l'abonnement aux événements du chat. */
function stopChatStream(): void {
  unsubscribe?.();
  unsubscribe = null;
  subscribedTo = null;
}

/**
 * S'abonne aux événements du chat, une fois pour la vie de l'app : un composant démonté ne
 * l'emporte pas. Idempotent ; se réabonne si l'objet `chat` change. Rend le désabonnement.
 */
export function ensureChatStream(chat: FusionChatApi): () => void {
  if (subscribedTo !== chat) {
    stopChatStream();
    const offs = [
      chat.onChunk(onChunk),
      chat.onContext(onContext),
      chat.onToolCall(onToolCall),
      chat.onExplanation?.(onExplanation),
    ];
    subscribedTo = chat;
    unsubscribe = () => {
      for (const off of offs) off?.();
    };
  }
  return stopChatStream;
}

/** Lie une session à sa bulle, avant l'appel qui lance le tour. */
export function bindSession(sessionId: string, assistantId: string): void {
  assistantBySession.set(sessionId, assistantId);
}

/** La bulle n'attend plus rien de cette session : tour arrêté, effacé, refusé ou d'un projet quitté. */
export function abandonSession(sessionId: string): void {
  assistantBySession.delete(sessionId);
}
