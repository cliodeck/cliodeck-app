import React, { useMemo } from 'react';
import { AlertTriangle, Bot, Circle, Info, User } from 'lucide-react';
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
    // A reply made only of forbidden tags sanitizes to '': show it as escaped
    // text, never as raw HTML (a lone <style> would restyle the whole app).
    const filtered = !pending && !htmlContent && message.content.trim() !== '';
    // Réponse arrêtée par la limite de longueur du modèle : elle ne se présente pas comme
    // complète (S05-1-7).
    const truncated = !isUser && !message.pending && message.finishReason === 'length';

    return (
      <div className={`message-bubble ${isUser ? 'user' : isSystem ? 'system' : 'assistant'}`}>
        <div className="message-header">
          <span className="message-avatar">
            {isUser ? <User size={16} /> : isSystem ? <Info size={16} /> : <Bot size={16} />}
          </span>
          <span className="message-role">
            {isUser ? t('chat.you') : isSystem ? t('chat.system', 'Système') : t('chat.assistant')}
          </span>
          {message.timestamp && (
            <span className="message-time">{formatTime(message.timestamp)}</span>
          )}
          {(isStreaming || message.pending) && (
            <span className="streaming-indicator"><Circle size={10} fill="currentColor" /></span>
          )}
          {message.badge && <span className="message-mode-badge">{message.badge}</span>}
        </div>

        <div className="message-content">
          {isUser || isSystem ? (
            <p>{message.content}</p>
          ) : filtered ? (
            <p className="message-markdown">{message.content}</p>
          ) : (
            <div
              className="message-markdown"
              dangerouslySetInnerHTML={{ __html: htmlContent || (pending ? '…' : '') }}
            />
          )}
        </div>

        {truncated && (
          <div className="message-truncated">
            <AlertTriangle size={12} /> {t('chat.truncated')}
          </div>
        )}

        {extras}
      </div>
    );
  }
);
