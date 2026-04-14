import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ChatMessage, useChatStore } from '../../stores/chatStore';
import { useBibliographyStore } from '../../stores/bibliographyStore';
import { useDialogStore } from '../../stores/dialogStore';
import { useModeStore } from '../../stores/modeStore';
import { ChatSurface } from './ChatSurface';
import { RAGMessageExtras } from './RAGMessageExtras';
import { ModeSelector } from './ModeSelector';
import { RAGSettingsPanel } from './RAGSettingsPanel';
import { HelperTooltip } from '../Methodology/HelperTooltip';
import { UnifiedMessage } from './types';
import { logger } from '../../utils/logger';
import './ChatInterface.css';

interface ChatUnifiedMessage extends UnifiedMessage {
  original: ChatMessage;
}

export const ChatInterface: React.FC = () => {
  const { t, i18n } = useTranslation('common');
  const lang = (i18n.language?.substring(0, 2) as 'fr' | 'en') || 'fr';
  const { messages, isProcessing, currentStreamingMessage, sendMessage, cancelGeneration, clearChat } =
    useChatStore();
  const { indexedFilePaths, refreshIndexedPDFs } = useBibliographyStore();
  const { modes } = useModeStore();
  const [ragStatus, setRagStatus] = useState<{ message: string; isError: boolean } | null>(null);

  const indexedCount = indexedFilePaths.size;

  useEffect(() => {
    refreshIndexedPDFs();
  }, [refreshIndexedPDFs]);

  useEffect(() => {
    const handleStatus = (_event: unknown, data: { stage: string; message: string }): void => {
      setRagStatus({ message: data.message, isError: data.stage === 'error' });
    };
    // @ts-expect-error - electron IPC
    window.electron?.ipcRenderer?.on('chat:status', handleStatus);
    return () => {
      // @ts-expect-error - electron IPC
      window.electron?.ipcRenderer?.removeListener('chat:status', handleStatus);
    };
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
          isError: m.isError,
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
        await sendMessage(text);
      } catch (error) {
        logger.error('ChatInterface', error);
      }
    },
    [sendMessage]
  );

  const handleClear = useCallback(async () => {
    if (await useDialogStore.getState().showConfirm(t('chat.clearConfirm'))) {
      clearChat();
    }
  }, [clearChat, t]);

  const handleLearnMore = useCallback(() => {
    window.dispatchEvent(new CustomEvent('show-methodology-modal', { detail: { feature: 'chat' } }));
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
        streamingContent={currentStreamingMessage || undefined}
        onSend={handleSend}
        onCancel={cancelGeneration}
        onClear={handleClear}
        emptyState={emptyState}
        banner={banner}
        renderMessageExtras={(m) => <RAGMessageExtras message={m.original} />}
      />
      <RAGSettingsPanel />
    </>
  );
};
