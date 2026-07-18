/**
 * AssistantChat — LA coquille de chat unifiée (étape 5 de la fusion,
 * docs/chat-unification-etat-des-lieux.md).
 *
 * Remplace la paire ChatInterface (panneau droit) / BrainstormChat (centre
 * du mode brainstorm) : mêmes moteur, store et réglages, une seule UI.
 *
 * - `variant="full"` — centre du mode brainstorm : starters, ContextGraph.
 * - `variant="panel"` — panneau droit (explore/write/export) : compact,
 *   titre « AI Assistant », état vide indexation ; tout le reste identique
 *   (SourcePopover, badges d'outils, ExplanationPanel, consentement cloud,
 *   envoi vers l'éditeur en proposition).
 *
 * Les deux montages sont mutuellement exclusifs (le panneau droit est
 * masqué en mode brainstorm — MainLayout `!isBrainstorm`). Un double
 * montage accidentel resterait sans double-dispatch : dans
 * useBrainstormChat, seule l'instance qui a émis `send` connaît le mapping
 * session→assistant (refs locales), l'autre ignore les événements.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Check, Highlighter, Loader2, Settings, SlidersHorizontal, X } from 'lucide-react';
import { useChatStore, type BrainstormMessage, type BrainstormSource } from '../../stores/chatStore';
import { useBrainstormChat } from '../Brainstorm/useBrainstormChat';
import { SourcePopover } from '../Brainstorm/SourcePopover';
import { useEditorStore } from '../../stores/editorStore';
import { useWorkspaceModeStore } from '../../stores/workspaceModeStore';
import { useBibliographyStore } from '../../stores/bibliographyStore';
import { useDialogStore } from '../../stores/dialogStore';
import { useModeStore } from '../../stores/modeStore';
import { useCloudConsentGuard } from './useCloudConsentGuard';
import { messageToDraft } from '../Brainstorm/messageToDraft';
import { ChatSurface } from './ChatSurface';
import { ModeSelector } from './ModeSelector';
import { RAGSettingsPanel } from './RAGSettingsPanel';
import { CloudConsentDialog } from './CloudConsentDialog';
import { useChatSettingsProjection } from './useChatSettingsProjection';
import { UnifiedMessage } from './types';
import { ExplanationPanel } from './ExplanationPanel';
import { McpToolsBanner } from '../Brainstorm/McpToolsBanner';
import { ContextGraph } from '../Brainstorm/ContextGraph';
import { useMcpToolsList } from '../Brainstorm/useMcpToolsList';
import { HelperTooltip } from '../Methodology/HelperTooltip';
import './AssistantChat.css';
// RAGExplanation type alias lives in chatStore.
import type { RAGExplanation } from '../../stores/chatStore';

interface AssistantUnifiedMessage extends UnifiedMessage {
  original: BrainstormMessage;
}

export interface AssistantChatProps {
  variant: 'full' | 'panel';
}

export const AssistantChat: React.FC<AssistantChatProps> = ({ variant }) => {
  const { t, i18n } = useTranslation('common');
  const lang = (i18n.language?.substring(0, 2) as 'fr' | 'en') || 'fr';
  const isPanel = variant === 'panel';
  const messages = useChatStore((s) => s.messages);
  const { send, cancel, reset, isStreaming, error } = useBrainstormChat();
  const setWorkspaceMode = useWorkspaceModeStore((s) => s.setActive);
  const { modes } = useModeStore();
  const [sentToWriteId, setSentToWriteId] = useState<string | null>(null);
  const [activeSource, setActiveSource] = useState<{ msgId: string; index: number } | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [nerEnabled, setNerEnabled] = useState(false);
  const [ragStatus, setRagStatus] = useState<{ message: string; isError: boolean } | null>(null);
  const mcpTools = useMcpToolsList();

  // État vide de la variante panel : nombre de PDFs indexés (repris de
  // l'ancien ChatInterface — utile pour comprendre ce que le RAG voit).
  const { indexedFilePaths, refreshIndexedPDFs } = useBibliographyStore();
  useEffect(() => {
    if (isPanel) refreshIndexedPDFs();
  }, [isPanel, refreshIndexedPDFs]);
  const indexedCount = indexedFilePaths.size;

  // Modèle actif, dérivé de la config LLM (résolue côté main au chat) —
  // transmis aux propositions « draft » (source.model, Phase 4b).
  const activeModelRef = useRef<string>('unknown');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const llm: {
          backend: string;
          ollamaChatModel?: string;
          claudeModel?: string;
          openaiModel?: string;
          mistralModel?: string;
          geminiModel?: string;
        } | null = await window.electron.config.get('llm');
        if (cancelled || !llm) return;
        const byBackend: Record<string, string | undefined> = {
          ollama: llm.ollamaChatModel,
          claude: llm.claudeModel,
          openai: llm.openaiModel,
          mistral: llm.mistralModel,
          gemini: llm.geminiModel,
        };
        activeModelRef.current = byBackend[llm.backend] ?? 'unknown';
      } catch {
        // Config inaccessible (préload partiel, tests) : 'unknown' reste.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Project RAG params + active mode onto chatStore.chatSettings so every
  // `fusion.chat.start` picks up current filters.
  useChatSettingsProjection();

  // Bandeau de statut RAG (indexation, retrieval…) — flux fusion:chat:status.
  useEffect(() => {
    const w = window as unknown as {
      electron?: {
        fusion?: {
          chat?: {
            onStatus?: (
              cb: (env: {
                sessionId: string;
                status: { phase: string; label?: string };
              }) => void
            ) => () => void;
          };
        };
      };
    };
    const onStatus = w.electron?.fusion?.chat?.onStatus;
    if (!onStatus) return;
    const unsub = onStatus((env) => {
      const phase = env.status.phase;
      const label = env.status.label ?? phase;
      setRagStatus({ message: label, isError: phase === 'error' });
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!isStreaming && ragStatus) {
      const delay = ragStatus.isError ? 5000 : 0;
      const timer = setTimeout(() => setRagStatus(null), delay);
      return () => clearTimeout(timer);
    }
  }, [isStreaming, ragStatus]);

  const sendToWrite = useCallback(
    (m: BrainstormMessage): void => {
      const editor = useEditorStore.getState();
      const block = messageToDraft(m);
      // Insert at the user's current cursor when an editor is mounted;
      // fall back to append when neither editor exists yet (fusion 2.6,
      // A13 option a). In CM6 the draft becomes an adjudicable proposal
      // carrying the active model + mode.
      editor.insertDraftAtCursor(block, {
        model: activeModelRef.current,
        task: useChatStore.getState().chatSettings.modeId ?? 'brainstorm',
      });
      setSentToWriteId(m.id);
      // Depuis le panneau droit du mode write, on est déjà au bon endroit :
      // ne pas rebasculer (la proposition apparaît sous les yeux).
      if (useWorkspaceModeStore.getState().active !== 'write') {
        setWorkspaceMode('write');
      }
    },
    [setWorkspaceMode]
  );

  const unifiedMessages = useMemo<AssistantUnifiedMessage[]>(
    () =>
      messages.map((m) => {
        // Badge : la citation RAG prime (information de retrieval), sinon
        // le mode IA qui a répondu (comportement hérité du panneau).
        const mode =
          m.modeId && m.modeId !== 'default-assistant'
            ? modes.find((x) => x.metadata.id === m.modeId)
            : undefined;
        const modeBadge = mode ? mode.metadata.name[lang] || m.modeId : undefined;
        return {
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          pending: m.pending,
          isError: !!m.error || !!m.isError,
          badge: m.ragCitation ? t('chat.brainstorm.citationBadge') : modeBadge,
          original: m,
        };
      }),
    [messages, modes, lang, t]
  );

  // Consentement cloud (ADR 0005) via le garde PARTAGÉ.
  const consentGuard = useCloudConsentGuard(send);
  const handleSend = consentGuard.guardedSend;

  const handleClear = useCallback(async () => {
    if (await useDialogStore.getState().showConfirm(t('chat.clearConfirm'))) {
      reset();
    }
  }, [reset, t]);

  const handleLearnMore = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('show-methodology-modal', { detail: { feature: 'chat' } })
    );
  }, []);

  const starterPrompts = [
    t('chat.brainstorm.starter1'),
    t('chat.brainstorm.starter2'),
    t('chat.brainstorm.starter3'),
  ];

  const emptyState = isPanel ? (
    <>
      {indexedCount > 0 ? (
        <>
          <h4>{t('chat.readyState.title')}</h4>
          <p>{t('chat.readyState.message', { count: indexedCount })}</p>
        </>
      ) : (
        <>
          <h4>{t('chat.emptyState.title')}</h4>
          <p>{t('chat.emptyState.message')}</p>
        </>
      )}
    </>
  ) : (
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

  const renderExtras = useCallback((m: AssistantUnifiedMessage): React.ReactNode => {
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

  const statusBanner =
    ragStatus && (isStreaming || ragStatus.isError) ? (
      <div
        className={`rag-status-indicator ${ragStatus.isError ? 'rag-status-error' : ''}`}
        role="status"
        aria-live="polite"
      >
        {ragStatus.message}
      </div>
    ) : undefined;

  const banner =
    error && !isStreaming ? error : statusBanner;

  return (
    <div className={`brainstorm-chat__root ${isPanel ? 'brainstorm-chat__root--panel' : ''}`}>
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
      {!isPanel && <ContextGraph />}
      <div className="brainstorm-chat__surface-wrap">
        <ChatSurface
          title={isPanel ? t('chat.aiAssistant') : undefined}
          headerExtras={
            isPanel ? (
              <HelperTooltip content={t('chat.helpText')} onLearnMore={handleLearnMore} />
            ) : undefined
          }
          messages={unifiedMessages}
          isProcessing={isStreaming}
          onSend={handleSend}
          onCancel={() => void cancel()}
          onClear={messages.length > 0 ? handleClear : undefined}
          emptyState={emptyState}
          banner={banner}
          placeholder={t('chat.brainstorm.placeholder')}
          renderMessageExtras={renderExtras}
          enableNER={nerEnabled}
        />
      </div>
      {consentGuard.dialog.isOpen && (
        <CloudConsentDialog
          providerName={consentGuard.dialog.providerName}
          onConsent={consentGuard.dialog.onConsent}
          onCancel={consentGuard.dialog.onCancel}
        />
      )}
    </div>
  );
};
