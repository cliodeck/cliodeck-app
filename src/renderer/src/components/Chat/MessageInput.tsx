import React, { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './MessageInput.css';

interface MessageInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onCancel: () => void;
  isProcessing: boolean;
  placeholder?: string;
}

export const MessageInput: React.FC<MessageInputProps> = ({
  value,
  onChange,
  onSend,
  onCancel,
  isProcessing,
  placeholder,
}) => {
  const { t } = useTranslation('common');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl + Enter sends; bare Enter inserts a newline.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!isProcessing && value.trim()) {
        onSend();
      }
    }
  };

  const resolvedPlaceholder = placeholder ?? t('chat.placeholder');

  return (
    <div className="message-input">
      <div className="input-container">
        <textarea
          ref={textareaRef}
          className="input-textarea"
          placeholder={resolvedPlaceholder}
          aria-label={resolvedPlaceholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isProcessing}
          rows={1}
        />
        <div className="input-actions">
          {isProcessing ? (
            <button className="input-btn cancel-btn" onClick={onCancel} title={t('chat.cancel')} aria-label={t('chat.cancel')}>
              ⏹️
            </button>
          ) : (
            <button
              className="input-btn send-btn"
              onClick={onSend}
              disabled={!value.trim()}
              title={t('chat.send')}
              aria-label={t('chat.send')}
            >
              ➤
            </button>
          )}
        </div>
      </div>
      <div className="input-hint">
        {isProcessing ? t('chat.generating') : t('chat.newLineHint')}
      </div>
    </div>
  );
};
