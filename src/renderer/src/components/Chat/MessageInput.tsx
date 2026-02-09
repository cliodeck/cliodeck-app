import React, { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './MessageInput.css';

interface MessageInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onCancel: () => void;
  isProcessing: boolean;
}

export const MessageInput: React.FC<MessageInputProps> = ({
  value,
  onChange,
  onSend,
  onCancel,
  isProcessing,
}) => {
  const { t } = useTranslation('common');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isProcessing && value.trim()) {
        onSend();
      }
    }
  };

  return (
    <div className="message-input">
      <div className="input-container">
        <textarea
          ref={textareaRef}
          className="input-textarea"
          placeholder={t('chat.placeholder')}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isProcessing}
          rows={1}
        />
        <div className="input-actions">
          {isProcessing ? (
            <button className="input-btn cancel-btn" onClick={onCancel} title={t('chat.cancel')}>
              ⏹️
            </button>
          ) : (
            <button
              className="input-btn send-btn"
              onClick={onSend}
              disabled={!value.trim()}
              title={t('chat.send')}
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
