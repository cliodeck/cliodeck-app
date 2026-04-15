/**
 * BrainstormChat (fusion phase 3.2, unified UI pass).
 *
 * Thin adapter over the shared ChatSurface: maps BrainstormMessage into
 * UnifiedMessage and provides the "send to write" action as message extras.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { ArrowRight, Check, Loader2, X } from 'lucide-react';
import { useBrainstormChatStore, type BrainstormMessage, type BrainstormSource } from '../../stores/brainstormChatStore';
import { useBrainstormChat } from './useBrainstormChat';
import { SourcePopover } from './SourcePopover';
import { useEditorStore } from '../../stores/editorStore';
import { useWorkspaceModeStore } from '../../stores/workspaceModeStore';
import { appendDraftToContent, messageToDraft } from './messageToDraft';
import { ChatSurface } from '../Chat/ChatSurface';
import { UnifiedMessage } from '../Chat/types';
import { ExplanationPanel } from '../Chat/ExplanationPanel';
import type { RAGExplanation } from '../../stores/chatStore';

interface BrainstormUnifiedMessage extends UnifiedMessage {
  original: BrainstormMessage;
}

export const BrainstormChat: React.FC = () => {
  const messages = useBrainstormChatStore((s) => s.messages);
  const { send, cancel, reset, isStreaming, error } = useBrainstormChat();
  const setWorkspaceMode = useWorkspaceModeStore((s) => s.setActive);
  const [sentToWriteId, setSentToWriteId] = useState<string | null>(null);
  const [activeSource, setActiveSource] = useState<{ msgId: string; index: number } | null>(null);

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

  const renderExtras = useCallback((m: BrainstormUnifiedMessage): React.ReactNode => {
    const orig = m.original;
    const sources = orig.sources ?? [];
    const toolCalls = orig.toolCalls ?? [];
    return (
      <>
        {orig.error && <div className="brainstorm-chat__error">{orig.error}</div>}
        {m.role === 'assistant' && sources.length > 0 && (
          <details className="brainstorm-chat__sources">
            <summary>
              📚 Sources ({sources.length})
            </summary>
            <ul>
              {sources.map((s: BrainstormSource, i: number) => {
                const isActive =
                  activeSource?.msgId === orig.id && activeSource.index === i;
                return (
                  <li
                    key={i}
                    className={`brainstorm-chat__source brainstorm-chat__source--${s.sourceType}`}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setActiveSource(
                          isActive ? null : { msgId: orig.id, index: i }
                        )
                      }
                      aria-expanded={isActive}
                      data-testid={`source-badge-${i}`}
                      style={{
                        all: 'unset',
                        cursor: 'pointer',
                        display: 'block',
                        width: '100%',
                      }}
                    >
                      <div className="brainstorm-chat__source-head">
                        <span className="brainstorm-chat__source-kind">{s.kind}</span>
                        <strong>{s.title}</strong>
                        <span className="brainstorm-chat__source-score">
                          {(s.similarity * 100).toFixed(1)}%
                        </span>
                      </div>
                      <p className="brainstorm-chat__source-snippet">{s.snippet}</p>
                    </button>
                    {isActive && (
                      <div style={{ marginTop: 6 }}>
                        <SourcePopover
                          source={s}
                          onClose={() => setActiveSource(null)}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </details>
        )}
        {m.role === 'assistant' && toolCalls.length > 0 && (
          <ul className="brainstorm-chat__tool-calls">
            {toolCalls.map((tc) => {
              const isDone = tc.status === 'done';
              const failed = isDone && tc.ok === false;
              const cls = failed
                ? 'brainstorm-chat__tool-call brainstorm-chat__tool-call--error'
                : isDone
                  ? 'brainstorm-chat__tool-call brainstorm-chat__tool-call--done'
                  : 'brainstorm-chat__tool-call brainstorm-chat__tool-call--running';
              return (
                <li key={tc.id} className={cls} title={tc.errorMessage}>
                  <span className="brainstorm-chat__tool-call-icon">
                    {!isDone && <Loader2 size={11} className="brainstorm-chat__spin" />}
                    {isDone && !failed && <Check size={11} />}
                    {failed && <X size={11} />}
                  </span>
                  <span className="brainstorm-chat__tool-call-arrow">
                    {isDone ? '' : '→'}
                  </span>
                  <code className="brainstorm-chat__tool-call-name">{tc.name}</code>
                  {!isDone && <span className="brainstorm-chat__tool-call-ellipsis">…</span>}
                  {isDone && typeof tc.durationMs === 'number' && (
                    <span className="brainstorm-chat__tool-call-duration">
                      ({tc.durationMs}ms)
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {m.role === 'assistant' && orig.explanation && (
          <ExplanationPanel
            explanation={orig.explanation as unknown as RAGExplanation}
          />
        )}
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
  }, [sendToWrite, sentToWriteId, activeSource]);

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
