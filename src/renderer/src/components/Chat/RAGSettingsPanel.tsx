import React, { useState, useEffect, useRef, useMemo } from 'react';
import { ChevronDown, ChevronUp, ChevronRight, RotateCcw, Settings, RefreshCw, AlertTriangle, BookOpen, Scroll, Lightbulb } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useRAGQueryStore, type LLMProvider } from '../../stores/ragQueryStore';
import { CollectionMultiSelect } from './CollectionMultiSelect';
import { DocumentMultiSelect } from './DocumentMultiSelect';
import './RAGSettingsPanel.css';

// Model context sizes (mirrors backend/core/llm/OllamaClient.ts)
const MODEL_CONTEXT_SIZES: Record<string, { maxContext: number; recommended: number }> = {
  'gemma2:2b': { maxContext: 8192, recommended: 4096 },
  'gemma2:9b': { maxContext: 8192, recommended: 8192 },
  'gemma:2b': { maxContext: 8192, recommended: 4096 },
  'gemma:7b': { maxContext: 8192, recommended: 8192 },
  'llama3.2:1b': { maxContext: 131072, recommended: 32768 },
  'llama3.2:3b': { maxContext: 131072, recommended: 32768 },
  'llama3.1:8b': { maxContext: 131072, recommended: 32768 },
  'llama3:8b': { maxContext: 8192, recommended: 8192 },
  'mistral:7b': { maxContext: 32768, recommended: 16384 },
  'mistral:7b-instruct': { maxContext: 32768, recommended: 16384 },
  'mistral:7b-instruct-q4_0': { maxContext: 32768, recommended: 16384 },
  'ministral:3b': { maxContext: 131072, recommended: 32768 },
  'ministral:8b': { maxContext: 131072, recommended: 32768 },
  'phi3:mini': { maxContext: 131072, recommended: 16384 },
  'phi3:medium': { maxContext: 131072, recommended: 16384 },
  'phi4:mini': { maxContext: 131072, recommended: 32768 },
  'qwen2.5:3b': { maxContext: 32768, recommended: 16384 },
  'qwen2.5:7b': { maxContext: 131072, recommended: 32768 },
  'smollm2:1.7b': { maxContext: 8192, recommended: 4096 },
  'deepseek-r1:1.5b': { maxContext: 65536, recommended: 16384 },
  'deepseek-r1:7b': { maxContext: 65536, recommended: 32768 },
  'deepseek-r1:8b': { maxContext: 65536, recommended: 32768 },
};

function getModelContextInfo(modelName: string): { maxContext: number; recommended: number } {
  if (MODEL_CONTEXT_SIZES[modelName]) {
    return MODEL_CONTEXT_SIZES[modelName];
  }
  // Try base name match
  const baseName = modelName.split('-')[0];
  if (MODEL_CONTEXT_SIZES[baseName]) {
    return MODEL_CONTEXT_SIZES[baseName];
  }
  // Try family match
  const family = modelName.split(':')[0];
  const familyMatch = Object.entries(MODEL_CONTEXT_SIZES).find(([key]) => key.startsWith(family + ':'));
  if (familyMatch) {
    return familyMatch[1];
  }
  return { maxContext: 4096, recommended: 2048 };
}

function formatContextSize(tokens: number): string {
  if (tokens >= 1024) {
    return `${Math.round(tokens / 1024)}K`;
  }
  return tokens.toString();
}

