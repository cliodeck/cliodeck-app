import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { marked } from 'marked';
import { UnifiedMessage } from './types';
import { sanitizeChat } from '../../utils/sanitize';
import { highlightEntitiesInHtml } from '../../utils/ner-highlight';
import './MessageBubble.css';

interface MessageBubbleProps {
  message: UnifiedMessage;
  isStreaming?: boolean;
  extras?: React.ReactNode;
  /** Enable NER entity highlighting in assistant messages. */
  enableNER?: boolean;
}

export const MessageBubble: React.FC<MessageBubbleProps> = React.memo(
  ({ message, isStreaming = false, extras, enableNER = false }) => {
    const { t } = useTranslation('common');
    const isUser = message.role === 'user';
    const isSystem = message.role === 'system';

    const htmlContent = useMemo(() => {
      if (isUser) return null;
      try {
        const raw = marked.parse(message.content, { breaks: true, gfm: true });
        let html = sanitizeChat(raw as string);
        if (enableNER && !message.pending) {
          html = highlightEntitiesInHtml(html);
        }
        return html;
      } catch (error) {
        console.error('Markdown parsing error:', error);
        return sanitizeChat(message.content);
      }
    }, [message.content, isUser, enableNER, message.pending]);

    const formatTime = (date: Date): string =>
      new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(date);

    const pending = message.pending && !message.content;

    return (
      <div className={`message-bubble ${isUser ? 'user' : isSystem ? 'system' : 'assistant'}`}>
        <div className="message-header">
          <span className="message-avatar">{isUser ? '👤' : isSystem ? 'ℹ️' : '🤖'}</span>
          <span className="message-role">
            {isUser ? t('chat.you') : isSystem ? t('chat.system', 'Système') : t('chat.assistant')}
          </span>
          {message.timestamp && (
            <span className="message-time">{formatTime(message.timestamp)}</span>
          )}
          {(isStreaming || message.pending) && <span className="streaming-indicator">●</span>}
          {message.badge && <span className="message-mode-badge">{message.badge}</span>}
        </div>

        <div className="message-content">
          {isUser || isSystem ? (
            <p>{message.content}</p>
          ) : (
            <div
              className="message-markdown"
              dangerouslySetInnerHTML={{ __html: htmlContent || message.content || (pending ? '…' : '') }}
            />
          )}
        </div>

        {extras}
      </div>
    );
  }
);
