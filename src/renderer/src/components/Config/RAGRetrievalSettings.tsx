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

export const RAGRetrievalSettings: React.FC<Props> = ({ config, onChange }) => {
  const { t } = useTranslation('common');

  const handleTopKChange = (value: number) => {
    onChange({ ...config, topK: value });
  };

  const handleThresholdChange = (value: number) => {
    onChange({ ...config, similarityThreshold: value });
  };

  const handleChunkingChange = (value: 'cpuOptimized' | 'standard' | 'large') => {
    onChange({ ...config, chunkingConfig: value });
  };

  const handleSummaryGenerationChange = (value: 'extractive' | 'abstractive' | 'disabled') => {
    onChange({ ...config, summaryGeneration: value });
  };

  const handleSummaryMaxLengthChange = (value: number) => {
    onChange({ ...config, summaryMaxLength: value });
  };

  const handleUseGraphContextChange = (value: boolean) => {
    onChange({ ...config, useGraphContext: value });
  };

  const handleGraphSimilarityThresholdChange = (value: number) => {
    onChange({ ...config, graphSimilarityThreshold: value });
  };

  const handleAdditionalGraphDocsChange = (value: number) => {
    onChange({ ...config, additionalGraphDocs: value });
  };

  const handleIncludeSummariesChange = (value: boolean) => {
    onChange({ ...config, includeSummaries: value });
  };

  const handleIncludeObsidianVaultChange = (value: boolean) => {
    onChange({ ...config, includeObsidianVault: value });
  };

  const handleEnableTopicModelingChange = (value: boolean) => {
    onChange({ ...config, enableTopicModeling: value });
  };

  const handleExplorationSimilarityThresholdChange = (value: number) => {
    onChange({ ...config, explorationSimilarityThreshold: value });
  };

  return (
    <>
          {/* Top K */}
          <div className="config-field">
            <label className="config-label">
              {t('ragRetrieval.topK.label')}
              <span className="config-help">
                {t('ragRetrieval.topK.help')}
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="range"
                min="1"
                max="20"
                value={config.topK}
                onChange={(e) => handleTopKChange(parseInt(e.target.value))}
                className="config-slider"
              />
              <input
                type="number"
                min="1"
                max="20"
                value={config.topK}
                onChange={(e) => handleTopKChange(parseInt(e.target.value))}
                className="config-number"
              />
            </div>
            <div className="config-description">
              {t('ragRetrieval.topK.current', { count: config.topK })}
              <br />
              <small>
                {t('ragRetrieval.topK.hintLow')}
                <br />
                {t('ragRetrieval.topK.hintMid')}
                <br />
                {t('ragRetrieval.topK.hintHigh')}
              </small>
            </div>
          </div>

          {/* Similarity Threshold */}
          <div className="config-field">
            <label className="config-label">
              {t('ragRetrieval.threshold.label')}
              <span className="config-help">
                {t('ragRetrieval.threshold.help')}
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={config.similarityThreshold}
                onChange={(e) => handleThresholdChange(parseFloat(e.target.value))}
                className="config-slider"
              />
              <input
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={config.similarityThreshold}
                onChange={(e) => handleThresholdChange(parseFloat(e.target.value))}
                className="config-number"
              />
            </div>
            <div className="config-description">
              {t('ragRetrieval.currentValue', { value: config.similarityThreshold.toFixed(2) })}
              <br />
              <small>
                {t('ragRetrieval.threshold.hintLow')}
                <br />
                {t('ragRetrieval.threshold.hintMid')}
                <br />
                {t('ragRetrieval.threshold.hintHigh')}
              </small>
            </div>
          </div>

          {/* Chunking Configuration */}
          <div className="config-field">
            <label className="config-label">
              {t('ragRetrieval.chunking.label')}
              <span className="config-help">
                {t('ragRetrieval.chunking.help')}
              </span>
            </label>
            <select
              value={config.chunkingConfig}
              onChange={(e) => handleChunkingChange(e.target.value as 'cpuOptimized' | 'standard' | 'large')}
              className="config-select"
            >
              <option value="cpuOptimized">{t('ragRetrieval.chunking.cpuOptimized')}</option>
              <option value="standard">{t('ragRetrieval.chunking.standard')}</option>
              <option value="large">{t('ragRetrieval.chunking.large')}</option>
            </select>
            <div className="config-description">
              <div style={{
                padding: '8px 12px',
                backgroundColor: 'var(--color-warning-bg)',
                border: '1px solid var(--color-warning)',
                borderRadius: '4px',
                marginTop: '8px'
              }}>
                <strong>⚠️ {t('ragRetrieval.chunking.warningTitle')}</strong>{' '}
                {t('ragRetrieval.chunking.warning')}
                <br />
                <small>
                  {t('ragRetrieval.chunking.warningDetail')}
                </small>
              </div>
            </div>
          </div>

          {/* Summary Generation */}
          <div className="config-field">
            <label className="config-label">
              {t('ragRetrieval.summary.label')}
              <span className="config-help">
                {t('ragRetrieval.summary.help')}
              </span>
            </label>
            <select
              value={config.summaryGeneration}
              onChange={(e) => handleSummaryGenerationChange(e.target.value as 'extractive' | 'abstractive' | 'disabled')}
              className="config-select"
            >
              <option value="disabled">{t('ragRetrieval.summary.disabled')}</option>
              <option value="extractive">{t('ragRetrieval.summary.extractive')}</option>
              <option value="abstractive">{t('ragRetrieval.summary.abstractive')}</option>
            </select>
            <div className="config-description">
              <small>
                {t('ragRetrieval.summary.hintExtractive')}
                <br />
                {t('ragRetrieval.summary.hintAbstractive')}
              </small>
            </div>
          </div>

          {/* Summary Max Length - Only shown if summary generation is enabled */}
          {config.summaryGeneration !== 'disabled' && (
            <div className="config-field">
              <label className="config-label">
                {t('ragRetrieval.summaryLength.label')}
                <span className="config-help">
                  {t('ragRetrieval.summaryLength.help')}
                </span>
              </label>
              <div className="config-input-group">
                <input
                  type="range"
                  min="100"
                  max="1000"
                  step="50"
                  value={config.summaryMaxLength}
                  onChange={(e) => handleSummaryMaxLengthChange(parseInt(e.target.value))}
                  className="config-slider"
                />
                <input
                  type="number"
                  min="100"
                  max="1000"
                  step="50"
                  value={config.summaryMaxLength}
                  onChange={(e) => handleSummaryMaxLengthChange(parseInt(e.target.value))}
                  className="config-number"
                />
              </div>
              <div className="config-description">
                {t('ragRetrieval.summaryLength.current', { count: config.summaryMaxLength })}
              </div>
            </div>
          )}

          {/* Use Graph Context */}
          <div className="config-field">
            <label className="config-label">
              {t('ragRetrieval.graph.label')}
              <span className="config-help">
                {t('ragRetrieval.graph.help')}
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="checkbox"
                checked={config.useGraphContext}
                onChange={(e) => handleUseGraphContextChange(e.target.checked)}
                className="config-checkbox"
              />
              <span>{t(config.useGraphContext ? 'ragRetrieval.on' : 'ragRetrieval.off')}</span>
            </div>
            <div className="config-description">
              <small>
                {t('ragRetrieval.graph.hint')}
              </small>
            </div>
          </div>

          {/* Additional Graph Docs - Only shown if graph context is enabled */}
          {config.useGraphContext && (
            <>
              <div className="config-field">
                <label className="config-label">
                  {t('ragRetrieval.graphDocs.label')}
                  <span className="config-help">
                    {t('ragRetrieval.graphDocs.help')}
                  </span>
                </label>
                <div className="config-input-group">
                  <input
                    type="range"
                    min="1"
                    max="10"
                    value={config.additionalGraphDocs}
                    onChange={(e) => handleAdditionalGraphDocsChange(parseInt(e.target.value))}
                    className="config-slider"
                  />
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={config.additionalGraphDocs}
                    onChange={(e) => handleAdditionalGraphDocsChange(parseInt(e.target.value))}
                    className="config-number"
                  />
                </div>
                <div className="config-description">
                  {t('ragRetrieval.graphDocs.current', { count: config.additionalGraphDocs })}
                </div>
              </div>

              <div className="config-field">
                <label className="config-label">
                  {t('ragRetrieval.graphThreshold.label')}
                  <span className="config-help">
                    {t('ragRetrieval.graphThreshold.help')}
                  </span>
                </label>
                <div className="config-input-group">
                  <input
                    type="range"
                    min="0.5"
                    max="1"
                    step="0.05"
                    value={config.graphSimilarityThreshold}
                    onChange={(e) => handleGraphSimilarityThresholdChange(parseFloat(e.target.value))}
                    className="config-slider"
                  />
                  <input
                    type="number"
                    min="0.5"
                    max="1"
                    step="0.05"
                    value={config.graphSimilarityThreshold}
                    onChange={(e) => handleGraphSimilarityThresholdChange(parseFloat(e.target.value))}
                    className="config-number"
                  />
                </div>
                <div className="config-description">
                  {t('ragRetrieval.currentValue', { value: config.graphSimilarityThreshold.toFixed(2) })}
                </div>
              </div>
            </>
          )}

          {/* Include Summaries in RAG */}
          <div className="config-field">
            <label className="config-label">
              {t('ragRetrieval.useSummaries.label')}
              <span className="config-help">
                {t('ragRetrieval.useSummaries.help')}
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="checkbox"
                checked={config.includeSummaries}
                onChange={(e) => handleIncludeSummariesChange(e.target.checked)}
                className="config-checkbox"
              />
              <span>{t(config.includeSummaries ? 'ragRetrieval.on' : 'ragRetrieval.off')}</span>
            </div>
            <div className="config-description">
              <small>
                {t('ragRetrieval.useSummaries.hint')}
                <br />
                ⚠️ {t('ragRetrieval.useSummaries.requires')}
              </small>
            </div>
          </div>

          {/* Include Obsidian vault in RAG */}
          <div className="config-field">
            <label className="config-label">
              {t('ragRetrieval.vault.label')}
              <span className="config-help">
                {t('ragRetrieval.vault.help')}
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="checkbox"
                checked={config.includeObsidianVault === true}
                onChange={(e) => handleIncludeObsidianVaultChange(e.target.checked)}
                className="config-checkbox"
              />
              <span>{t(config.includeObsidianVault ? 'ragRetrieval.on' : 'ragRetrieval.off')}</span>
            </div>
            <div className="config-description">
              <small>
                {t('ragRetrieval.vault.hint')}
              </small>
            </div>
          </div>

          {/* Exploration Similarity Threshold */}
          <div className="config-field">
            <label className="config-label">
              {t('ragRetrieval.exploration.label')}
              <span className="config-help">
                {t('ragRetrieval.exploration.help')}
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="range"
                min="0.5"
                max="0.95"
                step="0.05"
                value={config.explorationSimilarityThreshold}
                onChange={(e) => handleExplorationSimilarityThresholdChange(parseFloat(e.target.value))}
                className="config-slider"
              />
              <input
                type="number"
                min="0.5"
                max="0.95"
                step="0.05"
                value={config.explorationSimilarityThreshold}
                onChange={(e) => handleExplorationSimilarityThresholdChange(parseFloat(e.target.value))}
                className="config-number"
              />
            </div>
            <div className="config-description">
              {t('ragRetrieval.currentValue', { value: config.explorationSimilarityThreshold.toFixed(2) })}
              <br />
              <small>
                {t('ragRetrieval.exploration.hintLow')}
                <br />
                {t('ragRetrieval.exploration.hintMid')}
                <br />
                {t('ragRetrieval.exploration.hintHigh')}
              </small>
            </div>
          </div>

          {/* Topic Modeling */}
          <div className="config-field">
            <label className="config-label">
              {t('ragRetrieval.topics.label')}
              <span className="config-help">
                {t('ragRetrieval.topics.help')}
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="checkbox"
                checked={config.enableTopicModeling}
                onChange={(e) => handleEnableTopicModelingChange(e.target.checked)}
                className="config-checkbox"
              />
              <span>{t(config.enableTopicModeling ? 'ragRetrieval.on' : 'ragRetrieval.off')}</span>
            </div>
            <div className="config-description">
              <small>
                {t('ragRetrieval.topics.hint')}
              </small>
            </div>
          </div>

    </>
  );
};
