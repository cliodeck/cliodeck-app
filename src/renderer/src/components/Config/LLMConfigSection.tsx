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
              Backend de génération
              <span className="config-help">
                Choisis le fournisseur LLM utilisé pour la génération.
                Les embeddings restent toujours via Ollama (rapide, local).
              </span>
            </label>
            <select
              value={backend}
              onChange={(e) => handleFieldChange('backend', e.target.value)}
              className="config-input"
            >
              <option value="ollama">Ollama (local)</option>
              <option value="claude">Anthropic Claude (API cloud)</option>
              <option value="openai">OpenAI (API cloud)</option>
              <option value="mistral">Mistral (API cloud)</option>
              <option value="gemini">Google Gemini (API cloud)</option>
            </select>
          </div>

          {backend === 'claude' && (
            <>
              <div className="config-field">
                <label className="config-label">
                  Clé API Anthropic
                  <span className="config-help">
                    Stockée chiffrée via le keyring système (jamais en clair sur disque).
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
                <label className="config-label">Modèle Claude</label>
                <input
                  type="text"
                  value={config.claudeModel ?? ''}
                  onChange={(e) => handleFieldChange('claudeModel', e.target.value)}
                  className="config-input"
                  placeholder="claude-sonnet-4-6"
                />
                <div className="config-description">
                  <small>
                    Recommandés : <code>claude-opus-4-6</code>,{' '}
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
                  Clé API OpenAI
                  <span className="config-help">
                    Stockée chiffrée via le keyring système (jamais en clair sur disque).
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
                <label className="config-label">Modèle OpenAI</label>
                <input
                  type="text"
                  value={config.openaiModel ?? ''}
                  onChange={(e) => handleFieldChange('openaiModel', e.target.value)}
                  className="config-input"
                  placeholder="gpt-4o-mini"
                />
                <div className="config-description">
                  <small>
                    Exemples : <code>gpt-4o</code>, <code>gpt-4o-mini</code>,{' '}
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
                  Clé API Mistral
                  <span className="config-help">
                    Stockée chiffrée via le keyring système (jamais en clair sur disque).
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
                <label className="config-label">Modèle Mistral</label>
                <input
                  type="text"
                  value={config.mistralModel ?? ''}
                  onChange={(e) => handleFieldChange('mistralModel', e.target.value)}
                  className="config-input"
                  placeholder="mistral-large-latest"
                />
                <div className="config-description">
                  <small>
                    Exemples : <code>mistral-large-latest</code>,{' '}
                    <code>mistral-small-latest</code>, <code>open-mistral-nemo</code>.
                    Particulièrement bon en français.
                  </small>
                </div>
              </div>
            </>
          )}

          {backend === 'gemini' && (
            <>
              <div className="config-field">
                <label className="config-label">
                  Clé API Google AI Studio
                  <span className="config-help">
                    Stockée chiffrée via le keyring système. À créer sur{' '}
                    <code>aistudio.google.com</code>.
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
                <label className="config-label">Modèle Gemini</label>
                <input
                  type="text"
                  value={config.geminiModel ?? ''}
                  onChange={(e) => handleFieldChange('geminiModel', e.target.value)}
                  className="config-input"
                  placeholder="gemini-2.0-flash"
                />
                <div className="config-description">
                  <small>
                    Exemples : <code>gemini-2.0-flash</code>,{' '}
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
                Utiliser ce fournisseur pour les embeddings aussi
                <span className="config-help">
                  Par défaut les embeddings passent par Ollama. Cochez si
                  vous n'avez pas d'Ollama local. Changer cette option
                  invalide l'index vectoriel (dimensions différentes) —
                  il faudra réindexer vos PDFs.
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
                    : 'Ollama (local)'}
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
