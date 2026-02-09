import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useJournalStore } from '../../stores/journalStore';
import { SessionTimeline } from './SessionTimeline';
import { AIOperationsTable } from './AIOperationsTable';
import { ChatHistoryView } from './ChatHistoryView';
import { HelperTooltip } from '../Methodology/HelperTooltip';
import './JournalPanel.css';

export const JournalPanel: React.FC = () => {
  const { t } = useTranslation('common');
  const {
    sessions,
    selectedSession,
    events,
    aiOperations,
    chatMessages,
    statistics,
    allEvents,
    allAIOperations,
    allChatMessages,
    loading,
    error,
    hideEmptySessions,
    viewScope,
    loadSessions,
    selectSession,
    loadStatistics,
    exportReport,
    clearError,
    setHideEmptySessions,
    setViewScope,
    loadAllProjectData,
  } = useJournalStore();

  const [viewMode, setViewMode] = useState<'sessions' | 'timeline' | 'ai-ops' | 'chat'>(
    'sessions'
  );

  // Load sessions and statistics on mount
  useEffect(() => {
    loadSessions();
    loadStatistics();
  }, [loadSessions, loadStatistics]);

  // Load project data when switching to project scope
  useEffect(() => {
    if (viewScope === 'project') {
      loadAllProjectData();
    }
  }, [viewScope, loadAllProjectData]);

  const handleLearnMore = () => {
    window.dispatchEvent(new CustomEvent('show-methodology-modal', { detail: { feature: 'journal' } }));
  };

  // Filter sessions based on hideEmptySessions option
  const displayedSessions = hideEmptySessions
    ? sessions.filter((s) => s.eventCount > 0)
    : sessions;

  // Get data based on view scope
  const currentEvents = viewScope === 'project' ? allEvents : events;
  const currentAIOperations = viewScope === 'project' ? allAIOperations : aiOperations;
  const currentChatMessages = viewScope === 'project' ? allChatMessages : chatMessages;

  if (loading && sessions.length === 0) {
    return (
      <div className="journal-panel">
        <div className="journal-loading">
          <div className="loading-spinner"></div>
          <p>{t('journal.loading')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="journal-panel">
      {/* Header */}
      <div className="journal-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <h2>{t('journal.title')}</h2>
          <HelperTooltip
            content={t('journal.tooltipHelp')}
            onLearnMore={handleLearnMore}
          />
        </div>
        {statistics && (
          <div className="journal-stats-compact">
            <span>{statistics.totalSessions} {t('journal.sessions')}</span>
            <span>{statistics.totalEvents} {t('journal.events')}</span>
            <span>{statistics.totalAIOperations} {t('journal.aiOperations')}</span>
          </div>
        )}
      </div>

      {/* Error message */}
      {error && (
        <div className="journal-error">
          <p>{error}</p>
          <button onClick={clearError}>{t('journal.close')}</button>
        </div>
      )}

      {/* Scope selector (Session vs Project) */}
      <div className="journal-scope-selector">
        <div className="scope-buttons">
          <button
            className={viewScope === 'session' ? 'active' : ''}
            onClick={() => setViewScope('session')}
          >
            {t('journal.bySession')}
          </button>
          <button
            className={viewScope === 'project' ? 'active' : ''}
            onClick={() => setViewScope('project')}
          >
            {t('journal.projectOverview')}
          </button>
        </div>
        {viewScope === 'session' && (
          <label className="hide-empty-checkbox">
            <input
              type="checkbox"
              checked={hideEmptySessions}
              onChange={(e) => setHideEmptySessions(e.target.checked)}
            />
            {t('journal.hideEmptySessions')}
          </label>
        )}
      </div>

      {/* View tabs */}
      <div className="journal-view-tabs">
        {viewScope === 'session' && (
          <button
            className={viewMode === 'sessions' ? 'active' : ''}
            onClick={() => setViewMode('sessions')}
          >
            {t('journal.sessionsTab')}
          </button>
        )}
        <button
          className={viewMode === 'timeline' ? 'active' : ''}
          onClick={() => setViewMode('timeline')}
          disabled={viewScope === 'session' && !selectedSession}
        >
          {t('journal.timelineTab')}
        </button>
        <button
          className={viewMode === 'ai-ops' ? 'active' : ''}
          onClick={() => setViewMode('ai-ops')}
          disabled={viewScope === 'session' && !selectedSession}
        >
          {t('journal.aiOpsTab')}
        </button>
        <button
          className={viewMode === 'chat' ? 'active' : ''}
          onClick={() => setViewMode('chat')}
          disabled={viewScope === 'session' && !selectedSession}
        >
          {t('journal.chatHistory')}
        </button>
      </div>

      {/* Content */}
      <div className="journal-content">
        {/* Sessions view (only in session scope) */}
        {viewScope === 'session' && viewMode === 'sessions' && (
          <div className="sessions-list">
            {displayedSessions.length === 0 ? (
              <div className="empty-state">
                {hideEmptySessions && sessions.length > 0 ? (
                  <>
                    <p>{t('journal.allSessionsEmpty')}</p>
                    <p className="help-text">
                      {t('journal.uncheckHideEmpty')}
                    </p>
                  </>
                ) : (
                  <>
                    <p>{t('journal.noSessionsRecorded')}</p>
                    <p className="help-text">
                      {t('journal.sessionsAutoCreated')}
                    </p>
                  </>
                )}
              </div>
            ) : (
              displayedSessions.map((session) => (
                <div
                  key={session.id}
                  className={`session-card ${selectedSession?.id === session.id ? 'selected' : ''}`}
                  onClick={() => selectSession(session.id)}
                >
                  <div className="session-header">
                    <span className="session-date">
                      {session.startedAt.toLocaleDateString()}
                    </span>
                    <span className="session-time">
                      {session.startedAt.toLocaleTimeString(undefined, {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <div className="session-info">
                    <span className="session-duration">
                      {session.totalDurationMs
                        ? `${Math.round(session.totalDurationMs / 1000 / 60)} min`
                        : t('journal.active')}
                    </span>
                    <span className="session-events">{session.eventCount} {t('journal.events')}</span>
                  </div>
                  {selectedSession?.id === session.id && (
                    <div className="session-actions">
                      <button onClick={(e) => {
                        e.stopPropagation();
                        exportReport(session.id, 'markdown');
                      }}>
                        {t('journal.exportMD')}
                      </button>
                      <button onClick={(e) => {
                        e.stopPropagation();
                        exportReport(session.id, 'json');
                      }}>
                        {t('journal.exportJSON')}
                      </button>
                      <button onClick={(e) => {
                        e.stopPropagation();
                        exportReport(session.id, 'latex');
                      }}>
                        {t('journal.exportLaTeX')}
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {/* Timeline view */}
        {viewMode === 'timeline' && (viewScope === 'project' || selectedSession) && (
          <SessionTimeline
            events={currentEvents}
            title={viewScope === 'project' ? t('journal.fullProjectTimeline') : t('journal.sessionTimeline')}
          />
        )}

        {/* AI Operations view */}
        {viewMode === 'ai-ops' && (viewScope === 'project' || selectedSession) && (
          <AIOperationsTable operations={currentAIOperations} />
        )}

        {/* Chat History view */}
        {viewMode === 'chat' && (viewScope === 'project' || selectedSession) && (
          <ChatHistoryView messages={currentChatMessages} />
        )}

        {/* Empty state for project view when in sessions tab */}
        {viewScope === 'project' && viewMode === 'sessions' && (
          <div className="empty-state">
            <p>{t('journal.selectViewAbove')}</p>
            <p className="help-text">
              {t('journal.projectOverviewHelp')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
