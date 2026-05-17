import React, { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import type { GraphData, GraphNode, TopicAnalysisResult } from './corpus-types';

const TopicTimeline = lazy(() =>
  import('./TopicTimeline').then((m) => ({ default: m.TopicTimeline })),
);

interface Props {
  topicAnalysis: TopicAnalysisResult | null;
  topicTimeline: Array<{ year: number; [key: string]: number }> | null;
  fullGraphData: GraphData | null;
  loadingTopics: boolean;
  numTopics: number;
  setNumTopics: (n: number) => void;
  expandedTopic: number | null;
  setExpandedTopic: (id: number | null) => void;
  filters: { year: number | null; author: string | null; language: string | null; topic: number | null };
  setFilters: (f: { year: number | null; author: string | null; language: string | null; topic: number | null }) => void;
  onLoadTopics: () => void;
  onExportJSON: () => void;
  onExportCSV: () => void;
  onExportMarkdown: () => void;
  getDocumentsForTopic: (topicId: number) => GraphNode[];
}

export const CorpusTopicsSection: React.FC<Props> = ({
  topicAnalysis,
  topicTimeline,
  loadingTopics,
  numTopics,
  setNumTopics,
  expandedTopic,
  setExpandedTopic,
  filters,
  setFilters,
  onLoadTopics,
  onExportJSON,
  onExportCSV,
  onExportMarkdown,
  getDocumentsForTopic,
}) => {
  const { t } = useTranslation();

  if (!topicAnalysis) {
    return (
      <div className="topics-empty">
        <p>{t('corpus.noTopicAnalysis')}</p>
        <div className="topics-config">
          <label>
            {t('corpus.numTopics')}
            <input
              type="number"
              min="2"
              max="50"
              value={numTopics}
              onChange={(e) => setNumTopics(parseInt(e.target.value) || 10)}
              className="topics-number-input"
            />
          </label>
        </div>
        <button onClick={onLoadTopics} disabled={loadingTopics} className="load-topics-btn">
          {loadingTopics ? t('corpus.analyzing') : t('corpus.analyzeTopics')}
        </button>
        <p className="topics-help">{t('corpus.topicHelp')}</p>
      </div>
    );
  }

  return (
    <div className="topics-list">
      <div className="topics-header">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span>{t('corpus.topicsIdentified', { count: topicAnalysis.topics?.length || 0 })}</span>
          {topicAnalysis.statistics && (
            <span style={{ fontSize: '0.85em', color: 'var(--text-tertiary)' }}>
              {t('corpus.documentsAnalyzed', {
                analyzed: topicAnalysis.statistics.numDocumentsInTopics,
                total: topicAnalysis.statistics.totalDocuments,
              })}
              {topicAnalysis.statistics.numOutliers > 0 && (
                <span style={{ marginLeft: '0.5rem' }}>
                  ({topicAnalysis.statistics.numOutliers} {t('corpus.outliers')})
                </span>
              )}
            </span>
          )}
        </div>
        <div className="topics-actions">
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9em' }}>
            {t('corpus.nbTopics')}
            <input
              type="number"
              min="2"
              max="50"
              value={numTopics}
              onChange={(e) => setNumTopics(parseInt(e.target.value) || 10)}
              className="topics-number-input"
              style={{ width: '60px' }}
            />
          </label>
          <button onClick={onLoadTopics} disabled={loadingTopics} className="reload-topics-btn">
            {loadingTopics ? t('corpus.analyzing') : t('corpus.reanalyze')}
          </button>
          <button onClick={onExportJSON} className="export-btn" title="JSON">
            JSON
          </button>
          <button onClick={onExportCSV} className="export-btn" title="CSV">
            CSV
          </button>
          <button onClick={onExportMarkdown} className="export-btn" title="Markdown">
            MD
          </button>
        </div>
      </div>

      {topicTimeline && topicTimeline.length > 0 && (
        <div className="topic-timeline-section">
          <h4 style={{ margin: '10px 0', fontSize: '14px', fontWeight: 500 }}>
            {t('corpus.topicTimeline')}
          </h4>
          <Suspense fallback={null}>
            <TopicTimeline timelineData={topicTimeline} topics={topicAnalysis.topics} />
          </Suspense>
        </div>
      )}

      {(topicAnalysis.topics || []).map((topic) => {
        const topicDocs = getDocumentsForTopic(topic.id);
        const isExpanded = expandedTopic === topic.id;

        return (
          <div
            key={topic.id}
            className={`topic-card ${filters.topic === topic.id ? 'topic-selected' : ''} ${isExpanded ? 'topic-expanded' : ''}`}
          >
            <div
              className="topic-header"
              onClick={() =>
                setFilters({
                  year: null,
                  author: null,
                  language: null,
                  topic: filters.topic === topic.id ? null : topic.id,
                })
              }
            >
              <span className="topic-id">Topic {topic.id}</span>
              <span className="topic-size">
                {topic.size} {t('corpus.topicDocuments')}
              </span>
            </div>
            <div className="topic-keywords">
              {topic.keywords.slice(0, 5).map((keyword, idx) => (
                <span key={idx} className="topic-keyword">
                  {keyword}
                </span>
              ))}
            </div>
            <button
              className="topic-expand-btn"
              onClick={(e) => {
                e.stopPropagation();
                setExpandedTopic(isExpanded ? null : topic.id);
              }}
            >
              {isExpanded
                ? `▼ ${t('corpus.hideDocuments')}`
                : `▶ ${t('corpus.showDocuments', { count: topicDocs.length })}`}
            </button>

            {isExpanded && (
              <div className="topic-documents">
                {topicDocs.map((doc) => (
                  <div key={doc.id} className="topic-document-item">
                    <span className="doc-title">{doc.metadata?.title || doc.label}</span>
                    {doc.metadata?.author && (
                      <span className="doc-author"> - {doc.metadata.author}</span>
                    )}
                    {doc.metadata?.year && (
                      <span className="doc-year"> ({doc.metadata.year})</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
