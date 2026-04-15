import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type ChatMessage,
  useChatStore,
} from '../../stores/chatStore';
import { useBibliographyStore } from '../../stores/bibliographyStore';
import { useDialogStore } from '../../stores/dialogStore';
import { useModeStore } from '../../stores/modeStore';
import { useBrainstormChat } from '../Brainstorm/useBrainstormChat';
import { ChatSurface } from './ChatSurface';
import { RAGMessageExtras } from './RAGMessageExtras';
import { ModeSelector } from './ModeSelector';
import { RAGSettingsPanel } from './RAGSettingsPanel';
import { useChatSettingsProjection } from './useChatSettingsProjection';
import { HelperTooltip } from '../Methodology/HelperTooltip';
import { UnifiedMessage } from './types';
import { logger } from '../../utils/logger';
import './ChatInterface.css';

interface ChatUnifiedMessage extends UnifiedMessage {
  original: ChatMessage;
}

/**
 * ChatInterface (Write mode).
 *
 * Post-fusion (step 4b): runs on the unified `fusion:chat:*` pipeline via
 * `useBrainstormChat`. The legacy `chat:send` / `chat:onStream` handlers
 * are left in place (deprecated) until step 5 of the fusion plan.
 */
export const ChatInterface: React.FC = () => {
  const { t, i18n } = useTranslation('common');
  const lang = (i18n.language?.substring(0, 2) as 'fr' | 'en') || 'fr';
  const messages = useChatStore((s) => s.messages);
  const pendingAssistantId = useChatStore((s) => s.pendingAssistantId);
  const resetChat = useChatStore((s) => s.reset);
  const { send, cancel } = useBrainstormChat();
  const { indexedFilePaths, refreshIndexedPDFs } = useBibliographyStore();
  const { modes } = useModeStore();
  const [ragStatus, setRagStatus] = useState<{ message: string; isError: boolean } | null>(
    null
  );

  // Project RAG params + active mode onto chatStore.chatSettings so every
  // `fusion.chat.start` picks up current filters.
  useChatSettingsProjection();

  const indexedCount = indexedFilePaths.size;
  const isProcessing = pendingAssistantId !== null;

  useEffect(() => {
    refreshIndexedPDFs();
  }, [refreshIndexedPDFs]);

  // Status banner: subscribe to the fusion status stream.
  useEffect(() => {
    const w = window as unknown as {
      electron?: {
        fusion?: {
          chat?: {
            onStatus?: (
              cb: (env: {
                sessionId: string;
                status: { phase: string; label?: string };
              }) => void
            ) => () => void;
          };
        };
      };
    };
    const onStatus = w.electron?.fusion?.chat?.onStatus;
    if (!onStatus) return;
    const unsub = onStatus((env) => {
      const phase = env.status.phase;
      const label = env.status.label ?? phase;
      setRagStatus({ message: label, isError: phase === 'error' });
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!isProcessing && ragStatus) {
      const delay = ragStatus.isError ? 5000 : 0;
      const timer = setTimeout(() => setRagStatus(null), delay);
      return () => clearTimeout(timer);
    }
  }, [isProcessing, ragStatus]);

  const unifiedMessages = useMemo<ChatUnifiedMessage[]>(
    () =>
      messages.map((m) => {
        const mode =
          m.modeId && m.modeId !== 'default-assistant'
            ? modes.find((x) => x.metadata.id === m.modeId)
            : undefined;
        const badge = mode ? mode.metadata.name[lang] || m.modeId : undefined;
        return {
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          pending: m.pending,
          isError: !!m.error || !!m.isError,
          badge,
          original: m,
        };
      }),
    [messages, modes, lang]
  );

  const handleSend = useCallback(
    async (text: string) => {
      try {
        logger.component('ChatInterface', 'sendMessage', { query: text });
        await send(text);
      } catch (error) {
        logger.error('ChatInterface', error);
      }
    },
    [send]
  );

  const handleCancel = useCallback(async () => {
    await cancel();
  }, [cancel]);

  const handleClear = useCallback(async () => {
    if (await useDialogStore.getState().showConfirm(t('chat.clearConfirm'))) {
      resetChat();
    }
  }, [resetChat, t]);

  const handleLearnMore = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('show-methodology-modal', { detail: { feature: 'chat' } })
    );
  }, []);

  const emptyState = (
    <>
      {indexedCount > 0 ? (
        <>
          <h4>{t('chat.readyState.title')}</h4>
          <p>{t('chat.readyState.message', { count: indexedCount })}</p>
        </>
      ) : (
        <>
          <h4>{t('chat.emptyState.title')}</h4>
          <p>{t('chat.emptyState.message')}</p>
        </>
      )}
    </>
  );

  const banner =
    ragStatus && (isProcessing || ragStatus.isError) ? (
      <div
        className={`rag-status-indicator ${ragStatus.isError ? 'rag-status-error' : ''}`}
        role="status"
        aria-live="polite"
      >
        {ragStatus.message}
      </div>
    ) : undefined;

  const renderRAGExtras = useCallback(
    (m: ChatUnifiedMessage) => <RAGMessageExtras message={m.original} />,
    []
  );

  // Streaming content: the pending assistant message already carries the
  // running content; ChatSurface renders it in-place, so no separate
  // streamingContent prop is needed now that messages carry `pending`.

  const headerExtras = (
    <>
      <HelperTooltip content={t('chat.helpText')} onLearnMore={handleLearnMore} />
      <ModeSelector />
    </>
  );

  return (
    <>
      <ChatSurface
        title={t('chat.aiAssistant')}
        headerExtras={headerExtras}
        messages={unifiedMessages}
        isProcessing={isProcessing}
        onSend={handleSend}
        onCancel={handleCancel}
        onClear={messages.length > 0 ? handleClear : undefined}
        emptyState={emptyState}
        banner={banner}
        renderMessageExtras={renderRAGExtras}
      />
      <RAGSettingsPanel />
    </>
  );
};
