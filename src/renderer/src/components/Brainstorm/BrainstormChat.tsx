/**
 * BrainstormChat (fusion phase 3.2).
 *
 * Streamed chat surface for the Brainstorm mode. Minimal by design:
 * vertical message list + composer with send/cancel. No sidebar, no
 * conversation history persistence yet — that belongs to a storage pass
 * after 3.3 (bridge to Write) has shaped the final message envelope.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Send, X, Trash2, ArrowRight } from 'lucide-react';
import { useBrainstormChatStore, type BrainstormMessage } from '../../stores/brainstormChatStore';
import { useBrainstormChat } from './useBrainstormChat';
import { useEditorStore } from '../../stores/editorStore';
import { useWorkspaceModeStore } from '../../stores/workspaceModeStore';
import { appendDraftToContent, messageToDraft } from './messageToDraft';
import './BrainstormChat.css';

export const BrainstormChat: React.FC = () => {
  const messages = useBrainstormChatStore((s) => s.messages);
  const { send, cancel, reset, isStreaming, error } = useBrainstormChat();
  const [draft, setDraft] = useState('');
  const [sentToWriteId, setSentToWriteId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const setWorkspaceMode = useWorkspaceModeStore((s) => s.setActive);

  const sendToWrite = (m: BrainstormMessage): void => {
    const editor = useEditorStore.getState();
    const block = messageToDraft(m);
    editor.setContent(appendDraftToContent(editor.content, block));
    setSentToWriteId(m.id);
    setWorkspaceMode('write');
  };

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!draft.trim() || isStreaming) return;
    const text = draft;
    setDraft('');
    await send(text);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Cmd/Ctrl+Enter sends; bare Enter is newline (historian writes paragraphs).
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void onSubmit(e);
    }
  };

  return (
    <div className="brainstorm-chat">
      <div className="brainstorm-chat__messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="brainstorm-chat__empty">
            Commencez une exploration libre. Les <code>.cliohints</code> et
            les sources indexées seront injectés automatiquement.
          </div>
        )}
        {messages.map((m) => (
          <article
            key={m.id}
            className={`brainstorm-chat__msg brainstorm-chat__msg--${m.role}${
              m.pending ? ' brainstorm-chat__msg--pending' : ''
            }`}
          >
            <header className="brainstorm-chat__role">
              {m.role === 'user' ? 'Vous' : m.role === 'assistant' ? 'Assistant' : 'Système'}
              {m.ragCitation && (
                <span className="brainstorm-chat__badge">citation</span>
              )}
              {m.error && (
                <span className="brainstorm-chat__error-badge">erreur</span>
              )}
            </header>
            <div className="brainstorm-chat__content">
              {m.content || (m.pending ? '…' : '')}
            </div>
            {m.error && (
              <div className="brainstorm-chat__error">{m.error}</div>
            )}
            {m.role === 'assistant' && !m.pending && !m.error && m.content && (
              <div className="brainstorm-chat__msg-actions">
                <button
                  type="button"
                  className="brainstorm-chat__btn brainstorm-chat__btn--ghost brainstorm-chat__btn--small"
                  onClick={() => sendToWrite(m)}
                  title="Insère ce tour comme brouillon dans Write"
                >
                  <ArrowRight size={12} />{' '}
                  {sentToWriteId === m.id ? 'Envoyé' : 'Envoyer vers Write'}
                </button>
              </div>
            )}
          </article>
        ))}
      </div>

      {error && !isStreaming && (
        <div className="brainstorm-chat__banner">{error}</div>
      )}

      <form className="brainstorm-chat__composer" onSubmit={onSubmit}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Question, hypothèse, piste à explorer… (Cmd/Ctrl + Enter pour envoyer)"
          rows={3}
          disabled={isStreaming}
        />
        <div className="brainstorm-chat__actions">
          {messages.length > 0 && !isStreaming && (
            <button
              type="button"
              className="brainstorm-chat__btn brainstorm-chat__btn--ghost"
              onClick={reset}
              title="Réinitialiser la conversation"
            >
              <Trash2 size={14} /> Reset
            </button>
          )}
          {isStreaming ? (
            <button
              type="button"
              className="brainstorm-chat__btn brainstorm-chat__btn--danger"
              onClick={() => void cancel()}
            >
              <X size={14} /> Annuler
            </button>
          ) : (
            <button
              type="submit"
              className="brainstorm-chat__btn brainstorm-chat__btn--primary"
              disabled={!draft.trim()}
            >
              <Send size={14} /> Envoyer
            </button>
          )}
        </div>
      </form>
    </div>
  );
};
