import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Check, RotateCcw, Save } from 'lucide-react';
import { RAGConfigSection } from './RAGConfigSection';
import { LLMConfigSection } from './LLMConfigSection';
import { EmbeddedLLMSection } from './EmbeddedLLMSection';
import { EmbeddedEmbeddingSection } from './EmbeddedEmbeddingSection';
import { EditorConfigSection, type EditorConfig } from './EditorConfigSection';
import { UIConfigSection } from './UIConfigSection';
import { LanguageConfigSection } from './LanguageConfigSection';
import { TopicModelingSection } from './TopicModelingSection';
import { ModeManagerSection } from './ModeManagerSection';
import { ZoteroConfigSection, type ZoteroConfig } from './ZoteroConfigSection';
import { WorkspaceHintsSection } from './WorkspaceHintsSection';
import { RecipesSection } from './RecipesSection';
import { VaultConfigSection } from './VaultConfigSection';
import { MCPClientsSection } from './MCPClientsSection';
import { MCPServerSection } from './MCPServerSection';
import { ArchivesConfigSection } from './ArchivesConfigSection';
import { SecurityConfigSection } from './SecurityConfigSection';
import { ManuscriptCorpusSection } from './ManuscriptCorpusSection';
import { ReadingNotesCorpusSection } from './ReadingNotesCorpusSection';
import { CitationStyleSection } from './CitationStyleSection';
import { useEditorStore } from '../../stores/editorStore';
import { useDialogStore } from '../../stores/dialogStore';
import { useRAGQueryStore, type LLMProvider } from '../../stores/ragQueryStore';
import { isCloudProvider } from '../../stores/cloudConsentStore';
import { DEFAULT_CONFIG } from '@backend/types/config';
import {
  apiKeyFields,
  diffSection,
  FORM_DEFAULTS,
  resetValues,
  SECTION_NAMES,
  withFormDefaults,
  type SectionName,
  type SettingsSections,
} from './settings-persist';
import './ConfigPanel.css';

export interface RAGConfig {
  // Retrieval configuration
  topK: number;
  similarityThreshold: number;
  chunkingConfig: 'cpuOptimized' | 'standard' | 'large';

  // Summary generation
  summaryGeneration: 'extractive' | 'abstractive' | 'disabled';
  summaryMaxLength: number;

  // Graph context
  useGraphContext: boolean;
  graphSimilarityThreshold: number;
  additionalGraphDocs: number;

  // Exploration graph
  explorationSimilarityThreshold: number;

  // RAG enrichment
  includeSummaries: boolean; // Use summaries in RAG instead of chunks

  // Topic modeling
  enableTopicModeling: boolean;

  // === Custom Chunking Configuration (Phase 1) ===
  customChunkingEnabled?: boolean; // Use custom parameters instead of preset
  customMaxChunkSize?: number; // 100-1500 words
  customMinChunkSize?: number; // 20-200 words
  customOverlapSize?: number; // 0-200 words

  // === Chunk Quality Filtering (Phase 1) ===
  enableQualityFiltering?: boolean; // Filter low-quality chunks
  minChunkEntropy?: number; // 0.0-1.0, minimum Shannon entropy
  minUniqueWordRatio?: number; // 0.0-1.0, minimum unique words ratio

  // === Text Preprocessing (Phase 2) ===
  enablePreprocessing?: boolean; // Enable text preprocessing pipeline
  enableOCRCleanup?: boolean; // Clean OCR artifacts
  enableHeaderFooterRemoval?: boolean; // Remove repeated headers/footers

  // === Deduplication (Phase 2) ===
  enableDeduplication?: boolean; // Enable chunk deduplication
  enableSimilarityDedup?: boolean; // Use similarity-based dedup (slower)
  dedupSimilarityThreshold?: number; // 0.7-0.95, similarity threshold

  // === Semantic Chunking (Phase 3) ===
  useSemanticChunking?: boolean; // Use embedding-based boundary detection
  semanticSimilarityThreshold?: number; // 0.5-0.9, boundary detection threshold
  semanticWindowSize?: number; // 2-5 sentences per window

