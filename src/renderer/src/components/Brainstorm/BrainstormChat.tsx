/**
 * BrainstormChat (fusion phase 3.2, unified UI pass).
 *
 * Thin adapter over the shared ChatSurface: maps BrainstormMessage into
 * UnifiedMessage and provides the "send to write" action as message extras.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { useBrainstormChatStore, type BrainstormMessage } from '../../stores/brainstormChatStore';
import { useBrainstormChat } from './useBrainstormChat';
import { useEditorStore } from '../../stores/editorStore';
import { useWorkspaceModeStore } from '../../stores/workspaceModeStore';
import { appendDraftToContent, messageToDraft } from './messageToDraft';
import { ChatSurface } from '../Chat/ChatSurface';
import { UnifiedMessage } from '../Chat/types';

interface BrainstormUnifiedMessage extends UnifiedMessage {
  original: BrainstormMessage;
}

export const BrainstormChat: React.FC = () => {
  const messages = useBrainstormChatStore((s) => s.messages);
  const { send, cancel, reset, isStreaming, error } = useBrainstormChat();
  const setWorkspaceMode = useWorkspaceModeStore((s) => s.setActive);
  const [sentToWriteId, setSentToWriteId] = useState<string | null>(null);

  const sendToWrite = useCallback(
    (m: BrainstormMessage): void => {
      const editor = useEditorStore.getState();
      const block = messageToDraft(m);
      editor.setContent(appendDraftToContent(editor.content, block));
      setSentToWriteId(m.id);
      setWorkspaceMode('write');
    },
    [setWorkspaceMode]
  );

  const unifiedMessages = useMemo<BrainstormUnifiedMessage[]>(
    () =>
      messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        pending: m.pending,
        isError: !!m.error,
        badge: m.ragCitation ? 'citation' : undefined,
        original: m,
      })),
    [messages]
  );

  const handleSend = useCallback(
    async (text: string) => {
      await send(text);
    },
    [send]
  );

  const emptyState = (
    <p style={{ maxWidth: 420 }}>
      Commencez une exploration libre. Les <code>.cliohints</code> et les sources indexées
      seront injectés automatiquement.
    </p>
  );

  const renderExtras = (m: BrainstormUnifiedMessage): React.ReactNode => {
    const orig = m.original;
    return (
      <>
        {orig.error && <div className="brainstorm-chat__error">{orig.error}</div>}
        {m.role === 'assistant' && !orig.pending && !orig.error && orig.content && (
          <div className="brainstorm-chat__msg-actions">
            <button
              type="button"
              className="chat-surface__inline-btn"
              onClick={() => sendToWrite(orig)}
              title="Insère ce tour comme brouillon dans Write"
            >
              <ArrowRight size={12} />{' '}
              {sentToWriteId === orig.id ? 'Envoyé' : 'Envoyer vers Write'}
            </button>
          </div>
        )}
      </>
    );
  };

  return (
    <ChatSurface
      messages={unifiedMessages}
      isProcessing={isStreaming}
      onSend={handleSend}
      onCancel={() => void cancel()}
      onClear={messages.length > 0 ? reset : undefined}
      emptyState={emptyState}
      banner={error && !isStreaming ? error : undefined}
      placeholder="Question, hypothèse, piste à explorer… (Cmd/Ctrl + Enter pour envoyer)"
      renderMessageExtras={renderExtras}
    />
  );
};
