import React, { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import { CollapsibleSection } from '../common/CollapsibleSection';
import { HelperTooltip } from '../Methodology/HelperTooltip';
import { useCorpusData } from './useCorpusData';
import { CorpusTopicsSection } from './CorpusTopicsSection';
import { CorpusGraphSection } from './CorpusGraphSection';
import {
  exportTopicsAsJSON,
  exportTopicsAsCSV,
  exportTopicsAsMarkdown,
  exportGraphAsGEXF,
} from './corpus-exporters';
import './CorpusExplorerPanel.css';

const TextometricsPanel = lazy(() =>
  import('./TextometricsPanel').then((m) => ({ default: m.TextometricsPanel })),
);

export const CorpusExplorerPanel: React.FC = () => {
  const { t } = useTranslation();
  const data = useCorpusData();

  if (!data.currentProject) {
    return (
      <div className="corpus-explorer-panel">
        <div className="corpus-empty">
          <div className="empty-icon">📁</div>
          <h3>{t('corpus.noProject')}</h3>
          <p>{t('corpus.openOrCreateProject')}</p>
        </div>
      </div>
    );
  }

  if (data.loading) {
    return (
      <div className="corpus-explorer-panel">
        <div className="corpus-loading">
          <div className="loading-spinner"></div>
          <p>{t('corpus.loading')}</p>
        </div>
      </div>
    );
  }

  if (data.error) {
    return (
      <div className="corpus-explorer-panel">
        <div className="corpus-error">
          <h3>{t('corpus.error')}</h3>
          <p>{data.error}</p>
          <button onClick={data.loadCorpusData}>{t('corpus.retry')}</button>
        </div>
      </div>
    );
  }

  if (!data.statistics || !data.graphData || data.graphData.nodes.length === 0) {
    return (
      <div className="corpus-explorer-panel">
        <div className="corpus-empty">
          <div className="empty-icon">📊</div>
          <h3>{t('corpus.emptyCorpus')}</h3>
          <p>{t('corpus.indexDocuments')}</p>
        </div>
      </div>
    );
  }

  const handleLearnMore = () => {
    window.dispatchEvent(new CustomEvent('show-methodology-modal', { detail: { feature: 'corpus' } }));
  };

  return (
    <div className="corpus-explorer-panel">
      {/* Header */}
      <div className="corpus-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <h3>{t('corpus.exploration')}</h3>
          <HelperTooltip content={t('corpus.tooltipHelp')} onLearnMore={handleLearnMore} />
        </div>
      </div>

      {/* Filters */}
      <CollapsibleSection title={t('corpus.filters')} defaultExpanded={false}>
        <div className="filters-container">
          <div className="filter-group">
            <label>{t('corpus.year')}</label>
            <select
              value={data.filters.year || ''}
              onChange={(e) =>
                data.setFilters({ ...data.filters, year: e.target.value ? parseInt(e.target.value) : null })
              }
            >
              <option value="">{t('corpus.allYears')}</option>
              {data.getAvailableYears().map((year) => (
                <option key={year} value={year}>{year}</option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label>{t('corpus.author')}</label>
            <select
              value={data.filters.author || ''}
              onChange={(e) =>
                data.setFilters({ ...data.filters, author: e.target.value || null })
              }
            >
              <option value="">{t('corpus.allAuthors')}</option>
              {data.getAvailableAuthors().map((author) => (
                <option key={author} value={author}>{author}</option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label>{t('corpus.language')}</label>
            <select
              value={data.filters.language || ''}
              onChange={(e) =>
                data.setFilters({ ...data.filters, language: e.target.value || null })
              }
            >
              <option value="">{t('corpus.allLanguages')}</option>
              {(data.statistics?.languages || []).map((lang) => (
                <option key={lang} value={lang}>{lang}</option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label>{t('corpus.topic')}</label>
            <select
              value={data.filters.topic !== null ? data.filters.topic : ''}
              onChange={(e) =>
                data.setFilters({ ...data.filters, topic: e.target.value ? parseInt(e.target.value) : null })
              }
              disabled={!data.topicAnalysis}
            >
              <option value="">{t('corpus.allTopics')}</option>
              {(data.topicAnalysis?.topics || []).map((topic) => (
                <option key={topic.id} value={topic.id}>
                  Topic {topic.id}: {topic.keywords.slice(0, 3).join(', ')}
                </option>
              ))}
            </select>
          </div>

          <button onClick={data.clearFilters} className="clear-filters-btn">
            {t('corpus.resetFilters')}
          </button>
        </div>
      </CollapsibleSection>

      {/* Statistics */}
      <CollapsibleSection title={t('corpus.statistics')} defaultExpanded={true}>
        <div className="corpus-stats">
          <div className="stat-card">
            <div className="stat-value">{data.statistics.documentCount}</div>
            <div className="stat-label">{t('corpus.documents')}</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{data.statistics.totalCitationsExtracted}</div>
            <div className="stat-label">{t('corpus.extractedCitations')}</div>
            <div className="stat-detail">
              {data.statistics.citationCount} {t('corpus.internalCitations')} (
              {Math.round(
                (data.statistics.citationCount / Math.max(data.statistics.totalCitationsExtracted, 1)) * 100
              )}
              %)
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{data.statistics.authorCount}</div>
            <div className="stat-label">{t('corpus.authors')}</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{data.statistics.languageCount}</div>
            <div className="stat-label">{t('corpus.languages')}</div>
          </div>
        </div>

        {data.statistics.yearRange && (
          <div className="stat-info">
            <span className="stat-info-label">{t('corpus.period')}</span>
            <span className="stat-info-value">
              {data.statistics.yearRange.min} - {data.statistics.yearRange.max}
            </span>
          </div>
        )}

        {data.statistics.languages && data.statistics.languages.length > 0 && (
          <div className="stat-info">
            <span className="stat-info-label">{t('corpus.languages')}:</span>
            <span className="stat-info-value">{data.statistics.languages.join(', ')}</span>
          </div>
        )}
      </CollapsibleSection>

      {/* Textometrics */}
      <CollapsibleSection title={t('corpus.textometrics')} defaultExpanded={false}>
        <Suspense fallback={null}>
          <TextometricsPanel />
        </Suspense>
      </CollapsibleSection>

      {/* Topics */}
      <CollapsibleSection title={t('corpus.topicAnalysis')} defaultExpanded={false}>
        <CorpusTopicsSection
          topicAnalysis={data.topicAnalysis}
          topicTimeline={data.topicTimeline}
          fullGraphData={data.fullGraphData}
          loadingTopics={data.loadingTopics}
          numTopics={data.numTopics}
          setNumTopics={data.setNumTopics}
          expandedTopic={data.expandedTopic}
          setExpandedTopic={data.setExpandedTopic}
          filters={data.filters}
          setFilters={data.setFilters}
          onLoadTopics={() => data.loadTopics(t)}
          onExportJSON={() => data.topicAnalysis && exportTopicsAsJSON(data.topicAnalysis, data.fullGraphData)}
          onExportCSV={() => data.topicAnalysis && exportTopicsAsCSV(data.topicAnalysis, data.fullGraphData)}
          onExportMarkdown={() => data.topicAnalysis && exportTopicsAsMarkdown(data.topicAnalysis, data.fullGraphData)}
          getDocumentsForTopic={data.getDocumentsForTopic}
        />
      </CollapsibleSection>

      {/* Knowledge Graph */}
      <CollapsibleSection title={t('corpus.knowledgeGraph')} defaultExpanded={true}>
        <CorpusGraphSection
          graphData={data.graphData}
          graphRef={data.graphRef as React.MutableRefObject<unknown>}
          selectedNode={data.selectedNode}
          setSelectedNode={data.setSelectedNode}
          graphSimilarityThreshold={data.graphSimilarityThreshold}
          setGraphSimilarityThreshold={data.setGraphSimilarityThreshold}
          regeneratingGraph={data.regeneratingGraph}
          onRegenerateGraph={() => data.regenerateGraph(t)}
          onExportGEXF={() => data.fullGraphData && exportGraphAsGEXF(data.fullGraphData)}
        />
      </CollapsibleSection>

      {/* Graph info footer */}
      <div className="graph-info">
        <div className="graph-info-item">
          <span className="graph-info-label">{t('corpus.nodes')}</span>
          <span className="graph-info-value">{data.graphData.nodes.length}</span>
        </div>
        <div className="graph-info-item">
          <span className="graph-info-label">{t('corpus.links')}</span>
          <span className="graph-info-value">{data.graphData.edges.length}</span>
        </div>
      </div>
    </div>
  );
};
