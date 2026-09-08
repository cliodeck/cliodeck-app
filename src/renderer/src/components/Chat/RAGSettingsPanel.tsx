import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ChevronDown, ChevronUp, ChevronRight, RotateCcw, Settings, RefreshCw, AlertTriangle, BookOpen, Scroll, Lightbulb, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useRAGQueryStore, type LLMProvider } from '../../stores/ragQueryStore';
import { CollectionMultiSelect } from './CollectionMultiSelect';
import { DocumentMultiSelect } from './DocumentMultiSelect';
import {
  NUM_CTX_MAX,
  NUM_CTX_MIN,
  getContextWindow,
} from '../../../../../backend/core/llm/context-windows';
import { formatContextSize, normalizeNumCtxInput } from '../../utils/context-size';
import './RAGSettingsPanel.css';

/**
 * Ce que l'on sait de la fenêtre de contexte du modèle sélectionné.
 * `ollama` : longueur d'entraînement lue sur `/api/show` — la seule source
 * fiable. `table` : estimation par famille (`context-windows.ts`), quand
 * Ollama ne répond pas. L'ancienne table codée en dur dans ce fichier
 * renvoyait 4 096 jetons pour tout modèle qui n'y figurait pas
 * (qwen3.5:35b compris), et le curseur interdisait d'aller au-delà.
 */
interface ModelContextInfo {
  declared?: number;
  modelfileNumCtx?: number;
  source: 'ollama' | 'table' | 'none';
}

const CONTEXT_PRESETS = [8_192, 32_768, 131_072] as const;
/** Délai avant d'écrire dans la configuration une valeur tapée ou glissée. */
const PERSIST_DEBOUNCE_MS = 500;

