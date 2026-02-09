import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw, Save } from 'lucide-react';
import { RAGConfigSection } from './RAGConfigSection';
import { LLMConfigSection } from './LLMConfigSection';
import { EmbeddedLLMSection } from './EmbeddedLLMSection';
import { EditorConfigSection, type EditorConfig } from './EditorConfigSection';
import { UIConfigSection } from './UIConfigSection';
import { LanguageConfigSection } from './LanguageConfigSection';
import { TopicModelingSection } from './TopicModelingSection';
import { ModeManagerSection } from './ModeManagerSection';
import { ZoteroConfigSection, type ZoteroConfig } from './ZoteroConfigSection';
import { useEditorStore } from '../../stores/editorStore';
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
}

export interface LLMConfig {
  backend: 'ollama' | 'claude' | 'openai';
  ollamaURL: string;
  ollamaEmbeddingModel: string;
  ollamaChatModel: string;
  embeddingStrategy?: 'nomic-fallback' | 'mxbai-only' | 'custom';
}

export const ConfigPanel: React.FC = () => {
  const { t } = useTranslation('common');
  const { settings: editorSettings, updateSettings } = useEditorStore();

  const [ragConfig, setRagConfig] = useState<RAGConfig>({
    topK: 10,
    similarityThreshold: 0.2,
    chunkingConfig: 'cpuOptimized',
    summaryGeneration: 'extractive',
    summaryMaxLength: 750,
    useGraphContext: false,
    graphSimilarityThreshold: 0.7,
    additionalGraphDocs: 3,
    explorationSimilarityThreshold: 0.7,
    includeSummaries: true,
    enableTopicModeling: false,
    // Phase 1: Custom chunking
    customChunkingEnabled: false,
    customMaxChunkSize: 500,
    customMinChunkSize: 100,
    customOverlapSize: 75,
    // Phase 1: Quality filtering
    enableQualityFiltering: true,
    minChunkEntropy: 0.3,
    minUniqueWordRatio: 0.4,
    // Phase 2: Preprocessing
    enablePreprocessing: true,
    enableOCRCleanup: true,
    enableHeaderFooterRemoval: true,
    // Phase 2: Deduplication
    enableDeduplication: true,
    enableSimilarityDedup: false,
    dedupSimilarityThreshold: 0.85,
    // Phase 3: Semantic chunking
    useSemanticChunking: false,
    semanticSimilarityThreshold: 0.7,
    semanticWindowSize: 3,
    // Context compression
    enableContextCompression: true, // Enabled by default for performance
  });

  const [llmConfig, setLLMConfig] = useState<LLMConfig>({
    backend: 'ollama',
    ollamaURL: 'http://127.0.0.1:11434',
    ollamaEmbeddingModel: 'nomic-embed-text',
    ollamaChatModel: 'gemma2:2b',
    embeddingStrategy: 'nomic-fallback',
  });

  const [editorConfig, setEditorConfig] = useState<EditorConfig>({
    fontSize: 14,
    wordWrap: true,
    showMinimap: true,
    fontFamily: 'system',
    defaultEditorMode: 'wysiwyg',
  });

  const [zoteroConfig, setZoteroConfig] = useState<ZoteroConfig>({
    userId: '',
    apiKey: '',
    autoSync: false,
  });

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
        setAvailableModels(response.models.map((m: any) => m.name || m.id));
      }
    } catch (error) {
      console.error('Failed to refresh Ollama models:', error);
    }
  };

  // Sync editorConfig with editorStore on mount
  useEffect(() => {
    setEditorConfig({
      fontSize: editorSettings.fontSize,
      wordWrap: editorSettings.wordWrap,
      showMinimap: editorSettings.showMinimap,
      fontFamily: editorSettings.fontFamily,
      defaultEditorMode: editorSettings.defaultEditorMode || 'wysiwyg',
    });
  }, [editorSettings]);

  const loadConfig = async () => {
    try {
      const rag = await window.electron.config.get('rag');
      const llm = await window.electron.config.get('llm');
      const editor = await window.electron.config.get('editor');
      const zotero = await window.electron.config.get('zotero');

      // Merge with defaults to ensure all properties exist
      if (rag) {
        setRagConfig({
          topK: 10,
          similarityThreshold: 0.2,
          chunkingConfig: 'cpuOptimized',
          summaryGeneration: 'extractive',
          summaryMaxLength: 750,
          useGraphContext: false,
          graphSimilarityThreshold: 0.7,
          additionalGraphDocs: 3,
          explorationSimilarityThreshold: 0.7,
          includeSummaries: true,
          enableTopicModeling: false,
          ...rag, // Override with saved values
        });
      }
      if (llm) {
        setLLMConfig({
          backend: 'ollama',
          ollamaURL: 'http://127.0.0.1:11434',
          ollamaEmbeddingModel: 'nomic-embed-text',
          ollamaChatModel: 'gemma2:2b',
          embeddingStrategy: 'nomic-fallback',
          ...llm, // Override with saved values
        });
      }
      if (editor) setEditorConfig(editor);
      if (zotero) setZoteroConfig(zotero);
    } catch (error) {
      console.error('Failed to load config:', error);
    }
  };

  const handleSaveConfig = async () => {
    setIsSaving(true);
    setSaveMessage('');

    try {
      await window.electron.config.set('rag', ragConfig);
      await window.electron.config.set('llm', llmConfig);
      await window.electron.config.set('editor', editorConfig);
      await window.electron.config.set('zotero', zoteroConfig);

      // Update editorStore with new settings
      updateSettings({
        fontSize: editorConfig.fontSize,
        wordWrap: editorConfig.wordWrap,
        showMinimap: editorConfig.showMinimap,
        fontFamily: editorConfig.fontFamily,
        defaultEditorMode: editorConfig.defaultEditorMode,
      });

      setSaveMessageType('success');
      setSaveMessage('✅ ' + t('settings.saved'));
    } catch (error) {
      console.error('Failed to save config:', error);
      setSaveMessageType('error');
      setSaveMessage('❌ ' + t('settings.saveError'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleResetConfig = async () => {
    if (!window.confirm(t('settings.resetConfirm'))) {
      return;
    }

    try {
      // Reset to defaults
      setRagConfig({
        topK: 10,
        similarityThreshold: 0.2,
        chunkingConfig: 'cpuOptimized',
        summaryGeneration: 'extractive',
        summaryMaxLength: 750,
        useGraphContext: false,
        graphSimilarityThreshold: 0.7,
        additionalGraphDocs: 3,
        explorationSimilarityThreshold: 0.7,
        includeSummaries: true,
        enableTopicModeling: false,
      });
      setLLMConfig({
        backend: 'ollama',
        ollamaURL: 'http://127.0.0.1:11434',
        ollamaEmbeddingModel: 'nomic-embed-text',
        ollamaChatModel: 'gemma2:2b',
        embeddingStrategy: 'nomic-fallback',
      });
      setEditorConfig({
        fontSize: 14,
        wordWrap: true,
        showMinimap: true,
        fontFamily: 'system',
        defaultEditorMode: 'wysiwyg',
      });

      await handleSaveConfig();
    } catch (error) {
      console.error('Failed to reset config:', error);
    }
  };

  return (
    <div className="config-panel">
      <div className="config-header">
        <div className="config-actions">
          {saveMessage && (
            <span className={`save-message ${saveMessageType}`}>{saveMessage}</span>
          )}
          <button
            className="toolbar-btn"
            onClick={handleResetConfig}
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
        <UIConfigSection />

        <LanguageConfigSection />

        <RAGConfigSection
          config={ragConfig}
          onChange={setRagConfig}
        />

        <LLMConfigSection
          config={llmConfig}
          onChange={setLLMConfig}
          availableModels={availableModels}
          onRefreshModels={handleRefreshModels}
        />

        <EmbeddedLLMSection />

        <ModeManagerSection />

        <EditorConfigSection
          config={editorConfig}
          onChange={setEditorConfig}
        />

        <ZoteroConfigSection
          config={zoteroConfig}
          onChange={setZoteroConfig}
        />

        <TopicModelingSection />
      </div>
    </div>
  );
};
