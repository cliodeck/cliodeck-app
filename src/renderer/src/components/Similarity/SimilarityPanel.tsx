/**
 * Similarity Panel
 *
 * Main panel component for the Similarity Finder feature.
 * Shows analysis results, progress, and options.
 */
import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Settings, Trash2, RefreshCw, AlertTriangle, Search } from 'lucide-react';
import { useSimilarityStore, useAllSegments, useHasResults, useTotalRecommendations } from '../../stores/similarityStore';
import { useEditorStore } from '../../stores/editorStore';
import { useProjectStore } from '../../stores/projectStore';
import { SimilarityProgress } from './SimilarityProgress';
import { SimilarityResults } from './SimilarityResults';
import { SimilarityOptions } from './SimilarityOptions';
import { HelperTooltip } from '../Methodology/HelperTooltip';
import { useDialogStore } from '../../stores/dialogStore';
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

  // Le cache du projet ouvert : à l'ouverture du panneau, et quand l'écran passe à un autre projet,
  // dont le registre a vidé les résultats (S18-1-25). Et pour le document ouvert : le main n'en rend
  // que les segments, et un autre chapitre ne montre plus ceux du précédent (S13-1-3). Le texte est
  // celui de l'éditeur vivant : à l'ouverture d'un document, la porte retire la façade de l'ancien,
  // et `getLiveContent` rend alors le nouveau. `getValue` plutôt que `getDocText` : les segments se
  // comptent en lignes, les mêmes dans les deux, et le main ramène les fins de ligne à `\n`.
  const projectPath = useProjectStore((s) => s.currentProject?.path ?? null);
  const filePath = useEditorStore((s) => s.filePath);
  const documentVersion = useEditorStore((s) => s.documentVersion);
  useEffect(() => {
    if (isPanelOpen) {
      void loadCachedResults(useEditorStore.getState().getLiveContent());
    }
  }, [isPanelOpen, loadCachedResults, projectPath, filePath, documentVersion]);

  // Don't render if panel is closed
  if (!isPanelOpen) {
    return null;
  }

  const handleAnalyze = async () => {
    logger.component('SimilarityPanel', 'Starting analysis');
    // L'éditeur vivant : le miroir `content` a jusqu'à 300 ms de retard sur la frappe.
    const text = useEditorStore.getState().getLiveContent();
    if (text.trim().length > 0) {
      analyze(text);
    } else {
      await useDialogStore.getState().showAlert(t('similarity.emptyDocument'));
    }
  };

  const handleClearResults = async () => {
    logger.component('SimilarityPanel', 'Clearing results');
    if (await useDialogStore.getState().showConfirm(t('similarity.clearConfirm'), undefined, { danger: true })) {
      clearResults();
    }
  };

  return (
    <div className="similarity-panel">
      {/* Header */}
      <div className="similarity-panel-header">
        <div className="similarity-panel-title-wrapper">
          <h3 className="similarity-panel-title">{t('similarity.title')}</h3>
          <HelperTooltip content={t('similarity.help.panel')} />
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
            <span className="similarity-error-icon"><AlertTriangle size={16} /></span>
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
                <div className="similarity-empty-icon"><Search size={48} strokeWidth={1} /></div>
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
