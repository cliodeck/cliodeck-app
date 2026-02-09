import { CollapsibleSection } from '../common/CollapsibleSection';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { LLMConfig } from './ConfigPanel';

interface LLMConfigSectionProps {
  config: LLMConfig;
  onChange: (config: LLMConfig) => void;
  availableModels: string[];
  onRefreshModels: () => void;
}

export const LLMConfigSection: React.FC<LLMConfigSectionProps> = ({
  config,
  onChange,
  availableModels,
  onRefreshModels,
}) => {
  const { t } = useTranslation('common');

  const handleFieldChange = (field: keyof LLMConfig, value: any) => {
    onChange({ ...config, [field]: value });
  };

  return (
    <CollapsibleSection title={t('llm.title')} defaultExpanded={false}>
      <div className="config-section">
        <div className="config-section-content">
          {/* Ollama URL */}
          <div className="config-field">
            <label className="config-label">
              {t('llm.ollamaURL')}
              <span className="config-help">
                {t('llm.ollamaURLHelp')}
              </span>
            </label>
            <input
              type="text"
              value={config.ollamaURL}
              onChange={(e) => handleFieldChange('ollamaURL', e.target.value)}
              className="config-input"
              placeholder="http://127.0.0.1:11434"
            />
          </div>

          {/* Chat Model */}
          <div className="config-field">
            <label className="config-label">
              {t('llm.chatModel')}
              <span className="config-help">
                {t('llm.chatModelHelp')}
              </span>
            </label>
            <div className="config-input-group">
              {availableModels.length > 0 ? (
                <select
                  value={config.ollamaChatModel}
                  onChange={(e) => handleFieldChange('ollamaChatModel', e.target.value)}
                  className="config-input"
                >
                  {!availableModels.includes(config.ollamaChatModel) && config.ollamaChatModel && (
                    <option value={config.ollamaChatModel}>{config.ollamaChatModel}</option>
                  )}
                  {availableModels.map((model) => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={config.ollamaChatModel}
                  onChange={(e) => handleFieldChange('ollamaChatModel', e.target.value)}
                  className="config-input"
                  placeholder="gemma2:2b"
                />
              )}
              <button
                className="config-btn-small"
                onClick={onRefreshModels}
                title={t('llm.refreshModels')}
              >
                🔄
              </button>
            </div>
            <div className="config-description">
              <small>
                {availableModels.length > 0
                  ? `${availableModels.length} ${t('llm.modelsAvailable')}`
                  : t('llm.noModelsLoaded')}
                <br />
                • gemma2:2b (rapide, CPU)
                <br />
                • phi3:mini (équilibré)
                <br />
                • mistral:7b-instruct (qualité, français)
              </small>
            </div>
          </div>

          {/* Embedding Model */}
          <div className="config-field">
            <label className="config-label">
              {t('llm.embeddingModel')}
              <span className="config-help">
                {t('llm.embeddingModelHelp')}
              </span>
            </label>
            <input
              type="text"
              value={config.ollamaEmbeddingModel}
              onChange={(e) => handleFieldChange('ollamaEmbeddingModel', e.target.value)}
              className="config-input"
              placeholder="nomic-embed-text"
            />
            <div className="config-description">
              <div style={{
                padding: '8px 12px',
                backgroundColor: '#fff3cd',
                border: '1px solid #ffc107',
                borderRadius: '4px',
                marginTop: '8px'
              }}>
                <strong>{t('llm.embeddingStrategyWarning')}</strong>
                <br />
                <small>
                  {t('llm.embeddingStrategyWarningDetails')}
                </small>
              </div>
              <small style={{ display: 'block', marginTop: '8px' }}>
                <strong>{t('llm.embeddingStrategyRecommended')}</strong>
                <br />
                • <code>nomic-embed-text</code> - 768 dim, multilingue, recommandé
                <br />
                • <code>mxbai-embed-large</code> - 1024 dim, très performant
                <br />
                • <code>all-minilm</code> - 384 dim, léger et rapide
              </small>
            </div>
          </div>

          {/* Embedding Strategy */}
          <div className="config-field">
            <label className="config-label">
              {t('llm.embeddingStrategy')}
              <span className="config-help">
                {t('llm.embeddingStrategyHelp')}
              </span>
            </label>
            <select
              value={config.embeddingStrategy || 'nomic-fallback'}
              onChange={(e) => handleFieldChange('embeddingStrategy', e.target.value as 'nomic-fallback' | 'mxbai-only' | 'custom')}
              className="config-input"
            >
              <option value="nomic-fallback">
                {t('llm.embeddingStrategyOptions.nomicFallback')}
              </option>
              <option value="mxbai-only">
                {t('llm.embeddingStrategyOptions.mxbaiOnly')}
              </option>
              <option value="custom">
                {t('llm.embeddingStrategyOptions.custom')}
              </option>
            </select>
            <div className="config-description">
              <small>
                <strong>{t('llm.embeddingStrategyRecommended')}</strong>
                <br />
                • <strong>nomic-fallback</strong> : {t('llm.embeddingStrategyDescriptions.nomicFallback')}
                <br />
                • <strong>mxbai-only</strong> : {t('llm.embeddingStrategyDescriptions.mxbaiOnly')}
                <br />
                • <strong>custom</strong> : {t('llm.embeddingStrategyDescriptions.custom')}
              </small>
            </div>
          </div>
        </div>
      </div>
    </CollapsibleSection>
  );
};
