/**
 * Section de configuration des embeddings (#18).
 *
 * Le backend lisait déjà `embeddingProvider` (cliodeck-config-adapter) et
 * les IPC embedded-embedding:* (download, delete, list, set/get-provider)
 * étaient complets — seule cette UI manquait : le RAG hors-ligne exigeait
 * d'éditer config.json à la main.
 *
 * Sémantique du provider (contrat de l'adaptateur) :
 * - auto : Ollama d'abord, repli sur le modèle embarqué si les dimensions
 *   concordent ;
 * - ollama : toujours Ollama (modèle choisi dans la section LLM) ;
 * - embedded : le modèle GGUF embarqué (repli Ollama s'il n'est pas
 *   téléchargé).
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Trash2, Check, AlertCircle, Loader2 } from 'lucide-react';
import { CollapsibleSection } from '../common/CollapsibleSection';
import { useDialogStore } from '../../stores/dialogStore';

type EmbeddingProvider = 'ollama' | 'embedded' | 'auto';

interface ModelInfo {
  id: string;
  name: string;
  sizeMB: number;
  description: string;
  downloaded: boolean;
}

interface DownloadProgress {
  percent: number;
  downloadedMB: number;
  totalMB: number;
  speed: string;
  eta: string;
  status: 'pending' | 'downloading' | 'verifying' | 'complete' | 'error' | 'cancelled';
  message: string;
}

export const EmbeddedEmbeddingSection: React.FC = () => {
  const { t } = useTranslation('common');

  const [provider, setProvider] = useState<EmbeddingProvider>('auto');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [downloadingModelId, setDownloadingModelId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadData();
    const unsubscribe = window.electron.embeddedEmbedding.onDownloadProgress((progress) => {
      setDownloadProgress(progress);
      if (
        progress.status === 'complete' ||
        progress.status === 'error' ||
        progress.status === 'cancelled'
      ) {
        setDownloadingModelId(null);
        loadData();
      }
    });
    return () => {
      unsubscribe();
    };
  }, []);

  const loadData = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const [providerRes, modelsRes] = await Promise.all([
        window.electron.embeddedEmbedding.getProvider(),
        window.electron.embeddedEmbedding.listModels(),
      ]);
      if (providerRes?.success && providerRes.provider) {
        setProvider(providerRes.provider as EmbeddingProvider);
      }
      if (modelsRes?.success && modelsRes.models) {
        setModels(modelsRes.models);
      }
    } catch (err) {
      console.error('Failed to load embedding config:', err);
      setError(t('embeddedLLM.loadError'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleProviderChange = async (next: EmbeddingProvider) => {
    const previous = provider;
    setProvider(next);
    try {
      const res = await window.electron.embeddedEmbedding.setProvider(next);
      if (!res?.success) throw new Error(res?.error || 'setProvider failed');
    } catch (err) {
      console.error('Failed to set embedding provider:', err);
      setProvider(previous);
      setError(t('embeddedEmbedding.providerSaveError'));
    }
  };

  const handleDownload = async (modelId: string) => {
    try {
      setError(null);
      setDownloadingModelId(modelId);
      setDownloadProgress({
        percent: 0,
        downloadedMB: 0,
        totalMB: 0,
        speed: '',
        eta: '',
        status: 'pending',
        message: t('embeddedLLM.startingDownload'),
      });
      await window.electron.embeddedEmbedding.download(modelId);
    } catch (err: unknown) {
      console.error('Embedding model download failed:', err);
      setError(err instanceof Error ? err.message : t('embeddedLLM.downloadError'));
      setDownloadingModelId(null);
    }
  };

  const handleDeleteModel = async (modelId: string) => {
    if (!(await useDialogStore.getState().showConfirm(t('embeddedLLM.deleteConfirm')))) {
      return;
    }
    try {
      await window.electron.embeddedEmbedding.deleteModel(modelId);
      await loadData();
    } catch (err) {
      console.error('Failed to delete embedding model:', err);
      setError(t('embeddedLLM.deleteError'));
    }
  };

  if (isLoading) {
    return (
      <CollapsibleSection title={t('embeddedEmbedding.title')} defaultExpanded={false}>
        <div className="config-section">
          <div
            className="config-section-content"
            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '16px' }}
          >
            <Loader2 className="animate-spin" size={20} />
            <span>{t('embeddedLLM.loading')}</span>
          </div>
        </div>
      </CollapsibleSection>
    );
  }

  return (
    <CollapsibleSection title={t('embeddedEmbedding.title')} defaultExpanded={false}>
      <div className="config-section">
        <div className="config-section-content">
          {error && (
            <div
              className="config-error"
              style={{
                padding: '12px',
                backgroundColor: 'var(--color-danger-bg)',
                color: 'var(--color-danger)',
                borderRadius: '4px',
                marginBottom: '16px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <AlertCircle size={16} />
              {error}
            </div>
          )}

          {/* Provider */}
          <div className="config-field">
            <label className="config-label">
              {t('embeddedEmbedding.providerLabel')}
              <span className="config-help">{t('embeddedEmbedding.providerHelp')}</span>
            </label>
            <select
              value={provider}
              onChange={(e) => void handleProviderChange(e.target.value as EmbeddingProvider)}
              className="config-input"
            >
              <option value="auto">{t('embeddedEmbedding.providerAuto')}</option>
              <option value="ollama">{t('embeddedEmbedding.providerOllama')}</option>
              <option value="embedded">{t('embeddedEmbedding.providerEmbedded')}</option>
            </select>
            <div className="config-description">
              <div
                style={{
                  padding: '8px 12px',
                  backgroundColor: 'var(--color-warning-bg)',
                  border: '1px solid var(--color-warning)',
                  borderRadius: '4px',
                  marginTop: '8px',
                }}
              >
                <small>{t('embeddedEmbedding.reindexWarning')}</small>
              </div>
            </div>
          </div>

          {/* Embedded models */}
          <div className="config-field">
            <label className="config-label">
              {t('embeddedEmbedding.modelsLabel')}
              <span className="config-help">{t('embeddedEmbedding.modelsHelp')}</span>
            </label>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {models.map((model) => (
                <div
                  key={model.id}
                  style={{
                    padding: '12px',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    backgroundColor: 'var(--bg-app)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      marginBottom: '8px',
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 500, marginBottom: '4px' }}>{model.name}</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
                        {model.description}
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                        {model.sizeMB} MB
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {model.downloaded ? (
                        <>
                          <span
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px',
                              color: 'var(--color-success)',
                              fontSize: '13px',
                            }}
                          >
                            <Check size={16} />
                            {t('embeddedLLM.downloaded')}
                          </span>
                          <button
                            onClick={() => void handleDeleteModel(model.id)}
                            className="config-btn-small"
                            title={t('embeddedLLM.delete')}
                            style={{
                              color: 'var(--color-danger)',
                              padding: '6px',
                              display: 'flex',
                              alignItems: 'center',
                            }}
                          >
                            <Trash2 size={16} />
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => void handleDownload(model.id)}
                          className="config-btn-small"
                          disabled={downloadingModelId !== null}
                          title={t('embeddedLLM.download')}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            padding: '6px 12px',
                            opacity: downloadingModelId !== null ? 0.5 : 1,
                          }}
                        >
                          <Download size={16} />
                          {t('embeddedLLM.download')}
                        </button>
                      )}
                    </div>
                  </div>

                  {downloadingModelId === model.id && downloadProgress && (
                    <div style={{ marginTop: '12px' }}>
                      <div
                        style={{
                          height: '6px',
                          backgroundColor: 'var(--bg-card)',
                          borderRadius: '3px',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            width: `${downloadProgress.percent}%`,
                            height: '100%',
                            backgroundColor: 'var(--color-accent)',
                            transition: 'width 0.3s ease',
                          }}
                        />
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          marginTop: '6px',
                          fontSize: '12px',
                          color: 'var(--text-tertiary)',
                        }}
                      >
                        <span>{downloadProgress.message}</span>
                        <span>
                          {downloadProgress.downloadedMB.toFixed(1)} /{' '}
                          {downloadProgress.totalMB.toFixed(1)} MB
                          {downloadProgress.speed && ` - ${downloadProgress.speed}`}
                          {downloadProgress.eta && ` - ${downloadProgress.eta}`}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </CollapsibleSection>
  );
};
