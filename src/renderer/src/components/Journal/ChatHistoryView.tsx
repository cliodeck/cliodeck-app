import React from 'react';
import { useTranslation } from 'react-i18next';
import { ChatMessage } from '../../stores/journalStore';

interface Props {
  messages: ChatMessage[];
}

export const ChatHistoryView: React.FC<Props> = ({ messages }) => {
  const { t } = useTranslation('common');

  const formatDateTime = (timestamp: Date) => {
    const date = timestamp.toLocaleDateString(undefined, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
    const time = timestamp.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit'
    });
    return `${date} ${time}`;
  };

  return (
    <div className="chat-history-view">
      <h3>{t('journal.chatHistory')}</h3>

      {messages.length === 0 ? (
        <div className="empty-state">
          <p>{t('chat.emptyState.message')}</p>
        </div>
      ) : (
        <div className="chat-messages">
          {messages.map((msg) => (
            <div key={msg.id} className={`chat-message ${msg.role}`}>
              <div className="message-header">
                <span className="message-role">
                  {msg.role === 'user' ? t('chat.you') : t('chat.assistant')}
                </span>
                <span className="message-time">
                  {formatDateTime(msg.timestamp)}
                </span>
              </div>
              <div className="message-content">{msg.content}</div>
              {msg.sources && msg.sources.length > 0 && (
                <div className="message-sources">
                  <strong>{t('chat.sources')}:</strong>
                  <ul>
                    {msg.sources.map((source: any, idx: number) => (
                      <li key={idx}>
                        {source.documentTitle || 'Document'} ({t('chat.page')} {source.pageNumber}, {t('chat.similarity')}: {source.similarity.toFixed(2)})
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
