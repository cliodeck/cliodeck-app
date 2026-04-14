import React, { useEffect, useRef, memo } from 'react';
import { MessageBubble } from './MessageBubble';
import { UnifiedMessage } from './types';
import './MessageList.css';

interface MessageListProps<M extends UnifiedMessage> {
  messages: M[];
  /** If set, a virtual streaming assistant bubble is appended at the end. */
  streamingContent?: string;
  /** True when a generation is running and no partial content has arrived yet. */
  showTypingIndicator?: boolean;
  renderExtras?: (message: M) => React.ReactNode;
}

function MessageListInner<M extends UnifiedMessage>({
  messages,
  streamingContent,
  showTypingIndicator,
  renderExtras,
}: MessageListProps<M>): React.ReactElement {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent, showTypingIndicator]);

  return (
    <div className="message-list" role="log" aria-live="polite" aria-label="Chat messages">
      {messages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          extras={renderExtras ? renderExtras(message) : undefined}
        />
      ))}

      {streamingContent && (
        <MessageBubble
          message={{
            id: 'streaming',
            role: 'assistant',
            content: streamingContent,
            timestamp: new Date(),
          }}
          isStreaming
        />
      )}

      {showTypingIndicator && (
        <div className="typing-indicator">
          <div className="typing-dot"></div>
          <div className="typing-dot"></div>
          <div className="typing-dot"></div>
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>
  );
}

export const MessageList = memo(MessageListInner) as typeof MessageListInner;