type LLMSettingsPatch = {
  ollamaChatModel?: string;
  ollamaNumCtx?: number;
  generationProvider?: LLMProvider;
};

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

  // Fenêtre de contexte du modèle sélectionné, lue sur Ollama.
  const [modelInfo, setModelInfo] = useState<ModelContextInfo>({ source: 'none' });
  // Saisie libre de la fenêtre : brouillon local, validé au blur / Entrée.
  const [numCtxDraft, setNumCtxDraft] = useState<string>(String(params.numCtx));
  useEffect(() => {
    setNumCtxDraft(String(params.numCtx));
  }, [params.numCtx]);

  /**
   * Le panneau et les réglages de l'application écrivent le MÊME champ
   * (`llm.ollamaChatModel`, `llm.ollamaNumCtx`) : un choix fait ici survit
   * au redémarrage et apparaît dans les réglages, et inversement. Sans
   * cette écriture, le store du renderer était réinitialisé depuis la
   * configuration à chaque lancement — les réglages « dominaient ».
   * L'écriture est différée : `config:set('llm')` réinitialise les services
   * côté main, on ne le déclenche pas à chaque frappe ni à chaque pixel du
   * curseur.
   */
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPatch = useRef<LLMSettingsPatch>({});
  const flushPersist = useCallback(() => {
    if (persistTimer.current) {
      clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    const patch = pendingPatch.current;
    pendingPatch.current = {};
    if (Object.keys(patch).length === 0) return;
    try {
      Promise.resolve(window.electron.config.set('llm', patch)).catch(
        (error: unknown) => {
          console.error('Could not persist chat LLM settings', error);
        }
      );
    } catch (error) {
      console.error('Could not persist chat LLM settings', error);
    }
  }, []);
  const persistLLM = useCallback(
    (patch: LLMSettingsPatch, delayMs = 0) => {
      pendingPatch.current = { ...pendingPatch.current, ...patch };
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(flushPersist, delayMs);
    },
    [flushPersist]
  );
  // Un réglage en attente part quand le panneau est démonté.
  useEffect(() => flushPersist, [flushPersist]);

  const applyNumCtx = useCallback(
    (value: number, delayMs = 0) => {
      setParams({ numCtx: value });
      persistLLM({ ollamaNumCtx: value }, delayMs);
    },
    [setParams, persistLLM]
  );

  const commitNumCtxDraft = () => {
    const n = normalizeNumCtxInput(numCtxDraft);
    if (n === null) {
      setNumCtxDraft(String(params.numCtx));
      return;
    }
    applyNumCtx(n);
  };

  const handleModelChange = (model: string) => {
    setParams({ model });
    persistLLM({ ollamaChatModel: model });
  };

  // Longueur de contexte déclarée par le modèle (`/api/show`). Repli sur la
  // table par famille si Ollama ne répond pas — signalé comme estimation.
  useEffect(() => {
    if (!isSettingsPanelOpen) return;
    const model = params.model?.trim();
    if (!model || params.provider === 'embedded') {
      setModelInfo({ source: 'none' });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await window.electron.ollama.showModel(model);
        if (cancelled) return;
        if (res?.success && res.info?.contextLength) {
          setModelInfo({
            declared: res.info.contextLength,
            modelfileNumCtx: res.info.modelfileNumCtx,
            source: 'ollama',
          });
          return;
        }
      } catch (error) {
        console.warn('Could not read model info from Ollama:', error);
      }
      if (!cancelled) {
        setModelInfo({ declared: getContextWindow(model), source: 'table' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.model, params.provider, isSettingsPanelOpen]);

  const declaredContext = modelInfo.declared;
  // Le curseur couvre au moins 32K, la longueur déclarée, et la valeur
  // courante (qui peut venir d'une saisie libre plus haute).
  const sliderMax = Math.max(32_768, declaredContext ?? 0, params.numCtx);

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

  /**
   * Le choix du moteur doit atteindre la configuration, pas seulement le
   * store : c'est `llm.generationProvider` que lit
   * `cliodeck-config-adapter` pour assembler le provider. Tant que cette
   * écriture manquait, sélectionner « embarqué » ici n'avait aucun effet
   * côté main — le symptôme rapporté par l'utilisateur.
   *
   * Il passe par la même file d'écriture partielle que le modèle et la
   * fenêtre : l'ancienne relecture-réécriture de toute la section `llm`
   * pouvait, dans la fenêtre de 500 ms de l'écriture différée, écraser une
   * valeur tout juste saisie (revue de la PR #84). `setLLMConfig` fusionne
   * les champs fournis avec la section existante.
   */
  const handleProviderChange = (provider: LLMProvider) => {
    setParams({ provider });
    persistLLM({ generationProvider: provider });
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
        <span>{t('ragPanel.title')}</span>
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
              onChange={(e) => handleProviderChange(e.target.value as LLMProvider)}
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
                title={t('ragPanel.refreshModels')}
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
              onChange={(e) => handleModelChange(e.target.value)}
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
                ? <><AlertTriangle size={12} /> {t('ragPanel.noModels')} <RefreshCw size={10} style={{ verticalAlign: 'middle' }} />.</>
                : `${availableModels.length} models available. Larger models are slower but better.`}
            </small>
          </div>
          )}

          {/* Source Family Toggles — three independent checkboxes covering
              the three families of ClioDeck sources. Any combination is
              valid; selecting none surfaces a warning but still projects a
              permissive fallback so the turn doesn't silently die. */}
          <div className="setting-group">
            <label>{t('ragSettings.sources', 'Sources')}</label>
            <div className="source-toggle-list" role="group" aria-label={t('ragPanel.sources')}>
              <label className="source-toggle-item">
                <input
                  type="checkbox"
                  checked={params.includeBibliography}
                  onChange={(e) => setParams({ includeBibliography: e.target.checked })}
                  aria-label={t('ragSettings.includeBibliography', 'Bibliography')}
                />
                <BookOpen size={14} />
                <span>{t('ragSettings.includeBibliography', 'Bibliography')}</span>
              </label>
              <label className="source-toggle-item">
                <input
                  type="checkbox"
                  checked={params.includePrimary}
                  onChange={(e) => setParams({ includePrimary: e.target.checked })}
                  aria-label={t('ragSettings.includePrimary', 'Primary sources')}
                />
                <Scroll size={14} />
                <span>{t('ragSettings.includePrimary', 'Primary sources')}</span>
              </label>
              <label className="source-toggle-item">
                <input
                  type="checkbox"
                  checked={params.includeNotes}
                  onChange={(e) => setParams({ includeNotes: e.target.checked })}
                  aria-label={t('ragSettings.includeNotes', 'Notes')}
                />
                <FileText size={14} />
                <span>{t('ragSettings.includeNotes', 'Notes')}</span>
              </label>
            </div>
            <small className="setting-hint">
              {(() => {
                const parts: string[] = [];
                if (params.includeBibliography) parts.push(t('ragSettings.includeBibliography', 'Bibliography'));
                if (params.includePrimary) parts.push(t('ragSettings.includePrimary', 'Primary sources'));
                if (params.includeNotes) parts.push(t('ragSettings.includeNotes', 'Notes'));
                if (parts.length === 0) {
                  return (
                    <span style={{ color: 'var(--color-danger)' }}>
                      <AlertTriangle size={12} /> {t('ragSettings.noSourceWarning', 'Select at least one source.')}
                    </span>
                  );
                }
                return t('ragSettings.searchIn', 'Searching in: {{list}}', { list: parts.join(', ') });
              })()}
            </small>
          </div>

          {/* Collection Filter (only when bibliography is enabled) */}
          {params.includeBibliography && (
          <div className="setting-group">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label htmlFor="collection-filter">
                Filter by Collection
                {isLoadingCollections && <span className="loading-indicator"> (loading...)</span>}
              </label>
              <button
                onClick={handleRefreshCollections}
                disabled={isLoadingCollections}
                title={t('ragPanel.refreshCollections')}
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
              placeholder={t('ragPanel.allCollections')}
              disabled={isLoadingCollections}
            />
            <small className="setting-hint">
              {params.selectedCollectionKeys.length === 0
                ? 'Search will include all documents'
                : `Search limited to ${params.selectedCollectionKeys.length} collection(s)`}
            </small>
          </div>
          )}

          {/* Issue #16: Document Filter (only when bibliography is enabled) */}
          {params.includeBibliography && (
          <div className="setting-group">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label htmlFor="document-filter">
                Filter by Document
                {isLoadingDocuments && <span className="loading-indicator"> (loading...)</span>}
              </label>
              <button
                onClick={handleRefreshDocuments}
                disabled={isLoadingDocuments}
                title={t('ragPanel.refreshDocuments')}
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
              placeholder={t('ragPanel.allDocuments')}
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
            <small className="setting-hint">{t('ragPanel.topKHelp')}</small>
          </div>

          {/* Délai d'inactivité — consommé par fusion-chat-service (watchdog) */}
          <div className="setting-group">
            <label htmlFor="timeout-slider">
              {t('ragPanel.timeout')}: <strong>{Math.floor(params.timeout / 60000)} min</strong>
            </label>
            <input
              id="timeout-slider"
              type="range"
              min="60000"
              max="3600000"
              step="60000"
              value={params.timeout}
              onChange={(e) => setParams({ timeout: parseInt(e.target.value) })}
            />
            <small className="setting-hint">{t('ragPanel.timeoutHelp')}</small>
          </div>

          {/* Advanced Settings Toggle */}
          <button
            className="advanced-toggle"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            {showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>{t('ragPanel.advanced')}</span>
          </button>

          {showAdvanced && (
            <div className="advanced-settings">
              {/* Fenêtre de contexte (num_ctx) */}
              <div className="setting-group">
                <label htmlFor="context-input">
                  {t('ragPanel.contextWindow')}: <strong>{formatContextSize(params.numCtx)}</strong> {t('ragPanel.tokens')}
                </label>
                <div className="context-window-row">
                  <input
                    id="context-slider"
                    type="range"
                    min={2048}
                    max={sliderMax}
                    step={1024}
                    value={Math.min(params.numCtx, sliderMax)}
                    onChange={(e) => applyNumCtx(parseInt(e.target.value, 10), PERSIST_DEBOUNCE_MS)}
                    aria-label={t('ragPanel.contextWindow')}
                  />
                  <input
                    id="context-input"
                    className="context-window-input"
                    type="number"
                    min={NUM_CTX_MIN}
                    max={NUM_CTX_MAX}
                    step={1024}
                    value={numCtxDraft}
                    onChange={(e) => setNumCtxDraft(e.target.value)}
                    onBlur={commitNumCtxDraft}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitNumCtxDraft();
                      }
                    }}
                    aria-label={t('ragPanel.contextWindowInput')}
                  />
                </div>
                <div className="context-presets" role="group" aria-label={t('ragPanel.contextPresets')}>
                  {CONTEXT_PRESETS.map((v) => (
                    <button
                      key={v}
                      type="button"
                      className={`preset-chip${params.numCtx === v ? ' is-active' : ''}`}
                      onClick={() => applyNumCtx(v)}
                    >
                      {formatContextSize(v)}
                    </button>
                  ))}
                  {declaredContext !== undefined && (
                    <button
                      type="button"
                      className={`preset-chip${params.numCtx === declaredContext ? ' is-active' : ''}`}
                      onClick={() => applyNumCtx(declaredContext)}
                      title={t('ragPanel.contextUseModelMaxHelp')}
                    >
                      {t('ragPanel.contextUseModelMax', { size: formatContextSize(declaredContext) })}
                    </button>
                  )}
                </div>
                <small className="setting-hint">
                  <Lightbulb size={12} />{' '}
                  {modelInfo.source === 'ollama' && declaredContext !== undefined
                    ? t('ragPanel.contextDeclared', { model: params.model, size: formatContextSize(declaredContext) })
                    : modelInfo.source === 'table' && declaredContext !== undefined
                      ? t('ragPanel.contextEstimated', { model: params.model, size: formatContextSize(declaredContext) })
                      : t('ragPanel.contextUnknown')}
                  {modelInfo.modelfileNumCtx !== undefined &&
                    ` ${t('ragPanel.contextModelfile', { size: formatContextSize(modelInfo.modelfileNumCtx) })}`}
                </small>
                {declaredContext !== undefined && params.numCtx > declaredContext && (
                  <small className="setting-hint context-warning" role="status">
                    <AlertTriangle size={12} />{' '}
                    {t('ragPanel.contextAboveDeclared', { size: formatContextSize(declaredContext) })}
                  </small>
                )}
                <small className="setting-hint">{t('ragPanel.contextMemoryHint')}</small>
              </div>

              {/* System Prompt Language */}
              <div className="setting-group">
                <label htmlFor="system-prompt-lang">{t('ragPanel.promptLanguage')}</label>
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
                  <span>{t('ragPanel.customPrompt')}</span>
                </label>
                <small className="setting-hint">
                  {t('ragPanel.customPromptHelp')}
                </small>
              </div>

              {/* Custom System Prompt Textarea */}
              {params.useCustomSystemPrompt && (
                <div className="setting-group">
                  <label htmlFor="custom-prompt">{t('ragPanel.customPromptLabel')}</label>
                  <textarea
                    id="custom-prompt"
                    rows={6}
                    value={params.customSystemPrompt || ''}
                    onChange={(e) => setParams({ customSystemPrompt: e.target.value })}
                    placeholder={t('ragPanel.customPromptPlaceholder')}
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
                    {t('ragPanel.customPromptHint')}
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
                  {t('ragPanel.temperatureHelp')}
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
                <small className="setting-hint">{t('ragPanel.topPHelp')}</small>
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
                <small className="setting-hint">{t('ragPanel.topKTokensHelp')}</small>
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
                <small className="setting-hint">{t('ragPanel.repeatPenaltyHelp')}</small>
              </div>
            </div>
          )}

          {/* Reset Button */}
          <button className="reset-button" onClick={handleResetDefaults}>
            <RotateCcw size={14} />
            <span>{t('ragPanel.reset')}</span>
          </button>
        </div>
      )}
    </div>
  );
};
