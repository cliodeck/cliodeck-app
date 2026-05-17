import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage } from '../../stores/chatStore';
import { SourceCard } from './SourceCard';
import { ExplanationPanel } from './ExplanationPanel';

/**
 * Extras rendered below a RAG assistant bubble: "no context" warning,
 * sources list, and the Explainable-AI panel. Extracted from the legacy
 * MessageBubble so the bubble itself can stay generic.
 */
export const RAGMessageExtras: React.FC<{ message: ChatMessage }> = ({ message }) => {
  const { t } = useTranslation('common');

  if (message.role === 'user') return null;

  return (
    <>
      {message.ragUsed === false && !message.isError && (
        <div className="message-no-context-warning">
          <span className="warning-icon">⚠️</span>
          <span className="warning-text">{t('chat.noContextWarning')}</span>
        </div>
      )}

      {message.sources && message.sources.length > 0 && (
        <div className="message-sources">
          <div className="sources-header">
            <span className="sources-icon">📚</span>
            <span className="sources-title">
              {t('chat.sources')} ({message.sources.length})
            </span>
          </div>
          <div className="sources-list">
            {message.sources.map((source, index) => (
              <SourceCard key={index} source={source} index={index + 1} />
            ))}
          </div>
        </div>
      )}

      {message.explanation && <ExplanationPanel explanation={message.explanation} />}
    </>
  );
};
