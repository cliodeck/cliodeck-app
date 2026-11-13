/**
 * useBrainstormChat (fusion phase 3.2).
 *
 * Glue hook: exposes a `send(content)` / `cancel()` / `reset()` triple for
 * the UI. The `fusion:chat:*` stream itself lives in `chatStream.ts`, outside
 * any component (L09-6): a turn belongs to its session from start to end,
 * whether or not the chat tab is mounted.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../../stores/chatStore';
import {
  useMcpToolsStore,
  selectEnabledToolNames,
} from '../../stores/mcpToolsStore';
import { useMcpToolsList } from './useMcpToolsList';
import { toProviderHistory } from './provider-history';
import { useRAGQueryStore } from '../../stores/ragQueryStore';
import { useNotificationStore } from '../../stores/notificationStore';
import { projectLifecycle } from '../../lifecycle/projectLifecycle';
import { unwrapIpc } from '../../utils/ipc-outcome';
import { translateMessage } from '../../utils/translate-message';
import {
  abandonSession,
  bindSession,
  ensureChatStream,
  type FusionChatApi,
} from './chatStream';

function api(): FusionChatApi | null {
  return (window.electron?.fusion?.chat as FusionChatApi | undefined) ?? null;
}

export interface UseBrainstormChat {
  send: (content: string) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
  isStreaming: boolean;
  error: string | null;
}

export function useBrainstormChat(): UseBrainstormChat {
  const store = useChatStore();
  const { t } = useTranslation('common');
  // Track the current MCP tools list in a ref so the `send` callback
  // doesn't get recreated every time the catalogue changes (fusion 2.5).
  const mcpTools = useMcpToolsList();
  const mcpToolsRef = useRef(mcpTools);
  useEffect(() => {
    mcpToolsRef.current = mcpTools;
  }, [mcpTools]);

  const send = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      // Des cases cochées dont aucune ne sera consultée (texte de l'auteur
      // seul, écarté pour ce tour) : le tour ne part pas, et l'utilisateur
      // sait pourquoi. Ni élargissement silencieux, ni réponse sans contexte.
      const blocked = useChatStore.getState().chatSettings.sendBlockedReasons;
      if (blocked) {
        const reasons = blocked.map((key) => t(key)).join(', ') || t('chat.scope.reason.toggle');
        useNotificationStore.getState().notify({
          level: 'warning',
          title: t('chat.scope.nothingConsultedTitle'),
          message: t('chat.scope.nothingConsulted', { reasons }),
          details: reasons,
        });
        return;
      }
      const chat = api();
      // Le projet où la question est posée : sa réponse n'a rien à faire dans un autre (Q11).
      const handle = projectLifecycle.capture();
      const priorMessages = useChatStore.getState().messages;
      store.appendUser(trimmed);
      if (!chat) {
        // eslint-disable-next-line no-console
        console.warn('[brainstorm] fusion API not exposed');
        const aId = store.beginAssistant('local-error');
        store.finishAssistant(aId, 'error', t('chat.notConfigured'));
        return;
      }

      // Sans les tours restés sans réponse : leur bulle vide valait un HTTP 400 à chaque question
      // suivante chez Claude et Gemini (S06-1-1). Elle reste affichée.
      const payload = [
        ...toProviderHistory(priorMessages),
        { role: 'user' as const, content: trimmed },
      ];
      // Pull the persisted chat settings off the store and forward them
      // every turn. Undefined fields are fine — the main-side handler
      // treats the whole bag as optional.
      const settings = useChatStore.getState().chatSettings;
      const ragParams = useRAGQueryStore.getState().params;
      const startOpts: Parameters<typeof chat.start>[1] = {};
      if (settings.retrieval) startOpts.retrievalOptions = settings.retrieval;
      // La langue part toujours : elle décide aussi de celle du bloc de
      // contexte de la recherche, injecté même sans mode ni prompt.
      if (settings.modeId || settings.customSystemPrompt || settings.promptLanguage) {
        startOpts.systemPrompt = {
          modeId: settings.modeId,
          customText: settings.customSystemPrompt,
          language: settings.promptLanguage,
        };
      }
      // Forward the user-chosen context window. 0 means "use Ollama's
      // default" — same convention as ragQueryStore — so we skip the
      // field entirely in that case rather than sending 0.
      if (typeof ragParams.numCtx === 'number' && ragParams.numCtx > 0) {
        startOpts.numCtx = ragParams.numCtx;
      }
      // Le modèle et l'échantillonnage choisis dans le panneau du chat.
      // Jusqu'ici seul `numCtx` partait : le modèle, la température, top-p
      // et top-k restaient dans le store du renderer, et les réglages de
      // l'application décidaient seuls. Le main n'applique le modèle qu'à
      // la génération Ollama locale (sa liste vient d'Ollama) et top-p /
      // top-k qu'à Ollama aussi ; la température vaut pour tous.
      const model = ragParams.model?.trim();
      if (model && ragParams.provider !== 'embedded') {
        startOpts.model = model;
      }
      if (Number.isFinite(ragParams.temperature)) {
        startOpts.temperature = ragParams.temperature;
      }
      if (Number.isFinite(ragParams.top_p)) {
        startOpts.topP = ragParams.top_p;
      }
      if (Number.isInteger(ragParams.top_k) && ragParams.top_k > 0) {
        startOpts.topK = ragParams.top_k;
      }
      if (Number.isFinite(ragParams.repeat_penalty) && ragParams.repeat_penalty > 0) {
        startOpts.repeatPenalty = ragParams.repeat_penalty;
      }
      if (typeof ragParams.think === 'boolean' && ragParams.provider !== 'embedded') {
        startOpts.think = ragParams.think;
      }
      // Délai d'inactivité : le main interrompt le tour après ce délai
      // sans rien recevoir du modèle. Le curseur existait sans consommateur.
      if (Number.isFinite(ragParams.timeout) && ragParams.timeout > 0) {
        startOpts.timeoutMs = Math.round(ragParams.timeout);
      }
      // Fusion 2.5 — pass the user-validated MCP tool subset. When no
      // MCP server is registered the list is empty and we send no
      // `enabledTools` field at all (the backend then falls back to
      // legacy "every ready tool" behaviour, which is itself a no-op
      // when capabilities.tools=false).
      const tools = mcpToolsRef.current;
      if (tools.length > 0) {
        startOpts.enabledTools = selectEnabledToolNames(
          tools,
          useMcpToolsStore.getState().overrides
        );
      }
      // La bulle et son lien avant l'appel, sous un identifiant tiré ici : le main peut émettre
      // avant de répondre — une clé d'API absente finit le tour pendant `start` (S16-1-20).
      const sessionId = crypto.randomUUID();
      startOpts.sessionId = sessionId;
      ensureChatStream(chat);
      const aId = store.beginAssistant(sessionId);
      bindSession(sessionId, aId);
      let failure: string | null = null;
      try {
        unwrapIpc(await chat.start(payload, startOpts));
      } catch (e) {
        failure = translateMessage(t, e instanceof Error ? e : { message: String(e) });
      }
      // Un autre projet à l'écran depuis : sa conversation a été vidée, et ce tour n'y apparaît pas,
      // ni réponse, ni attente, ni échec. Le main l'annule à la bascule ; s'il est parti après, on
      // l'arrête ici. Sans projet au départ, l'ouverture d'un projet compte aussi.
      const switched = handle ? !handle.isCurrent() : projectLifecycle.capture() !== null;
      if (switched) {
        abandonSession(sessionId);
        if (failure === null) void chat.cancel(sessionId);
        return;
      }
      if (failure !== null) {
        // eslint-disable-next-line no-console
        console.error('[brainstorm] start failed', failure);
        abandonSession(sessionId);
        store.finishAssistant(aId, 'error', t('chat.startFailed', { error: failure }));
      }
    },
    [store, t]
  );

  // La bulle est arrêtée tout de suite, avant la réponse du main : Effacer enchaîne sur la remise
  // à zéro, et un tour envoyé aussitôt après ne doit pas être pris pour celui-ci.
  const cancel = useCallback(async () => {
    const sid = useChatStore.getState().sessionId;
    if (!sid) return;
    abandonSession(sid);
    store.cancel();
    await api()?.cancel(sid);
  }, [store]);

  // Effacer pendant une génération l'arrête : sans quoi le tour effacé continuait côté main, et
  // sa fin clôturait le tour suivant (S16-1-3).
  const reset = useCallback(() => {
    if (useChatStore.getState().sessionId) void cancel();
    store.reset();
  }, [cancel, store]);

  const isStreaming = store.pendingAssistantId !== null;
  const lastError =
    store.messages.slice(-1)[0]?.error ?? null;

  return {
    send,
    cancel,
    reset,
    isStreaming,
    error: lastError,
  };
}
