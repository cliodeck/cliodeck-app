import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { UnifiedMessage } from './types';
import './ChatSurface.css';

interface ChatSurfaceProps<M extends UnifiedMessage> {
  title?: string;
  headerExtras?: React.ReactNode;
  messages: M[];
  isProcessing: boolean;
  streamingContent?: string;
  onSend: (text: string) => void | Promise<void>;
  onCancel?: () => void;
  onClear?: () => void;
  emptyState?: React.ReactNode;
  banner?: React.ReactNode;
  placeholder?: string;
  renderMessageExtras?: (message: M) => React.ReactNode;
  footer?: React.ReactNode;
}

export function ChatSurface<M extends UnifiedMessage>({
  title,
  headerExtras,
  messages,
  isProcessing,
  streamingContent,
  onSend,
  onCancel,
  onClear,
  emptyState,
  banner,
  placeholder,
  renderMessageExtras,
  footer,
}: ChatSurfaceProps<M>): React.ReactElement {
  const { t } = useTranslation('common');
  const [inputValue, setInputValue] = useState('');

  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || isProcessing) return;
    setInputValue('');
    await onSend(text);
  }, [inputValue, isProcessing, onSend]);

  const handleCancel = useCallback(() => {
    onCancel?.();
  }, [onCancel]);

  const showTypingIndicator = isProcessing && !streamingContent;

  return (
    <div className="chat-surface">
      {(title || headerExtras || onClear) && (
        <div className="chat-surface__header">
          {title && <h3 className="chat-surface__title">{title}</h3>}
          <div className="chat-surface__header-extras">{headerExtras}</div>
          {onClear && (
            <button
              type="button"
              className="chat-surface__header-btn"
              onClick={onClear}
              title={t('chat.clearHistory')}
              disabled={messages.length === 0}
            >
              <Trash2 size={20} strokeWidth={1} />
            </button>
          )}
        </div>
      )}

      <div className="chat-surface__messages">
        {messages.length === 0 && !streamingContent && !isProcessing ? (
          <div className="chat-surface__empty">{emptyState}</div>
        ) : (
          <MessageList
            messages={messages}
            streamingContent={streamingContent}
            showTypingIndicator={showTypingIndicator}
            renderExtras={renderMessageExtras}
          />
        )}
      </div>

      {banner && <div className="chat-surface__banner">{banner}</div>}

      <MessageInput
        value={inputValue}
        onChange={setInputValue}
        onSend={handleSend}
        onCancel={handleCancel}
        isProcessing={isProcessing}
        placeholder={placeholder}
      />

      {footer}
    </div>
  );
}
