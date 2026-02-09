import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { useChatStore } from '../../stores/chatStore';
import { useBibliographyStore } from '../../stores/bibliographyStore';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { RAGSettingsPanel } from './RAGSettingsPanel';
import { ModeSelector } from './ModeSelector';
import { HelperTooltip } from '../Methodology/HelperTooltip';
import './ChatInterface.css';
import { logger } from '../../utils/logger';

export const ChatInterface: React.FC = () => {
  const { t } = useTranslation('common');
  const { messages, isProcessing, sendMessage, cancelGeneration, clearChat } = useChatStore();
  const { indexedFilePaths, refreshIndexedPDFs } = useBibliographyStore();
  const [inputValue, setInputValue] = useState('');
  const [ragStatus, setRagStatus] = useState<{ message: string; isError: boolean } | null>(null);

  const indexedCount = indexedFilePaths.size;

  // Refresh indexed PDFs when component mounts and when project changes
  useEffect(() => {
    refreshIndexedPDFs();
  }, [refreshIndexedPDFs]);

  // Listen for RAG status updates
  useEffect(() => {
    const handleStatus = (_event: unknown, data: { stage: string; message: string }) => {
      setRagStatus({
        message: data.message,
        isError: data.stage === 'error',
      });
    };

    // @ts-expect-error - electron IPC
    window.electron?.ipcRenderer?.on('chat:status', handleStatus);

    return () => {
      // @ts-expect-error - electron IPC
      window.electron?.ipcRenderer?.removeListener('chat:status', handleStatus);
    };
  }, []);

  // Clear status when processing ends (with delay for errors)
  useEffect(() => {
    if (!isProcessing && ragStatus) {
      // Keep error messages visible longer
      const delay = ragStatus.isError ? 5000 : 0;
      const timer = setTimeout(() => setRagStatus(null), delay);
      return () => clearTimeout(timer);
    }
  }, [isProcessing, ragStatus]);

  const handleSend = async () => {
    logger.component('ChatInterface', 'handleSend called', { inputValue, isProcessing });
    if (!inputValue.trim() || isProcessing) {
      logger.component('ChatInterface', 'Send blocked - empty input or processing');
      return;
    }

    const query = inputValue.trim();
    setInputValue('');

    try {
      logger.component('ChatInterface', 'Calling sendMessage', { query });
      await sendMessage(query);
    } catch (error) {
      logger.error('ChatInterface', error);
    }
  };

  const handleCancel = () => {
    logger.component('ChatInterface', 'handleCancel called');
    cancelGeneration();
  };

  const handleClear = () => {
    logger.component('ChatInterface', 'handleClear called');
    if (window.confirm(t('chat.clearConfirm'))) {
      clearChat();
    }
  };

  const handleLearnMore = () => {
    window.dispatchEvent(new CustomEvent('show-methodology-modal', { detail: { feature: 'chat' } }));
  };

  return (
    <div className="chat-interface">
      {/* Header */}
      <div className="chat-header">
        <div className="chat-title">
          <h3>{t('chat.aiAssistant')}</h3>
          <HelperTooltip
            content={t('chat.helpText')}
            onLearnMore={handleLearnMore}
          />
        </div>
        <ModeSelector />
        <button
          className="toolbar-btn"
          onClick={handleClear}
          title={t('chat.clearHistory')}
          disabled={messages.length === 0}
        >
          <Trash2 size={20} strokeWidth={1} />
        </button>
      </div>

      {/* Messages */}
      <div className="chat-messages">
        {messages.length === 0 ? (
          <div className="chat-empty">
            {indexedCount > 0 ? (
              <>
                <h4>{t('chat.readyState.title')}</h4>
                <p>
                  {t('chat.readyState.message', { count: indexedCount })}
                </p>
              </>
            ) : (
              <>
                <h4>{t('chat.emptyState.title')}</h4>
                <p>
                  {t('chat.emptyState.message')}
                </p>
              </>
            )}
          </div>
        ) : (
          <MessageList messages={messages} />
        )}
        {/* RAG Status indicator */}
        {ragStatus && (isProcessing || ragStatus.isError) && (
          <div className={`rag-status-indicator ${ragStatus.isError ? 'rag-status-error' : ''}`}>
            {ragStatus.message}
          </div>
        )}
      </div>

      {/* Input */}
      <MessageInput
        value={inputValue}
        onChange={setInputValue}
        onSend={handleSend}
        onCancel={handleCancel}
        isProcessing={isProcessing}
      />

      {/* RAG Settings Panel */}
      <RAGSettingsPanel />
    </div>
  );
};
