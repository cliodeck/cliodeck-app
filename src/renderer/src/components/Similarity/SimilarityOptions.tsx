/**
 * Similarity Options
 *
 * Modal for configuring similarity analysis options.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { useSimilarityStore, type Granularity, type SourceType } from '../../stores/similarityStore';
import { HelperTooltip } from '../Methodology/HelperTooltip';
import './SimilarityOptions.css';

interface SimilarityOptionsProps {
  onClose: () => void;
}

export const SimilarityOptions: React.FC<SimilarityOptionsProps> = ({ onClose }) => {
  const { t } = useTranslation('common');
  const { options, setOptions } = useSimilarityStore();

  const handleGranularityChange = (granularity: Granularity) => {
    setOptions({ granularity });
  };

  const handleSourceTypeChange = (sourceType: SourceType) => {
    setOptions({ sourceType });
  };

  const handleMaxResultsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value, 10);
    if (value >= 1 && value <= 20) {
      setOptions({ maxResults: value });
    }
  };

  const handleThresholdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(e.target.value);
    if (value >= 0 && value <= 1) {
      setOptions({ similarityThreshold: value });
    }
  };

  const handleRerankingChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setOptions({ useReranking: e.target.checked });
  };

  const handleContextualEmbeddingChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setOptions({ useContextualEmbedding: e.target.checked });
  };

  return (
    <div className="similarity-options-overlay" onClick={onClose}>
      <div className="similarity-options-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="similarity-options-header">
          <h3 className="similarity-options-title">{t('similarity.optionsTitle')}</h3>
          <button className="similarity-options-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="similarity-options-content">
          {/* Granularity */}
          <div className="similarity-option-group">
            <div className="similarity-option-label-wrapper">
              <label className="similarity-option-label">
                {t('similarity.granularity')}
              </label>
              <HelperTooltip content={t('similarity.help.granularity')} />
            </div>
            <p className="similarity-option-description">
              {t('similarity.granularityDescription')}
            </p>
            <div className="similarity-option-buttons">
              <button
                className={`similarity-option-btn ${options.granularity === 'section' ? 'active' : ''}`}
                onClick={() => handleGranularityChange('section')}
              >
                <span className="similarity-option-btn-icon">📑</span>
                <span className="similarity-option-btn-label">{t('similarity.granularity.section')}</span>
              </button>
              <button
                className={`similarity-option-btn ${options.granularity === 'paragraph' ? 'active' : ''}`}
                onClick={() => handleGranularityChange('paragraph')}
              >
                <span className="similarity-option-btn-icon">📝</span>
                <span className="similarity-option-btn-label">{t('similarity.granularity.paragraph')}</span>
              </button>
              <button
                className={`similarity-option-btn ${options.granularity === 'sentence' ? 'active' : ''}`}
                onClick={() => handleGranularityChange('sentence')}
              >
                <span className="similarity-option-btn-icon">💬</span>
                <span className="similarity-option-btn-label">{t('similarity.granularity.sentence')}</span>
              </button>
            </div>
          </div>

          {/* Source Type */}
          <div className="similarity-option-group">
            <div className="similarity-option-label-wrapper">
              <label className="similarity-option-label">
                {t('similarity.sourceType', 'Source Type')}
              </label>
              <HelperTooltip content={t('similarity.help.sourceType', 'Choose which sources to search: secondary sources (PDFs from bibliography) or primary sources (Tropy archives).')} />
            </div>
            <p className="similarity-option-description">
              {t('similarity.sourceTypeDescription', 'Select which type of sources to search')}
            </p>
            <div className="similarity-option-buttons">
              <button
                className={`similarity-option-btn ${options.sourceType === 'secondary' ? 'active' : ''}`}
                onClick={() => handleSourceTypeChange('secondary')}
              >
                <span className="similarity-option-btn-icon">📚</span>
                <span className="similarity-option-btn-label">{t('similarity.sourceType.secondary', 'Secondary')}</span>
              </button>
              <button
                className={`similarity-option-btn ${options.sourceType === 'primary' ? 'active' : ''}`}
                onClick={() => handleSourceTypeChange('primary')}
              >
                <span className="similarity-option-btn-icon">📜</span>
                <span className="similarity-option-btn-label">{t('similarity.sourceType.primary', 'Primary')}</span>
              </button>
              <button
                className={`similarity-option-btn ${options.sourceType === 'both' ? 'active' : ''}`}
                onClick={() => handleSourceTypeChange('both')}
              >
                <span className="similarity-option-btn-icon">🔄</span>
                <span className="similarity-option-btn-label">{t('similarity.sourceType.both', 'Both')}</span>
              </button>
            </div>
          </div>

          {/* Max Results */}
          <div className="similarity-option-group">
            <div className="similarity-option-label-wrapper">
              <label className="similarity-option-label">
                {t('similarity.maxResults')}
              </label>
              <HelperTooltip content={t('similarity.help.maxResults')} />
            </div>
            <p className="similarity-option-description">
              {t('similarity.maxResultsDescription')}
            </p>
            <div className="similarity-option-slider">
              <input
                type="range"
                min="1"
                max="10"
                value={options.maxResults}
                onChange={handleMaxResultsChange}
                className="similarity-slider"
              />
              <span className="similarity-slider-value">{options.maxResults}</span>
            </div>
          </div>

          {/* Similarity Threshold */}
          <div className="similarity-option-group">
            <div className="similarity-option-label-wrapper">
              <label className="similarity-option-label">
                {t('similarity.threshold')}
              </label>
              <HelperTooltip content={t('similarity.help.threshold')} />
            </div>
            <p className="similarity-option-description">
              {t('similarity.thresholdDescription')}
            </p>
            <div className="similarity-option-slider">
              <input
                type="range"
                min="0"
                max="0.1"
                step="0.005"
                value={options.similarityThreshold}
                onChange={handleThresholdChange}
                className="similarity-slider"
              />
              <span className="similarity-slider-value">
                {options.similarityThreshold === 0 ? t('similarity.noFilter') : `${(options.similarityThreshold * 100).toFixed(1)}%`}
              </span>
            </div>
          </div>

          {/* LLM Reranking */}
          <div className="similarity-option-group">
            <div className="similarity-option-label-wrapper">
              <label className="similarity-option-label">
                {t('similarity.reranking')}
              </label>
              <HelperTooltip content={t('similarity.help.reranking')} />
            </div>
            <p className="similarity-option-description">
              {t('similarity.rerankingDescription')}
            </p>
            <div className="similarity-option-toggle">
              <input
                type="checkbox"
                id="reranking-toggle"
                checked={options.useReranking}
                onChange={handleRerankingChange}
                className="similarity-checkbox"
              />
              <label htmlFor="reranking-toggle" className="similarity-toggle-label">
                {options.useReranking ? t('similarity.rerankingEnabled') : t('similarity.rerankingDisabled')}
              </label>
            </div>
          </div>

          {/* Contextual Embedding */}
          <div className="similarity-option-group">
            <div className="similarity-option-label-wrapper">
              <label className="similarity-option-label">
                {t('similarity.contextualEmbedding')}
              </label>
              <HelperTooltip content={t('similarity.help.contextualEmbedding')} />
            </div>
            <p className="similarity-option-description">
              {t('similarity.contextualEmbeddingDescription')}
            </p>
            <div className="similarity-option-toggle">
              <input
                type="checkbox"
                id="contextual-toggle"
                checked={options.useContextualEmbedding}
                onChange={handleContextualEmbeddingChange}
                className="similarity-checkbox"
              />
              <label htmlFor="contextual-toggle" className="similarity-toggle-label">
                {options.useContextualEmbedding ? t('similarity.contextualEnabled') : t('similarity.contextualDisabled')}
              </label>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="similarity-options-footer">
          <button className="similarity-options-done" onClick={onClose}>
            {t('common.done')}
          </button>
        </div>
      </div>
    </div>
  );
};
