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

  const handleFieldChange = (field: keyof LLMConfig, value: LLMConfig[keyof LLMConfig]) => {
    onChange({ ...config, [field]: value });
  };

  const backend = config.backend ?? 'ollama';

  return (
    <CollapsibleSection title={t('llm.title')} defaultExpanded={false}>
      <div className="config-section">
        <div className="config-section-content">
          {/* Backend selector */}
          <div className="config-field">
            <label className="config-label">
              {t('llm.backend.label')}
              <span className="config-help">
                {t('llm.backend.help')}
              </span>
            </label>
            <select
              value={backend}
              onChange={(e) => handleFieldChange('backend', e.target.value)}
              className="config-input"
            >
              <option value="ollama">{t('llm.backend.ollama')}</option>
              <option value="claude">{t('llm.backend.claude')}</option>
              <option value="openai">{t('llm.backend.openai')}</option>
              <option value="mistral">{t('llm.backend.mistral')}</option>
              <option value="gemini">{t('llm.backend.gemini')}</option>
            </select>
          </div>

          {backend === 'claude' && (
            <>
              <div className="config-field">
                <label className="config-label">
                  {t('llm.apiKey.anthropic')}
                  <span className="config-help">
                    {t('llm.apiKey.help')}
                  </span>
                </label>
                <input
                  type="password"
                  value={config.claudeAPIKey ?? ''}
                  onChange={(e) => handleFieldChange('claudeAPIKey', e.target.value)}
                  className="config-input"
                  placeholder="sk-ant-…"
                  autoComplete="off"
                />
              </div>
              <div className="config-field">
                <label className="config-label">{t('llm.model.claude')}</label>
                <input
                  type="text"
                  value={config.claudeModel ?? ''}
                  onChange={(e) => handleFieldChange('claudeModel', e.target.value)}
                  className="config-input"
                  placeholder="claude-sonnet-4-6"
                />
                <div className="config-description">
                  <small>
                    {t('llm.model.recommended')} <code>claude-opus-4-6</code>,{' '}
                    <code>claude-sonnet-4-6</code>, <code>claude-haiku-4-5-20251001</code>
                  </small>
                </div>
              </div>
            </>
          )}

          {backend === 'openai' && (
            <>
              <div className="config-field">
                <label className="config-label">
                  {t('llm.apiKey.openai')}
                  <span className="config-help">
                    {t('llm.apiKey.help')}
                  </span>
                </label>
                <input
                  type="password"
                  value={config.openaiAPIKey ?? ''}
                  onChange={(e) => handleFieldChange('openaiAPIKey', e.target.value)}
                  className="config-input"
                  placeholder="sk-…"
                  autoComplete="off"
                />
              </div>
              <div className="config-field">
                <label className="config-label">{t('llm.model.openai')}</label>
                <input
                  type="text"
                  value={config.openaiModel ?? ''}
                  onChange={(e) => handleFieldChange('openaiModel', e.target.value)}
                  className="config-input"
                  placeholder="gpt-4o-mini"
                />
                <div className="config-description">
                  <small>
                    {t('llm.model.examples')} <code>gpt-4o</code>, <code>gpt-4o-mini</code>,{' '}
                    <code>gpt-4-turbo</code>, <code>o1-mini</code>
                  </small>
                </div>
              </div>
            </>
          )}

          {backend === 'mistral' && (
            <>
              <div className="config-field">
                <label className="config-label">
                  {t('llm.apiKey.mistral')}
                  <span className="config-help">
                    {t('llm.apiKey.help')}
                  </span>
                </label>
                <input
                  type="password"
                  value={config.mistralAPIKey ?? ''}
                  onChange={(e) => handleFieldChange('mistralAPIKey', e.target.value)}
                  className="config-input"
                  placeholder="…"
                  autoComplete="off"
                />
              </div>
              <div className="config-field">
                <label className="config-label">{t('llm.model.mistral')}</label>
                <input
                  type="text"
                  value={config.mistralModel ?? ''}
                  onChange={(e) => handleFieldChange('mistralModel', e.target.value)}
                  className="config-input"
                  placeholder="mistral-large-latest"
                />
                <div className="config-description">
                  <small>
                    {t('llm.model.examples')} <code>mistral-large-latest</code>,{' '}
                    <code>mistral-small-latest</code>, <code>open-mistral-nemo</code>.{' '}
                    {t('llm.model.mistralNote')}
                  </small>
                </div>
              </div>
            </>
          )}

          {backend === 'gemini' && (
            <>
              <div className="config-field">
                <label className="config-label">
                  {t('llm.apiKey.google')}
                  <span className="config-help">
                    {t('llm.apiKey.helpGoogle')} <code>aistudio.google.com</code>.
                  </span>
                </label>
                <input
                  type="password"
                  value={config.geminiAPIKey ?? ''}
                  onChange={(e) => handleFieldChange('geminiAPIKey', e.target.value)}
                  className="config-input"
                  placeholder="AIza…"
                  autoComplete="off"
                />
              </div>
              <div className="config-field">
                <label className="config-label">{t('llm.model.gemini')}</label>
                <input
                  type="text"
                  value={config.geminiModel ?? ''}
                  onChange={(e) => handleFieldChange('geminiModel', e.target.value)}
                  className="config-input"
                  placeholder="gemini-2.0-flash"
                />
                <div className="config-description">
                  <small>
                    {t('llm.model.examples')} <code>gemini-2.0-flash</code>,{' '}
                    <code>gemini-2.0-flash-lite</code>,{' '}
                    <code>gemini-1.5-pro</code>, <code>gemini-1.5-flash</code>.
                  </small>
                </div>
              </div>
            </>
          )}

          {backend !== 'ollama' && backend !== 'claude' && (
            <div className="config-field">
              <label className="config-label">
                {t('llm.cloudEmbeddings.label')}
                <span className="config-help">
                  {t('llm.cloudEmbeddings.help')}
                </span>
              </label>
              <div className="config-input-group">
                <input
                  type="checkbox"
                  checked={config.useCloudEmbeddings === true}
                  onChange={(e) => handleFieldChange('useCloudEmbeddings', e.target.checked)}
                  className="config-checkbox"
                />
                <span>
                  {config.useCloudEmbeddings
                    ? backend === 'gemini'
                      ? 'text-embedding-004 (768 dim)'
                      : backend === 'openai'
                        ? 'text-embedding-3-small (1536 dim)'
                        : 'mistral-embed (1024 dim)'
                    : t('llm.backend.ollama')}
                </span>
              </div>
            </div>
          )}

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
                {t('llm.chatModelHints.fast')}
                <br />
                {t('llm.chatModelHints.balanced')}
                <br />
                {t('llm.chatModelHints.quality')}
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
                backgroundColor: 'var(--color-warning-bg)',
                border: '1px solid var(--color-warning)',
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
                • <code>nomic-embed-text</code> — {t('llm.embeddingHints.nomic')}
                <br />
                • <code>mxbai-embed-large</code> — {t('llm.embeddingHints.mxbai')}
                <br />
                • <code>all-minilm</code> — {t('llm.embeddingHints.minilm')}
              </small>
            </div>
          </div>

          {/* Embedding context window (num_ctx) */}
          <div className="config-field">
            <label className="config-label">
              {t('llm.embeddingNumCtx')}
              <span className="config-help">
                {t('llm.embeddingNumCtxHelp')}
              </span>
            </label>
            <input
              type="number"
              min={512}
              step={512}
              value={config.ollamaEmbeddingNumCtx ?? ''}
              onChange={(e) =>
                handleFieldChange(
                  'ollamaEmbeddingNumCtx',
                  e.target.value === '' ? undefined : Number(e.target.value)
                )
              }
              className="config-input"
              placeholder={t('llm.embeddingNumCtxPlaceholder')}
            />
            <div className="config-description">
              <small>
                {t('llm.embeddingNumCtxDetails')}
              </small>
            </div>
          </div>

          {/* Le sélecteur « Embedding strategy » a été retiré (#17) : il
              écrivait un champ (embeddingStrategy) que plus aucun service
              ne lisait — la sélection réelle du provider d'embeddings passe
              par embeddingProvider (cliodeck-config-adapter). */}
        </div>
      </div>
    </CollapsibleSection>
  );
};
