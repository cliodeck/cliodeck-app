/**
 * BrainstormChat (fusion phase 3.2, unified UI pass).
 *
 * Thin adapter over the shared ChatSurface: maps BrainstormMessage into
 * UnifiedMessage and provides the "send to write" action as message extras.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Check, Highlighter, Loader2, Settings, SlidersHorizontal, X } from 'lucide-react';
import { useChatStore, type BrainstormMessage, type BrainstormSource } from '../../stores/chatStore';
import { useBrainstormChat } from './useBrainstormChat';
import { SourcePopover } from './SourcePopover';
import { useEditorStore } from '../../stores/editorStore';
import { useWorkspaceModeStore } from '../../stores/workspaceModeStore';
import { useCloudConsentStore, isCloudProvider } from '../../stores/cloudConsentStore';
import { messageToDraft } from './messageToDraft';
import { ChatSurface } from '../Chat/ChatSurface';
import { ModeSelector } from '../Chat/ModeSelector';
import { RAGSettingsPanel } from '../Chat/RAGSettingsPanel';
import { CloudConsentDialog } from '../Chat/CloudConsentDialog';
import { useChatSettingsProjection } from '../Chat/useChatSettingsProjection';
import { UnifiedMessage } from '../Chat/types';
import { ExplanationPanel } from '../Chat/ExplanationPanel';
import { McpToolsBanner } from './McpToolsBanner';
import { ContextGraph } from './ContextGraph';
import { useMcpToolsList } from './useMcpToolsList';
import './BrainstormChat.css';
// RAGExplanation type alias lives in chatStore.
import type { RAGExplanation } from '../../stores/chatStore';

interface BrainstormUnifiedMessage extends UnifiedMessage {
  original: BrainstormMessage;
}

export const BrainstormChat: React.FC = () => {
  const { t } = useTranslation('common');
  const messages = useChatStore((s) => s.messages);
  const { send, cancel, reset, isStreaming, error } = useBrainstormChat();
  const setWorkspaceMode = useWorkspaceModeStore((s) => s.setActive);
  const [sentToWriteId, setSentToWriteId] = useState<string | null>(null);
  const [activeSource, setActiveSource] = useState<{ msgId: string; index: number } | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [nerEnabled, setNerEnabled] = useState(false);
  const mcpTools = useMcpToolsList();

  // Cloud consent (ADR 0005, Phase 4.3)
  const cloudConsented = useCloudConsentStore((s) => s.consented);
  const grantConsent = useCloudConsentStore((s) => s.grant);
  const [cloudCheck, setCloudCheck] = useState<{ isCloud: boolean; providerName: string }>({ isCloud: false, providerName: '' });
  const [showConsentDialog, setShowConsentDialog] = useState(false);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);

  // Modèle actif, dérivé de la config LLM (résolue côté main au chat) —
  // transmis aux propositions « draft Brainstorm » (source.model, Phase 4b).
  const activeModelRef = useRef<string>('unknown');

  useEffect(() => {
    window.electron.config
      .get('llm')
      .then(
        (llm: {
          backend: string;
          ollamaURL?: string;
          ollamaChatModel?: string;
          claudeModel?: string;
          openaiModel?: string;
          mistralModel?: string;
          geminiModel?: string;
        } | null) => {
          if (!llm) return;
          setCloudCheck(isCloudProvider(llm));
          const byBackend: Record<string, string | undefined> = {
            ollama: llm.ollamaChatModel,
            claude: llm.claudeModel,
            openai: llm.openaiModel,
            mistral: llm.mistralModel,
            gemini: llm.geminiModel,
          };
          activeModelRef.current = byBackend[llm.backend] ?? 'unknown';
        }
      )
      .catch(() => {});
  }, []);

  // Project RAG params + active mode onto chatStore.chatSettings so every
  // `fusion.chat.start` from Brainstorm picks up current filters.
  useChatSettingsProjection();

  const sendToWrite = useCallback(
    (m: BrainstormMessage): void => {
      const editor = useEditorStore.getState();
      const block = messageToDraft(m);
      // Insert at the user's current cursor when an editor is mounted;
      // fall back to append when neither editor exists yet (fusion 2.6,
      // A13 option a). The undo path is the editor's own native history
      // — a single Cmd/Ctrl-Z reverts the splice. In CM6 the draft becomes
      // an adjudicable proposal carrying the active model + mode.
      editor.insertDraftAtCursor(block, {
        model: activeModelRef.current,
        task: useChatStore.getState().chatSettings.modeId ?? 'brainstorm',
      });
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
        badge: m.ragCitation ? t('chat.brainstorm.citationBadge') : undefined,
        original: m,
      })),
    [messages]
  );

  const handleSend = useCallback(
    async (text: string) => {
      // If cloud provider and not yet consented this session, show dialog
      if (cloudCheck.isCloud && !cloudConsented) {
        setPendingMessage(text);
        setShowConsentDialog(true);
        return;
      }
      await send(text);
    },
    [send, cloudCheck.isCloud, cloudConsented]
  );

  const handleConsentGranted = useCallback(() => {
    grantConsent(cloudCheck.providerName);
    setShowConsentDialog(false);
    if (pendingMessage) {
      const msg = pendingMessage;
      setPendingMessage(null);
      void send(msg);
    }
  }, [grantConsent, cloudCheck.providerName, pendingMessage, send]);

  const handleConsentCancelled = useCallback(() => {
    setShowConsentDialog(false);
    setPendingMessage(null);
  }, []);

  const starterPrompts = [
    t('chat.brainstorm.starter1'),
    t('chat.brainstorm.starter2'),
    t('chat.brainstorm.starter3'),
  ];

  const emptyState = (
    <div style={{ maxWidth: 420 }}>
      <p>{t('chat.brainstorm.emptyState')}</p>
      <div className="brainstorm-chat__starters">
        {starterPrompts.map((prompt, i) => (
          <button
            key={i}
            type="button"
            className="brainstorm-chat__starter"
            onClick={() => void handleSend(prompt)}
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );

  const renderExtras = useCallback((m: BrainstormUnifiedMessage): React.ReactNode => {
    const orig = m.original;
    const sources = orig.sources ?? [];
    const toolCalls = orig.toolCalls ?? [];
    return (
      <>
        {orig.error && <div className="brainstorm-chat__error">{orig.error}</div>}
        {m.role === 'assistant' && orig.error && (
          <div className="brainstorm-chat__msg-actions">
            <button
              type="button"
              className="chat-surface__inline-btn"
              onClick={() =>
                window.dispatchEvent(new CustomEvent('show-settings-modal'))
              }
            >
              <Settings size={12} /> {t('chat.openSettings')}
            </button>
          </div>
        )}
        {m.role === 'assistant' && sources.length > 0 && (
          <details className="brainstorm-chat__sources">
            <summary>
              📚 {t('chat.brainstorm.sourcesLabel')} ({sources.length})
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
              title={t('chat.brainstorm.sendToWriteTitle')}
            >
              <ArrowRight size={12} />{' '}
              {sentToWriteId === orig.id
                ? t('chat.brainstorm.sentToWrite')
                : t('chat.brainstorm.sendToWrite')}
            </button>
          </div>
        )}
      </>
    );
  }, [sendToWrite, sentToWriteId, activeSource, t]);

  const settingsLabel = t('chat.settings.toggle', 'Chat settings');

  return (
    <div className="brainstorm-chat__root">
      <div className="brainstorm-chat__settings-bar">
        <button
          type="button"
          onClick={() => setIsSettingsOpen((v) => !v)}
          aria-expanded={isSettingsOpen}
          aria-label={settingsLabel}
          title={settingsLabel}
          data-testid="brainstorm-settings-toggle"
          className="brainstorm-chat__settings-toggle"
        >
          <SlidersHorizontal size={13} />
          <span>{settingsLabel}</span>
        </button>
        <button
          type="button"
          onClick={() => setNerEnabled((v) => !v)}
          aria-pressed={nerEnabled}
          title={t('chat.brainstorm.nerToggle')}
          className={`brainstorm-chat__settings-toggle ${nerEnabled ? 'is-active' : ''}`}
        >
          <Highlighter size={13} />
          <span>{t('chat.brainstorm.nerToggle')}</span>
        </button>
        {isSettingsOpen && <ModeSelector />}
      </div>
      {isSettingsOpen && (
        <div
          className="brainstorm-chat__settings-panel"
          data-testid="brainstorm-settings-panel"
        >
          <RAGSettingsPanel />
        </div>
      )}
      <McpToolsBanner tools={mcpTools} />
      <ContextGraph />
      <div className="brainstorm-chat__surface-wrap">
        <ChatSurface
          messages={unifiedMessages}
          isProcessing={isStreaming}
          onSend={handleSend}
          onCancel={() => void cancel()}
          onClear={messages.length > 0 ? reset : undefined}
          emptyState={emptyState}
          banner={error && !isStreaming ? error : undefined}
          placeholder={t('chat.brainstorm.placeholder')}
          renderMessageExtras={renderExtras}
          enableNER={nerEnabled}
        />
      </div>
      {showConsentDialog && (
        <CloudConsentDialog
          providerName={cloudCheck.providerName}
          onConsent={handleConsentGranted}
          onCancel={handleConsentCancelled}
        />
      )}
    </div>
  );
};
