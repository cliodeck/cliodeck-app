import React from 'react';
import { useTranslation } from 'react-i18next';
import type { RAGConfig } from './ConfigPanel';

/**
 * Sous-section extraite de RAGConfigSection (#57, split sur le modèle de
 * CorpusExplorerPanel) : déplacement VERBATIM des handlers et du JSX —
 * aucun changement de comportement ni de DOM.
 */
interface Props {
  config: RAGConfig;
  onChange: (config: RAGConfig) => void;
}

export const RAGChunkQualitySettings: React.FC<Props> = ({ config, onChange }) => {
  // === Chunk Quality Optimization Handlers ===
  const { t } = useTranslation('common');

  const handleCustomChunkingEnabledChange = (value: boolean) => {
    onChange({ ...config, customChunkingEnabled: value });
  };

  const handleCustomMaxChunkSizeChange = (value: number) => {
    onChange({ ...config, customMaxChunkSize: value });
  };

  const handleCustomMinChunkSizeChange = (value: number) => {
    onChange({ ...config, customMinChunkSize: value });
  };

  const handleCustomOverlapSizeChange = (value: number) => {
    onChange({ ...config, customOverlapSize: value });
  };

  const handleEnableQualityFilteringChange = (value: boolean) => {
    onChange({ ...config, enableQualityFiltering: value });
  };

  const handleMinChunkEntropyChange = (value: number) => {
    onChange({ ...config, minChunkEntropy: value });
  };

  const handleMinUniqueWordRatioChange = (value: number) => {
    onChange({ ...config, minUniqueWordRatio: value });
  };

  const handleEnablePreprocessingChange = (value: boolean) => {
    onChange({ ...config, enablePreprocessing: value });
  };

  const handleEnableOCRCleanupChange = (value: boolean) => {
    onChange({ ...config, enableOCRCleanup: value });
  };

  const handleEnableHeaderFooterRemovalChange = (value: boolean) => {
    onChange({ ...config, enableHeaderFooterRemoval: value });
  };

  const handleEnableDeduplicationChange = (value: boolean) => {
    onChange({ ...config, enableDeduplication: value });
  };

  const handleEnableSimilarityDedupChange = (value: boolean) => {
    onChange({ ...config, enableSimilarityDedup: value });
  };

  const handleDedupSimilarityThresholdChange = (value: number) => {
    onChange({ ...config, dedupSimilarityThreshold: value });
  };

  const handleUseSemanticChunkingChange = (value: boolean) => {
    onChange({ ...config, useSemanticChunking: value });
  };

  const handleSemanticSimilarityThresholdChange = (value: number) => {
    onChange({ ...config, semanticSimilarityThreshold: value });
  };

  const handleSemanticWindowSizeChange = (value: number) => {
    onChange({ ...config, semanticWindowSize: value });
  };

  const handleEnableContextCompressionChange = (value: boolean) => {
    onChange({ ...config, enableContextCompression: value });
  };
  return (
    <>
          {/* === CHUNK QUALITY OPTIMIZATION === */}
          <div className="config-field" style={{ marginTop: '24px', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
            <h4 style={{ margin: '0 0 16px 0', color: 'var(--text-tertiary)' }}>🎯 {t('ragChunk.heading')}</h4>
          </div>

          {/* Custom Chunking */}
          <div className="config-field">
            <label className="config-label">
              {t('ragChunk.custom.label')}
              <span className="config-help">
                {t('ragChunk.custom.help')}
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="checkbox"
                checked={config.customChunkingEnabled ?? false}
                onChange={(e) => handleCustomChunkingEnabledChange(e.target.checked)}
                className="config-checkbox"
              />
              <span>{t(config.customChunkingEnabled ? 'ragChunk.on' : 'ragChunk.off')}</span>
            </div>
          </div>

          {config.customChunkingEnabled && (
            <>
              <div className="config-field">
                <label className="config-label">{t('ragChunk.custom.max')}</label>
                <div className="config-input-group">
                  <input
                    type="range"
                    min="100"
                    max="1500"
                    step="50"
                    value={config.customMaxChunkSize ?? 500}
                    onChange={(e) => handleCustomMaxChunkSizeChange(parseInt(e.target.value))}
                    className="config-slider"
                  />
                  <input
                    type="number"
                    min="100"
                    max="1500"
                    value={config.customMaxChunkSize ?? 500}
                    onChange={(e) => handleCustomMaxChunkSizeChange(parseInt(e.target.value))}
                    className="config-number"
                  />
                </div>
              </div>

              <div className="config-field">
                <label className="config-label">{t('ragChunk.custom.min')}</label>
                <div className="config-input-group">
                  <input
                    type="range"
                    min="20"
                    max="200"
                    step="10"
                    value={config.customMinChunkSize ?? 100}
                    onChange={(e) => handleCustomMinChunkSizeChange(parseInt(e.target.value))}
                    className="config-slider"
                  />
                  <input
                    type="number"
                    min="20"
                    max="200"
                    value={config.customMinChunkSize ?? 100}
                    onChange={(e) => handleCustomMinChunkSizeChange(parseInt(e.target.value))}
                    className="config-number"
                  />
                </div>
              </div>

              <div className="config-field">
                <label className="config-label">{t('ragChunk.custom.overlap')}</label>
                <div className="config-input-group">
                  <input
                    type="range"
                    min="0"
                    max="200"
                    step="10"
                    value={config.customOverlapSize ?? 75}
                    onChange={(e) => handleCustomOverlapSizeChange(parseInt(e.target.value))}
                    className="config-slider"
                  />
                  <input
                    type="number"
                    min="0"
                    max="200"
                    value={config.customOverlapSize ?? 75}
                    onChange={(e) => handleCustomOverlapSizeChange(parseInt(e.target.value))}
                    className="config-number"
                  />
                </div>
              </div>
            </>
          )}

          {/* Quality Filtering */}
          <div className="config-field">
            <label className="config-label">
              {t('ragChunk.quality.label')}
              <span className="config-help">
                {t('ragChunk.quality.help')}
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="checkbox"
                checked={config.enableQualityFiltering ?? true}
                onChange={(e) => handleEnableQualityFilteringChange(e.target.checked)}
                className="config-checkbox"
              />
              <span>{t(config.enableQualityFiltering !== false ? 'ragChunk.on' : 'ragChunk.off')}</span>
            </div>
          </div>

          {config.enableQualityFiltering !== false && (
            <>
              <div className="config-field">
                <label className="config-label">{t('ragChunk.quality.entropy')}</label>
                <div className="config-input-group">
                  <input
                    type="range"
                    min="0"
                    max="0.8"
                    step="0.05"
                    value={config.minChunkEntropy ?? 0.3}
                    onChange={(e) => handleMinChunkEntropyChange(parseFloat(e.target.value))}
                    className="config-slider"
                  />
                  <input
                    type="number"
                    min="0"
                    max="0.8"
                    step="0.05"
                    value={config.minChunkEntropy ?? 0.3}
                    onChange={(e) => handleMinChunkEntropyChange(parseFloat(e.target.value))}
                    className="config-number"
                  />
                </div>
                <div className="config-description">
                  <small>{t('ragChunk.quality.entropyHint')}</small>
                </div>
              </div>

              <div className="config-field">
                <label className="config-label">{t('ragChunk.quality.uniqueRatio')}</label>
                <div className="config-input-group">
                  <input
                    type="range"
                    min="0.2"
                    max="0.8"
                    step="0.05"
                    value={config.minUniqueWordRatio ?? 0.4}
                    onChange={(e) => handleMinUniqueWordRatioChange(parseFloat(e.target.value))}
                    className="config-slider"
                  />
                  <input
                    type="number"
                    min="0.2"
                    max="0.8"
                    step="0.05"
                    value={config.minUniqueWordRatio ?? 0.4}
                    onChange={(e) => handleMinUniqueWordRatioChange(parseFloat(e.target.value))}
                    className="config-number"
                  />
                </div>
              </div>
            </>
          )}

          {/* Preprocessing */}
          <div className="config-field">
            <label className="config-label">
              {t('ragChunk.preprocessing.label')}
              <span className="config-help">
                {t('ragChunk.preprocessing.help')}
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="checkbox"
                checked={config.enablePreprocessing ?? true}
                onChange={(e) => handleEnablePreprocessingChange(e.target.checked)}
                className="config-checkbox"
              />
              <span>{t(config.enablePreprocessing !== false ? 'ragChunk.on' : 'ragChunk.off')}</span>
            </div>
          </div>

          {config.enablePreprocessing !== false && (
            <>
              <div className="config-field">
                <label className="config-label">{t('ragChunk.preprocessing.ocr')}</label>
                <div className="config-input-group">
                  <input
                    type="checkbox"
                    checked={config.enableOCRCleanup ?? true}
                    onChange={(e) => handleEnableOCRCleanupChange(e.target.checked)}
                    className="config-checkbox"
                  />
                  <span>{t(config.enableOCRCleanup !== false ? 'ragChunk.yes' : 'ragChunk.no')}</span>
                </div>
              </div>

              <div className="config-field">
                <label className="config-label">{t('ragChunk.preprocessing.headerFooter')}</label>
                <div className="config-input-group">
                  <input
                    type="checkbox"
                    checked={config.enableHeaderFooterRemoval ?? true}
                    onChange={(e) => handleEnableHeaderFooterRemovalChange(e.target.checked)}
                    className="config-checkbox"
                  />
                  <span>{t(config.enableHeaderFooterRemoval !== false ? 'ragChunk.yes' : 'ragChunk.no')}</span>
                </div>
              </div>
            </>
          )}

          {/* Deduplication */}
          <div className="config-field">
            <label className="config-label">
              {t('ragChunk.dedup.label')}
              <span className="config-help">
                {t('ragChunk.dedup.help')}
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="checkbox"
                checked={config.enableDeduplication ?? true}
                onChange={(e) => handleEnableDeduplicationChange(e.target.checked)}
                className="config-checkbox"
              />
              <span>{t(config.enableDeduplication !== false ? 'ragChunk.on' : 'ragChunk.off')}</span>
            </div>
          </div>

          {config.enableDeduplication !== false && (
            <>
              <div className="config-field">
                <label className="config-label">{t('ragChunk.dedup.bySimilarity')}</label>
                <div className="config-input-group">
                  <input
                    type="checkbox"
                    checked={config.enableSimilarityDedup ?? false}
                    onChange={(e) => handleEnableSimilarityDedupChange(e.target.checked)}
                    className="config-checkbox"
                  />
                  <span>{t(config.enableSimilarityDedup ? 'ragChunk.dedup.yesSlower' : 'ragChunk.no')}</span>
                </div>
              </div>

              {config.enableSimilarityDedup && (
                <div className="config-field">
                  <label className="config-label">{t('ragChunk.dedup.threshold')}</label>
                  <div className="config-input-group">
                    <input
                      type="range"
                      min="0.7"
                      max="0.95"
                      step="0.05"
                      value={config.dedupSimilarityThreshold ?? 0.85}
                      onChange={(e) => handleDedupSimilarityThresholdChange(parseFloat(e.target.value))}
                      className="config-slider"
                    />
                    <input
                      type="number"
                      min="0.7"
                      max="0.95"
                      step="0.05"
                      value={config.dedupSimilarityThreshold ?? 0.85}
                      onChange={(e) => handleDedupSimilarityThresholdChange(parseFloat(e.target.value))}
                      className="config-number"
                    />
                  </div>
                </div>
              )}
            </>
          )}

          {/* Semantic Chunking */}
          <div className="config-field">
            <label className="config-label">
              {t('ragChunk.semantic.label')}
              <span className="config-help">
                {t('ragChunk.semantic.help')}
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="checkbox"
                checked={config.useSemanticChunking ?? false}
                onChange={(e) => handleUseSemanticChunkingChange(e.target.checked)}
                className="config-checkbox"
              />
              <span>{t(config.useSemanticChunking ? 'ragChunk.on' : 'ragChunk.off')}</span>
            </div>
            <div className="config-description">
              <div style={{
                padding: '8px 12px',
                backgroundColor: 'var(--color-accent-bg)',
                border: '1px solid var(--color-accent)',
                borderRadius: '4px',
                marginTop: '8px'
              }}>
                <strong>⚡ {t('ragChunk.semantic.infoTitle')}</strong>{' '}
                {t('ragChunk.semantic.info')}
              </div>
            </div>
          </div>

          {config.useSemanticChunking && (
            <>
              <div className="config-field">
                <label className="config-label">{t('ragChunk.semantic.sensitivity')}</label>
                <div className="config-input-group">
                  <input
                    type="range"
                    min="0.5"
                    max="0.9"
                    step="0.05"
                    value={config.semanticSimilarityThreshold ?? 0.7}
                    onChange={(e) => handleSemanticSimilarityThresholdChange(parseFloat(e.target.value))}
                    className="config-slider"
                  />
                  <input
                    type="number"
                    min="0.5"
                    max="0.9"
                    step="0.05"
                    value={config.semanticSimilarityThreshold ?? 0.7}
                    onChange={(e) => handleSemanticSimilarityThresholdChange(parseFloat(e.target.value))}
                    className="config-number"
                  />
                </div>
              </div>

              <div className="config-field">
                <label className="config-label">{t('ragChunk.semantic.window')}</label>
                <div className="config-input-group">
                  <input
                    type="range"
                    min="2"
                    max="5"
                    value={config.semanticWindowSize ?? 3}
                    onChange={(e) => handleSemanticWindowSizeChange(parseInt(e.target.value))}
                    className="config-slider"
                  />
                  <input
                    type="number"
                    min="2"
                    max="5"
                    value={config.semanticWindowSize ?? 3}
                    onChange={(e) => handleSemanticWindowSizeChange(parseInt(e.target.value))}
                    className="config-number"
                  />
                </div>
              </div>
            </>
          )}

          {/* Context Compression */}
          <div className="config-field">
            <label className="config-label">
              {t('ragChunk.compression.label')}
              <span className="config-help">
                {t('ragChunk.compression.help')}
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="checkbox"
                checked={config.enableContextCompression ?? true}
                onChange={(e) => handleEnableContextCompressionChange(e.target.checked)}
                className="config-checkbox"
              />
              <span>{t(config.enableContextCompression !== false ? 'ragChunk.on' : 'ragChunk.off')}</span>
            </div>
            <div className="config-description">
              <div style={{
                padding: '8px 12px',
                backgroundColor: 'var(--color-warning-bg)',
                border: '1px solid var(--color-warning)',
                borderRadius: '4px',
                marginTop: '8px'
              }}>
                <strong>⚠️ {t('ragChunk.compression.noteTitle')}</strong>{' '}
                {t('ragChunk.compression.note')}
              </div>
            </div>
          </div>
    </>
  );
};