export const RAGSettingsPanel: React.FC = () => {
  const { t } = useTranslation('common');
  const {
    params,
    availableModels,
    isLoadingModels,
    availableCollections,
    isLoadingCollections,
    availableDocuments,
    isLoadingDocuments,
    isSettingsPanelOpen,
    setParams,
    resetToDefaults,
    toggleSettingsPanel,
    loadAvailableModels,
    loadAvailableCollections,
    setSelectedCollections,
    loadAvailableDocuments,
    setSelectedDocuments,
  } = useRAGQueryStore();

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isEmbeddedModelAvailable, setIsEmbeddedModelAvailable] = useState(false);
  const hasTriedLoading = useRef(false);

  // Get context info for selected model
  const modelContextInfo = useMemo(() => {
    return getModelContextInfo(params.model);
  }, [params.model]);

  // Check if embedded model is downloaded
  useEffect(() => {
    const checkEmbeddedModel = async () => {
      try {
        const result = await window.electron.embeddedLLM.isDownloaded();
        if (result?.success) {
          setIsEmbeddedModelAvailable(result.downloaded);
        }
      } catch (error) {
        console.warn('Could not check embedded model status:', error);
      }
    };
    checkEmbeddedModel();
  }, []);

  // Auto-retry loading models when panel becomes visible
  useEffect(() => {
    if (isSettingsPanelOpen && availableModels.length === 0 && !isLoadingModels && !hasTriedLoading.current) {
      hasTriedLoading.current = true;
      console.log('🔄 Auto-loading models because panel is open and no models available...');
      loadAvailableModels();
    }
  }, [isSettingsPanelOpen, availableModels.length, isLoadingModels]);

  // Reload models when panel opens (always try if no models loaded)
  const handleTogglePanel = () => {
    toggleSettingsPanel();

    // Try loading models when opening the panel if none are available
    if (!isSettingsPanelOpen && availableModels.length === 0) {
      // Small delay to ensure panel animation has started
      setTimeout(() => {
        loadAvailableModels();
      }, 100);
    }
  };

  const handleResetDefaults = async () => {
    await resetToDefaults();
  };

  const handleRefreshModels = () => {
    hasTriedLoading.current = false; // Reset flag to allow retry
    loadAvailableModels();
  };

  const handleRefreshCollections = () => {
    loadAvailableCollections();
  };

  const handleRefreshDocuments = () => {
    loadAvailableDocuments();
  };

  // Load collections when panel opens (if not already loaded)
  useEffect(() => {
    if (isSettingsPanelOpen && availableCollections.length === 0 && !isLoadingCollections) {
      loadAvailableCollections();
    }
  }, [isSettingsPanelOpen]);

  // Issue #16: Load documents when panel opens (if not already loaded)
  useEffect(() => {
    if (isSettingsPanelOpen && availableDocuments.length === 0 && !isLoadingDocuments) {
      loadAvailableDocuments();
    }
  }, [isSettingsPanelOpen]);

  return (
    <div className="rag-settings-panel">
      <button className="settings-toggle" onClick={handleTogglePanel}>
        <Settings size={14} />
        <span>RAG Settings</span>
        {isSettingsPanelOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>

      {isSettingsPanelOpen && (
        <div className="settings-content">
          {/* Provider Selection */}
          <div className="setting-group">
            <label htmlFor="provider-select">{t('ragSettings.provider')}</label>
            <select
              id="provider-select"
              value={params.provider}
              onChange={(e) => setParams({ provider: e.target.value as LLMProvider })}
            >
              <option value="auto">{t('ragSettings.providerAuto')}</option>
              <option value="ollama">{t('ragSettings.providerOllama')}</option>
              <option value="embedded" disabled={!isEmbeddedModelAvailable}>
                {t('ragSettings.providerEmbedded')}
                {!isEmbeddedModelAvailable && ` (${t('ragSettings.notDownloaded')})`}
              </option>
            </select>
            <small className="setting-hint">
              {params.provider === 'auto' && t('ragSettings.providerAutoDesc')}
              {params.provider === 'ollama' && t('ragSettings.providerOllamaDesc')}
              {params.provider === 'embedded' && t('ragSettings.providerEmbeddedDesc')}
            </small>
          </div>

          {/* Model Selection (only for Ollama) */}
          {(params.provider === 'ollama' || params.provider === 'auto') && (
          <div className="setting-group">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label htmlFor="model-select">
                Model
                {isLoadingModels && <span className="loading-indicator"> (loading...)</span>}
              </label>
              <button
                onClick={handleRefreshModels}
                disabled={isLoadingModels}
                title="Refresh models"
                style={{
                  padding: '4px 6px',
                  fontSize: '11px',
                  background: 'var(--surface-variant)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '3px',
                  cursor: isLoadingModels ? 'not-allowed' : 'pointer',
                  opacity: isLoadingModels ? 0.5 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  color: 'var(--text-secondary)',
                }}
              >
                <RefreshCw size={12} />
              </button>
            </div>
            <select
              id="model-select"
              value={params.model}
              onChange={(e) => setParams({ model: e.target.value })}
              disabled={isLoadingModels}
            >
              {availableModels.length === 0 && !isLoadingModels ? (
                <option value={params.model}>{params.model} (current)</option>
              ) : (
                availableModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name} ({model.size})
                  </option>
                ))
              )}
            </select>
            <small className="setting-hint">
              {availableModels.length === 0 && !isLoadingModels
                ? <><AlertTriangle size={12} /> No models loaded. Load a project first, then click <RefreshCw size={10} style={{ verticalAlign: 'middle' }} />.</>
                : `${availableModels.length} models available. Larger models are slower but better.`}
            </small>
          </div>
          )}

          {/* Source Type Selection */}
          <div className="setting-group">
            <label htmlFor="source-type-select">{t('ragSettings.sourceType', 'Source Type')}</label>
            <div className="source-type-selector">
              <button
                className={`source-type-btn secondary ${params.sourceType === 'secondary' ? 'active' : ''}`}
                onClick={() => setParams({ sourceType: 'secondary' })}
                title={t('ragSettings.secondaryDesc', 'Bibliography (PDFs from Zotero)')}
              >
                <span className="source-icon"><BookOpen size={16} /></span>
                <span>{t('ragSettings.secondary', 'Bibliography')}</span>
              </button>
              <button
                className={`source-type-btn primary ${params.sourceType === 'primary' ? 'active' : ''}`}
                onClick={() => setParams({ sourceType: 'primary' })}
                title={t('ragSettings.primaryDesc', 'Primary Sources (Tropy archives)')}
              >
                <span className="source-icon"><Scroll size={16} /></span>
                <span>{t('ragSettings.primary', 'Archives')}</span>
              </button>
              <button
                className={`source-type-btn both ${params.sourceType === 'both' ? 'active' : ''}`}
                onClick={() => setParams({ sourceType: 'both' })}
                title={t('ragSettings.bothDesc', 'Search in both sources')}
              >
                <span className="source-icon"><BookOpen size={14} /><Scroll size={14} /></span>
                <span>{t('ragSettings.both', 'Both')}</span>
              </button>
            </div>
            <small className="setting-hint">
              {params.sourceType === 'secondary' && t('ragSettings.secondaryHint', 'Search only in bibliography (PDFs)')}
              {params.sourceType === 'primary' && t('ragSettings.primaryHint', 'Search only in primary sources (Tropy)')}
              {params.sourceType === 'both' && t('ragSettings.bothHint', 'Search in all sources')}
            </small>
          </div>

          {/* Collection Filter (only for secondary sources) */}
          {(params.sourceType === 'secondary' || params.sourceType === 'both') && (
          <div className="setting-group">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label htmlFor="collection-filter">
                Filter by Collection
                {isLoadingCollections && <span className="loading-indicator"> (loading...)</span>}
              </label>
              <button
                onClick={handleRefreshCollections}
                disabled={isLoadingCollections}
                title="Refresh collections"
                style={{
                  padding: '4px 6px',
                  fontSize: '11px',
                  background: 'var(--surface-variant)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '3px',
                  cursor: isLoadingCollections ? 'not-allowed' : 'pointer',
                  opacity: isLoadingCollections ? 0.5 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  color: 'var(--text-secondary)',
                }}
              >
                <RefreshCw size={12} />
              </button>
            </div>
            <CollectionMultiSelect
              collections={availableCollections}
              selectedKeys={params.selectedCollectionKeys}
              onChange={setSelectedCollections}
              placeholder="All collections (no filter)"
              disabled={isLoadingCollections}
            />
            <small className="setting-hint">
              {params.selectedCollectionKeys.length === 0
                ? 'Search will include all documents'
                : `Search limited to ${params.selectedCollectionKeys.length} collection(s)`}
            </small>
          </div>
          )}

          {/* Issue #16: Document Filter (only for secondary sources) */}
          {(params.sourceType === 'secondary' || params.sourceType === 'both') && (
          <div className="setting-group">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label htmlFor="document-filter">
                Filter by Document
                {isLoadingDocuments && <span className="loading-indicator"> (loading...)</span>}
              </label>
              <button
                onClick={handleRefreshDocuments}
                disabled={isLoadingDocuments}
                title="Refresh documents"
                style={{
                  padding: '4px 6px',
                  fontSize: '11px',
                  background: 'var(--surface-variant)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '3px',
                  cursor: isLoadingDocuments ? 'not-allowed' : 'pointer',
                  opacity: isLoadingDocuments ? 0.5 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  color: 'var(--text-secondary)',
                }}
              >
                <RefreshCw size={12} />
              </button>
            </div>
            <DocumentMultiSelect
              documents={availableDocuments}
              selectedIds={params.selectedDocumentIds}
              onChange={setSelectedDocuments}
              placeholder="All documents (no filter)"
              disabled={isLoadingDocuments}
            />
            <small className="setting-hint">
              {params.selectedDocumentIds.length === 0
                ? 'Search will include all indexed documents'
                : `Search limited to ${params.selectedDocumentIds.length} document(s)`}
            </small>
          </div>
          )}

          {/* Top K */}
          <div className="setting-group">
            <label htmlFor="topk-slider">
              Sources (Top-K): <strong>{params.topK}</strong>
            </label>
            <input
              id="topk-slider"
              type="range"
              min="5"
              max="30"
              step="1"
              value={params.topK}
              onChange={(e) => setParams({ topK: parseInt(e.target.value) })}
            />
            <small className="setting-hint">Number of document chunks to retrieve</small>
          </div>

          {/* Timeout */}
          <div className="setting-group">
            <label htmlFor="timeout-slider">
              Timeout: <strong>{Math.floor(params.timeout / 60000)} min</strong>
            </label>
            <input
              id="timeout-slider"
              type="range"
              min="60000"
              max="900000"
              step="60000"
              value={params.timeout}
              onChange={(e) => setParams({ timeout: parseInt(e.target.value) })}
            />
            <small className="setting-hint">Maximum wait time for response</small>
          </div>

          {/* Advanced Settings Toggle */}
          <button
            className="advanced-toggle"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            {showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>Advanced Parameters</span>
          </button>

          {showAdvanced && (
            <div className="advanced-settings">
              {/* Context Window Size */}
              <div className="setting-group">
                <label htmlFor="context-slider">
                  Context Window: <strong>{formatContextSize(params.numCtx)}</strong> tokens
                </label>
                <input
                  id="context-slider"
                  type="range"
                  min="2048"
                  max={modelContextInfo.maxContext}
                  step="1024"
                  value={params.numCtx}
                  onChange={(e) => setParams({ numCtx: parseInt(e.target.value) })}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--text-muted)' }}>
                  <span>2K</span>
                  <span>Max: {formatContextSize(modelContextInfo.maxContext)}</span>
                </div>
                <small className="setting-hint">
                  <Lightbulb size={12} /> Recommended for {params.model}: <strong>{formatContextSize(modelContextInfo.recommended)}</strong>
                  <button
                    onClick={() => setParams({ numCtx: modelContextInfo.recommended })}
                    style={{
                      marginLeft: '8px',
                      padding: '2px 6px',
                      fontSize: '10px',
                      background: 'var(--surface-variant)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '3px',
                      cursor: 'pointer',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    Use recommended
                  </button>
                </small>
              </div>

              {/* System Prompt Language */}
              <div className="setting-group">
                <label htmlFor="system-prompt-lang">System Prompt Language</label>
                <select
                  id="system-prompt-lang"
                  value={params.systemPromptLanguage}
                  onChange={(e) => setParams({ systemPromptLanguage: e.target.value as 'fr' | 'en' })}
                >
                  <option value="fr">🇫🇷 French (Français)</option>
                  <option value="en">🇬🇧 English</option>
                </select>
                <small className="setting-hint">
                  Language for the default system prompt (instructs the AI how to respond)
                </small>
              </div>

              {/* Custom System Prompt Toggle */}
              <div className="setting-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={params.useCustomSystemPrompt}
                    onChange={(e) => setParams({ useCustomSystemPrompt: e.target.checked })}
                  />
                  <span>Use Custom System Prompt</span>
                </label>
                <small className="setting-hint">
                  Override the default system prompt with a custom one
                </small>
              </div>

              {/* Custom System Prompt Textarea */}
              {params.useCustomSystemPrompt && (
                <div className="setting-group">
                  <label htmlFor="custom-prompt">Custom System Prompt</label>
                  <textarea
                    id="custom-prompt"
                    rows={6}
                    value={params.customSystemPrompt || ''}
                    onChange={(e) => setParams({ customSystemPrompt: e.target.value })}
                    placeholder="Enter your custom system prompt here..."
                    style={{
                      width: '100%',
                      padding: '8px',
                      fontSize: '12px',
                      fontFamily: 'monospace',
                      resize: 'vertical',
                      borderRadius: '4px',
                      border: '1px solid var(--border-color)',
                      background: 'var(--surface-variant)',
                      color: 'var(--text-color)',
                    }}
                  />
                  <small className="setting-hint">
                    This prompt instructs the AI how to respond to your queries
                  </small>
                </div>
              )}

              {/* Temperature */}
              <div className="setting-group">
                <label htmlFor="temperature-slider">
                  Temperature: <strong>{params.temperature.toFixed(2)}</strong>
                </label>
                <input
                  id="temperature-slider"
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={params.temperature}
                  onChange={(e) => setParams({ temperature: parseFloat(e.target.value) })}
                />
                <small className="setting-hint">
                  Lower = more focused, higher = more creative
                </small>
              </div>

              {/* Top P */}
              <div className="setting-group">
                <label htmlFor="topp-slider">
                  Top-P: <strong>{params.top_p.toFixed(2)}</strong>
                </label>
                <input
                  id="topp-slider"
                  type="range"
                  min="0.1"
                  max="1"
                  step="0.05"
                  value={params.top_p}
                  onChange={(e) => setParams({ top_p: parseFloat(e.target.value) })}
                />
                <small className="setting-hint">Nucleus sampling threshold</small>
              </div>

              {/* Top K (LLM parameter, different from search topK) */}
              <div className="setting-group">
                <label htmlFor="llm-topk-slider">
                  Top-K (LLM): <strong>{params.top_k}</strong>
                </label>
                <input
                  id="llm-topk-slider"
                  type="range"
                  min="1"
                  max="100"
                  step="1"
                  value={params.top_k}
                  onChange={(e) => setParams({ top_k: parseInt(e.target.value) })}
                />
                <small className="setting-hint">Number of tokens to consider</small>
              </div>

              {/* Repeat Penalty */}
              <div className="setting-group">
                <label htmlFor="repeat-penalty-slider">
                  Repeat Penalty: <strong>{params.repeat_penalty.toFixed(2)}</strong>
                </label>
                <input
                  id="repeat-penalty-slider"
                  type="range"
                  min="1"
                  max="2"
                  step="0.05"
                  value={params.repeat_penalty}
                  onChange={(e) =>
                    setParams({ repeat_penalty: parseFloat(e.target.value) })
                  }
                />
                <small className="setting-hint">Penalize repetitive text</small>
              </div>
            </div>
          )}

          {/* Reset Button */}
          <button className="reset-button" onClick={handleResetDefaults}>
            <RotateCcw size={14} />
            <span>Reset to Config Defaults</span>
          </button>
        </div>
      )}
    </div>
  );
};