  // === Context Compression ===
  enableContextCompression?: boolean; // Enable context compression before sending to LLM (default: true)
  /** Corpus manuscrit — le texte de l'auteur, indexé comme quatrième
   *  corpus RAG. Actif par défaut ; le désactiver arrête l'indexation
   *  ET la recherche. */
  indexManuscript?: boolean;
  /** Notes de lecture — cinquième corpus RAG. Actif par défaut. */
  indexReadingNotes?: boolean;
  /** Envoi des notes de lecture à un fournisseur distant. Refusé par défaut. */
  readingNotesCloudConsent?: boolean;

  // === Obsidian vault as RAG source ===
  includeObsidianVault?: boolean;
}

export interface LLMConfig {
  backend: 'ollama' | 'claude' | 'openai' | 'mistral' | 'gemini';
  ollamaURL: string;
  ollamaEmbeddingModel: string;
  ollamaChatModel: string;
  /** Override Ollama's num_ctx for embeddings; only honoured by long-context models. */
  ollamaEmbeddingNumCtx?: number;
  /** Fenêtre de contexte (num_ctx) de la génération ; 0 ou absent = défaut du serveur. */
  ollamaNumCtx?: number;
  /** Raisonnement des modèles pensants ; absent = défaut d'Ollama. */
  ollamaThink?: boolean;
  // Cloud providers — keys persisted via secureStorage by config-manager.
  claudeAPIKey?: string;
  claudeModel?: string;
  openaiAPIKey?: string;
  openaiModel?: string;
  mistralAPIKey?: string;
  mistralModel?: string;
  geminiAPIKey?: string;
  geminiModel?: string;
  useCloudEmbeddings?: boolean;
  /** Choisi dans le panneau du chat ; le formulaire le relit pour répercuter ce qui est écrit. */
  generationProvider?: LLMProvider;
}

type SettingsMode = 'simple' | 'expert';

/** Le titre de la section dans le formulaire : c'est le mot que l'auteur a sous les yeux. */
const SECTION_TITLES: Record<SectionName, string> = {
  rag: 'ragConfig.title',
  llm: 'llm.title',
  editor: 'editor.title',
  zotero: 'zotero.title',
};

