/**
 * Similarity Panel
 *
 * Main panel component for the Similarity Finder feature.
 * Shows analysis results, progress, and options.
 */
import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Settings, Trash2, RefreshCw } from 'lucide-react';
import { useSimilarityStore, useAllSegments, useHasResults, useTotalRecommendations } from '../../stores/similarityStore';
import { useEditorStore } from '../../stores/editorStore';
import { SimilarityProgress } from './SimilarityProgress';
import { SimilarityResults } from './SimilarityResults';
import { SimilarityOptions } from './SimilarityOptions';
import { HelperTooltip } from '../Methodology/HelperTooltip';
import { logger } from '../../utils/logger';
import './SimilarityPanel.css';

export const SimilarityPanel: React.FC = () => {
  const { t } = useTranslation('common');
  const {
    isPanelOpen,
    closePanel,
    isAnalyzing,
    error,
    analyze,
    clearResults,
    loadCachedResults,
  } = useSimilarityStore();

  const { content } = useEditorStore();
  const segments = useAllSegments();
  const hasResults = useHasResults();
  const totalRecommendations = useTotalRecommendations();

  const [showOptions, setShowOptions] = React.useState(false);

  // Load cached results on mount
  useEffect(() => {
    if (isPanelOpen) {
      loadCachedResults();
    }
  }, [isPanelOpen, loadCachedResults]);

  // Don't render if panel is closed
  if (!isPanelOpen) {
    return null;
  }

  const handleAnalyze = () => {
    logger.component('SimilarityPanel', 'Starting analysis');
    if (content.trim().length > 0) {
      analyze(content);
    } else {
      alert(t('similarity.emptyDocument'));
    }
  };

  const handleClearResults = () => {
    logger.component('SimilarityPanel', 'Clearing results');
    if (window.confirm(t('similarity.clearConfirm'))) {
      clearResults();
    }
  };

  return (
    <div className="similarity-panel">
      {/* Header */}
      <div className="similarity-panel-header">
        <div className="similarity-panel-title-wrapper">
          <h3 className="similarity-panel-title">{t('similarity.title')}</h3>
          <HelperTooltip content={t('similarity.help')} />
        </div>
        <div className="similarity-panel-actions">
          <button
            className="similarity-icon-btn"
            onClick={() => setShowOptions(true)}
            title={t('similarity.options')}
          >
            <Settings size={16} />
          </button>
          {hasResults && (
            <button
              className="similarity-icon-btn"
              onClick={handleClearResults}
              title={t('similarity.clear')}
            >
              <Trash2 size={16} />
            </button>
          )}
          <button
            className="similarity-icon-btn"
            onClick={closePanel}
            title={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="similarity-panel-content">
        {/* Error display */}
        {error && (
          <div className="similarity-error">
            <span className="similarity-error-icon">⚠️</span>
            <span className="similarity-error-message">{error}</span>
          </div>
        )}

        {/* Progress indicator */}
        {isAnalyzing && <SimilarityProgress />}

        {/* Results or empty state */}
        {!isAnalyzing && (
          <>
            {hasResults ? (
              <>
                {/* Summary */}
                <div className="similarity-summary">
                  <span className="similarity-summary-text">
                    {t('similarity.summary', {
                      segments: segments.length,
                      recommendations: totalRecommendations,
                    })}
                  </span>
                  <button
                    className="similarity-refresh-btn"
                    onClick={handleAnalyze}
                    title={t('similarity.refresh')}
                  >
                    <RefreshCw size={14} />
                  </button>
                </div>

                {/* Results list */}
                <SimilarityResults />
              </>
            ) : (
              /* Empty state */
              <div className="similarity-empty">
                <div className="similarity-empty-icon">🔍</div>
                <p className="similarity-empty-text">{t('similarity.emptyState')}</p>
                <button
                  className="similarity-analyze-btn"
                  onClick={handleAnalyze}
                  disabled={content.trim().length === 0}
                >
                  {t('similarity.analyze')}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Options modal */}
      {showOptions && <SimilarityOptions onClose={() => setShowOptions(false)} />}
    </div>
  );
};