export const ConfigPanel: React.FC = () => {
  const { t } = useTranslation('common');
  const { settings: editorSettings, updateSettings } = useEditorStore();
  const [settingsMode, setSettingsMode] = useState<SettingsMode>(() => {
    return (localStorage.getItem('cliodeck-settings-mode') as SettingsMode) || 'simple';
  });

  const [ragConfig, setRagConfig] = useState<RAGConfig>(FORM_DEFAULTS.rag);
  const [llmConfig, setLLMConfig] = useState<LLMConfig>(FORM_DEFAULTS.llm);
  const [editorConfig, setEditorConfig] = useState<EditorConfig>(FORM_DEFAULTS.editor);
  const [zoteroConfig, setZoteroConfig] = useState<ZoteroConfig>(FORM_DEFAULTS.zotero);

  /**
   * Les sections telles que chargées ou écrites en dernier, après fusion avec les valeurs du
   * formulaire : ce qui en diffère a été modifié ici. Sans chargement réussi, on ne sait pas ce
   * qui a changé, et rien ne part.
   */
  const snapshot = useRef<SettingsSections | null>(null);
  // `isSaving` n'est vu qu'au rendu suivant : une écriture à la fois se garde ici.
  const writing = useRef(false);

  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [saveMessageType, setSaveMessageType] = useState<'success' | 'error'>('success');

  // Load configuration on mount
  useEffect(() => {
    loadConfig();
    handleRefreshModels();
  }, []);

  // Refresh Ollama models list
  const handleRefreshModels = async () => {
    try {
      const response = await window.electron.ollama.listModels();
      if (response.success && response.models) {
        setAvailableModels(response.models.map((m: { name?: string; id?: string }) => m.name || m.id || ''));
      }
    } catch (error) {
      console.error('Failed to refresh Ollama models:', error);
    }
  };

  // Sync editorConfig with editorStore. Seuls les champs du magasin : ce que le disque porte en plus
  // (`theme`, ou un champ inconnu) reste, et un disque sans `fontFamily` en met un `undefined` dans
  // le magasin (App.tsx), qui passerait ensuite pour une modification.
  useEffect(() => {
    setEditorConfig((current) => ({
      ...current,
      fontSize: editorSettings.fontSize,
      wordWrap: editorSettings.wordWrap,
      showMinimap: editorSettings.showMinimap,
      fontFamily: editorSettings.fontFamily ?? current.fontFamily,
    }));
  }, [editorSettings]);

  const loadConfig = async () => {
    try {
      const rag = await window.electron.config.get('rag');
      const llm = await window.electron.config.get('llm');
      const editor = await window.electron.config.get('editor');
      const zotero = await window.electron.config.get('zotero');

      // Merge with defaults to ensure all properties exist
      const loaded: SettingsSections = {
        rag: withFormDefaults('rag', rag),
        llm: withFormDefaults('llm', llm),
        editor: withFormDefaults('editor', editor),
        zotero: withFormDefaults('zotero', zotero),
      };
      snapshot.current = loaded;
      setRagConfig(loaded.rag);
      setLLMConfig(loaded.llm);
      setEditorConfig(loaded.editor);
      setZoteroConfig(loaded.zotero);
    } catch (error) {
      console.error('Failed to load config:', error);
    }
  };

  /**
   * Écrit les champs de `next` qui diffèrent de `baseline`, posés sur la section relue à l'instant :
   * `set('rag')` remplace toute la section. Une section sans changement n'est ni écrite ni relancée
   * (`config:set('llm')` réinitialise les services). L'instantané n'avance que pour une section
   * écrite : le prochain Enregistrer réessaie celles qui ont été refusées, et elles seules.
   */
  const persist = async (
    next: Partial<Record<SectionName, object>>,
    baseline: Partial<Record<SectionName, object>>
  ) => {
    const written: Partial<Record<SectionName, object>> = {};
    const failures: Array<{ section: SectionName; reason: string }> = [];
    for (const section of SECTION_NAMES) {
      const target = next[section];
      if (!target) continue;
      const diff = diffSection(baseline[section] ?? {}, target);
      if (Object.keys(diff).length === 0) continue;
      try {
        const value = { ...(await window.electron.config.get(section)), ...diff };
        // Le handler ne lève pas : il répond `{ success: false }`.
        const response = await window.electron.config.set(section, value);
        if (response?.success === false) throw new Error(response.error);
        written[section] = value;
        if (snapshot.current) {
          snapshot.current = {
            ...snapshot.current,
            [section]: { ...snapshot.current[section], ...diff },
          };
        }
      } catch (error) {
        console.error(`Failed to save config section ${section}:`, error);
        failures.push({ section, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { written, failures };
  };

  /** Ce qui vient d'être écrit se voit sans redémarrage. Une section refusée ne se répercute pas. */
  const applyWritten = (written: Partial<Record<SectionName, object>>) => {
    const query = useRAGQueryStore.getState();
    const rag = written.rag && withFormDefaults('rag', written.rag);
    const llm = written.llm && withFormDefaults('llm', written.llm);
    // La ligne « Recherche : … » du chat prédit si le manuscrit sera
    // consulté ; sans l'index, il ne l'est jamais, quoi que dise la case.
    if (rag) query.setManuscriptIndexEnabled(rag.indexManuscript !== false);
    // Même chose pour les notes de lecture, que le main retire aussi du
    // prompt quand le fournisseur de génération est distant sans
    // consentement (docs/reading-notes.md).
    if (rag || llm) {
      query.setReadingNotesFlags({
        indexEnabled: rag ? rag.indexReadingNotes !== false : query.readingNotesIndexEnabled,
        cloudConsent: rag ? rag.readingNotesCloudConsent === true : query.readingNotesCloudConsent,
        generationIsCloud: llm ? isCloudProvider(llm).isCloud : query.generationIsCloud,
      });
    }

    // Le panneau du chat édite les mêmes champs (modèle, fenêtre de
    // contexte) : sans cette répercussion, le modèle qu'il tient — et
    // qu'il envoie désormais au main — l'emporterait sur celui que l'on
    // vient d'enregistrer ici jusqu'au prochain lancement.
    if (llm) {
      query.applyLLMConfig({
        ollamaChatModel: llm.ollamaChatModel,
        ollamaNumCtx: llm.ollamaNumCtx,
        ollamaThink: llm.ollamaThink,
        generationProvider: llm.generationProvider,
      });
    }

    // Update editorStore with new settings
    if (written.editor) {
      const editor = withFormDefaults('editor', written.editor);
      updateSettings({
        fontSize: editor.fontSize,
        wordWrap: editor.wordWrap,
        showMinimap: editor.showMinimap,
        fontFamily: editor.fontFamily,
      });
    }
  };

  /** Le motif, section par section : `settings.saved` ne se dit que si tout est passé. */
  const showOutcome = (
    failures: Array<{ section: SectionName; reason: string }>,
    failedKey: 'settings.saveFailed' | 'settings.resetFailed'
  ) => {
    if (failures.length === 0) {
      setSaveMessageType('success');
      setSaveMessage(t('settings.saved'));
      return;
    }
    setSaveMessageType('error');
    setSaveMessage(
      t(failedKey, {
        sections: failures.map(({ section }) => t(SECTION_TITLES[section])).join(', '),
        reason: [...new Set(failures.map(({ reason }) => reason))].join(' ; '),
      })
    );
  };

  const handleSaveConfig = async () => {
    if (writing.current) return;
    const baseline = snapshot.current;
    if (!baseline) {
      setSaveMessageType('error');
      setSaveMessage(t('settings.saveError'));
      return;
    }
    writing.current = true;
    setIsSaving(true);
    setSaveMessage('');

    try {
      const { written, failures } = await persist(
        { rag: ragConfig, llm: llmConfig, editor: editorConfig, zotero: zoteroConfig },
        baseline
      );
      applyWritten(written);
      showOutcome(failures, 'settings.saveFailed');
    } catch (error) {
      console.error('Failed to save config:', error);
      setSaveMessageType('error');
      setSaveMessage(t('settings.saveError'));
    } finally {
      writing.current = false;
      setIsSaving(false);
    }
  };

  const handleResetConfig = async () => {
    const question = t('settings.resetConfirm', { model: DEFAULT_CONFIG.llm.ollamaChatModel });
    if (!await useDialogStore.getState().showConfirm(question)) {
      return;
    }
    if (writing.current) return;
    writing.current = true;
    setIsSaving(true);
    setSaveMessage('');

    try {
      // Le disque fait foi, pas l'instantané : une autre section a pu écrire depuis l'ouverture.
      const fresh = {
        rag: await window.electron.config.get('rag'),
        llm: await window.electron.config.get('llm'),
        editor: await window.electron.config.get('editor'),
      };
      const next = resetValues(fresh);
      const { written, failures } = await persist(next, {
        rag: fresh.rag,
        llm: fresh.llm,
        editor: withFormDefaults('editor', fresh.editor),
      });

      // Le formulaire ne suit que ce que le main a accepté, et montre ce que le disque contient.
      const refused = new Set(failures.map(({ section }) => section));
      const values: Partial<SettingsSections> = {};
      if (!refused.has('rag')) {
        values.rag = withFormDefaults('rag', { ...fresh.rag, ...next.rag });
        setRagConfig(values.rag);
      }
      if (!refused.has('llm')) {
        values.llm = withFormDefaults('llm', { ...fresh.llm, ...next.llm });
        setLLMConfig(values.llm);
      }
      if (!refused.has('editor')) {
        values.editor = withFormDefaults('editor', { ...fresh.editor, ...next.editor });
        setEditorConfig(values.editor);
      }
      if (snapshot.current) snapshot.current = { ...snapshot.current, ...values };

      applyWritten(written);
      showOutcome(failures, 'settings.resetFailed');
    } catch (error) {
      console.error('Failed to reset config:', error);
      setSaveMessageType('error');
      setSaveMessage(t('settings.saveError'));
    } finally {
      writing.current = false;
      setIsSaving(false);
    }
  };

  /**
   * Après une révocation, les champs de clés montrent encore le masque chargé à l'ouverture. On
   * relit ces champs seuls : le reste du formulaire garde ses modifications non enregistrées, et
   * l'instantané suit, sans quoi le champ vidé passerait pour un effacement à écrire.
   */
  const handleKeysRevoked = async () => {
    let saved: Parameters<typeof apiKeyFields>[0] = { llm: null, zotero: null };
    try {
      saved = {
        llm: await window.electron.config.get('llm'),
        zotero: await window.electron.config.get('zotero'),
      };
    } catch (error) {
      // La révocation a réussi : mieux vaut des champs vides qu'une clé qui n'existe plus.
      console.error('Failed to reload keys after revocation:', error);
    }
    const keys = apiKeyFields(saved);
    setLLMConfig((current) => ({ ...current, ...keys.llm }));
    setZoteroConfig((current) => ({ ...current, ...keys.zotero }));
    if (snapshot.current) {
      snapshot.current = {
        ...snapshot.current,
        llm: { ...snapshot.current.llm, ...keys.llm },
        zotero: { ...snapshot.current.zotero, ...keys.zotero },
      };
    }
  };

  const handleModeChange = (mode: SettingsMode) => {
    setSettingsMode(mode);
    localStorage.setItem('cliodeck-settings-mode', mode);
  };

  return (
    <div className="config-panel">
      <div className="config-header">
        <div className="config-mode-toggle">
          <button
            type="button"
            className={`config-mode-btn ${settingsMode === 'simple' ? 'is-active' : ''}`}
            onClick={() => handleModeChange('simple')}
          >
            {t('settings.modeSimple')}
          </button>
          <button
            type="button"
            className={`config-mode-btn ${settingsMode === 'expert' ? 'is-active' : ''}`}
            onClick={() => handleModeChange('expert')}
          >
            {t('settings.modeExpert')}
          </button>
        </div>
        <div className="config-actions">
          {saveMessage && (
            <span className={`save-message ${saveMessageType}`}>
              {saveMessageType === 'success' ? <Check size={14} /> : <AlertCircle size={14} />}
              {saveMessage}
            </span>
          )}
          <button
            className="toolbar-btn"
            onClick={handleResetConfig}
            disabled={isSaving}
            title={t('settings.tooltipReset')}
          >
            <RotateCcw size={20} strokeWidth={1} />
          </button>
          <button
            className="toolbar-btn"
            onClick={handleSaveConfig}
            disabled={isSaving}
            title={isSaving ? t('settings.saving') : t('settings.tooltipSave')}
          >
            <Save size={20} strokeWidth={1} />
          </button>
        </div>
      </div>

      <div className="config-content">
        {/* Simple mode: essentials only */}
        <LanguageConfigSection />

        <LLMConfigSection
          config={llmConfig}
          onChange={setLLMConfig}
          availableModels={availableModels}
          onRefreshModels={handleRefreshModels}
        />

        <EditorConfigSection
          config={editorConfig}
          onChange={setEditorConfig}
        />

        <ZoteroConfigSection
          config={zoteroConfig}
          onChange={setZoteroConfig}
        />

        <VaultConfigSection />

        {/* Expert mode: everything else */}
        {settingsMode === 'expert' && (
          <>
            <UIConfigSection />

            <RAGConfigSection
              config={ragConfig}
              onChange={setRagConfig}
            />

            <ManuscriptCorpusSection
              enabled={ragConfig.indexManuscript !== false}
              onEnabledChange={(indexManuscript) =>
                setRagConfig({ ...ragConfig, indexManuscript })
              }
            />

            <ReadingNotesCorpusSection
              enabled={ragConfig.indexReadingNotes !== false}
              onEnabledChange={(indexReadingNotes) =>
                setRagConfig({ ...ragConfig, indexReadingNotes })
              }
              cloudConsent={ragConfig.readingNotesCloudConsent === true}
              onCloudConsentChange={(readingNotesCloudConsent) =>
                setRagConfig({ ...ragConfig, readingNotesCloudConsent })
              }
            />

            <EmbeddedLLMSection />

            <EmbeddedEmbeddingSection />

            <ModeManagerSection />

            <TopicModelingSection />

            <WorkspaceHintsSection />

            <RecipesSection />

            <MCPClientsSection />

            <MCPServerSection />

            <ArchivesConfigSection />

            <SecurityConfigSection onKeysRevoked={handleKeysRevoked} />

            <CitationStyleSection />
          </>
        )}
      </div>
    </div>
  );
};
