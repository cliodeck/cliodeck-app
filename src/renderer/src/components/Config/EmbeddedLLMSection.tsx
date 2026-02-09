/**
 * Section de configuration pour le LLM embarqué (Qwen2.5)
 * Permet de gérer le téléchargement et la suppression des modèles
 * Le choix du provider se fait dans les paramètres du chatbot (RAGSettingsPanel)
 */
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Trash2, Check, AlertCircle, Loader2, HardDrive } from 'lucide-react';
import { CollapsibleSection } from '../common/CollapsibleSection';

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

export const EmbeddedLLMSection: React.FC = () => {
  const { t } = useTranslation('common');

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [downloadingModelId, setDownloadingModelId] = useState<string | null>(null);
  const [usedSpace, setUsedSpace] = useState<string>('0 MB');
  const [modelsDirectory, setModelsDirectory] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Load initial data
  useEffect(() => {
    loadData();

    // Subscribe to download progress
    const unsubscribe = window.electron.embeddedLLM.onDownloadProgress((progress) => {
      setDownloadProgress(progress);
      if (progress.status === 'complete' || progress.status === 'error' || progress.status === 'cancelled') {
        setDownloadingModelId(null);
        loadData(); // Refresh model list
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

      const [modelsRes, spaceRes, directoryRes, downloadingRes] = await Promise.all([
        window.electron.embeddedLLM.listModels(),
        window.electron.embeddedLLM.getUsedSpace(),
        window.electron.embeddedLLM.getModelsDirectory(),
        window.electron.embeddedLLM.isDownloading(),
      ]);

      // Extract data from IPC responses (they are wrapped with { success: true, ... })
      if (modelsRes?.success && modelsRes.models) {
        setModels(modelsRes.models);
      }
      if (spaceRes?.success) {
        // spaceRes contains { totalMB, models }
        const totalMB = spaceRes.totalMB || 0;
        setUsedSpace(totalMB > 0 ? `${totalMB.toFixed(1)} MB` : '0 MB');
      }
      if (directoryRes?.success) {
        setModelsDirectory(directoryRes.directory || '');
      }
      if (downloadingRes?.success && downloadingRes.downloading && downloadingRes.modelId) {
        setDownloadingModelId(downloadingRes.modelId);
      }
    } catch (err) {
      console.error('Failed to load embedded LLM data:', err);
      setError(t('embeddedLLM.loadError'));
    } finally {
      setIsLoading(false);
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

      await window.electron.embeddedLLM.download(modelId);
    } catch (err: any) {
      console.error('Download failed:', err);
      setError(err.message || t('embeddedLLM.downloadError'));
      setDownloadingModelId(null);
    }
  };

  const handleCancelDownload = async () => {
    try {
      await window.electron.embeddedLLM.cancelDownload();
    } catch (err) {
      console.error('Failed to cancel download:', err);
    }
  };

  const handleDeleteModel = async (modelId: string) => {
    if (!window.confirm(t('embeddedLLM.deleteConfirm'))) {
      return;
    }

    try {
      await window.electron.embeddedLLM.deleteModel(modelId);
      await loadData();
    } catch (err) {
      console.error('Failed to delete model:', err);
      setError(t('embeddedLLM.deleteError'));
    }
  };

  if (isLoading) {
    return (
      <CollapsibleSection title={t('embeddedLLM.title')} defaultExpanded={false}>
        <div className="config-section">
          <div className="config-section-content" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '16px' }}>
            <Loader2 className="animate-spin" size={20} />
            <span>{t('embeddedLLM.loading')}</span>
          </div>
        </div>
      </CollapsibleSection>
    );
  }

  return (
    <CollapsibleSection title={t('embeddedLLM.title')} defaultExpanded={false}>
      <div className="config-section">
        <div className="config-section-content">
          {error && (
            <div className="config-error" style={{
              padding: '12px',
              backgroundColor: 'var(--error-bg, #fee2e2)',
              color: 'var(--error-text, #dc2626)',
              borderRadius: '4px',
              marginBottom: '16px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}>
              <AlertCircle size={16} />
              {error}
            </div>
          )}

          {/* Info about provider selection */}
          <div className="config-field">
            <div className="config-description" style={{ marginBottom: '12px' }}>
              <small>{t('embeddedLLM.providerNote')}</small>
            </div>
          </div>

          {/* Available Models */}
          <div className="config-field">
            <label className="config-label">
              {t('embeddedLLM.modelsLabel')}
              <span className="config-help">
                {t('embeddedLLM.modelsHelp')}
              </span>
            </label>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {models.map((model) => (
                <div
                  key={model.id}
                  style={{
                    padding: '12px',
                    border: '1px solid var(--border-color, #333)',
                    borderRadius: '6px',
                    backgroundColor: 'var(--bg-secondary, #1e1e1e)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                    <div>
                      <div style={{ fontWeight: 500, marginBottom: '4px' }}>{model.name}</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary, #888)' }}>
                        {model.description}
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-tertiary, #666)', marginTop: '4px' }}>
                        {model.sizeMB} MB
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {model.downloaded ? (
                        <>
                          <span style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            color: 'var(--success-color, #22c55e)',
                            fontSize: '13px'
                          }}>
                            <Check size={16} />
                            {t('embeddedLLM.downloaded')}
                          </span>
                          <button
                            onClick={() => handleDeleteModel(model.id)}
                            className="config-btn-small"
                            title={t('embeddedLLM.delete')}
                            style={{
                              color: 'var(--error-text, #dc2626)',
                              padding: '6px',
                              display: 'flex',
                              alignItems: 'center'
                            }}
                          >
                            <Trash2 size={16} />
                          </button>
                        </>
                      ) : downloadingModelId === model.id ? (
                        <button
                          onClick={handleCancelDownload}
                          className="config-btn-small"
                          style={{ padding: '6px 12px' }}
                        >
                          {t('embeddedLLM.cancel')}
                        </button>
                      ) : downloadingModelId !== null ? (
                        <button
                          className="config-btn-small"
                          disabled
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            padding: '6px 12px',
                            opacity: 0.5
                          }}
                        >
                          <Download size={16} />
                          {t('embeddedLLM.download')}
                        </button>
                      ) : (
                        <button
                          onClick={() => handleDownload(model.id)}
                          className="config-btn-small"
                          title={t('embeddedLLM.download')}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            padding: '6px 12px'
                          }}
                        >
                          <Download size={16} />
                          {t('embeddedLLM.download')}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Download Progress - only show for the model being downloaded */}
                  {downloadingModelId === model.id && downloadProgress && (
                    <div style={{ marginTop: '12px' }}>
                      <div style={{
                        height: '6px',
                        backgroundColor: 'var(--bg-tertiary, #333)',
                        borderRadius: '3px',
                        overflow: 'hidden'
                      }}>
                        <div
                          style={{
                            width: `${downloadProgress.percent}%`,
                            height: '100%',
                            backgroundColor: 'var(--primary-color, #3b82f6)',
                            transition: 'width 0.3s ease'
                          }}
                        />
                      </div>
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        marginTop: '6px',
                        fontSize: '12px',
                        color: 'var(--text-secondary, #888)'
                      }}>
                        <span>{downloadProgress.message}</span>
                        <span>
                          {downloadProgress.downloadedMB.toFixed(1)} / {downloadProgress.totalMB.toFixed(1)} MB
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

          {/* Storage Info */}
          <div className="config-field">
            <label className="config-label">
              <HardDrive size={16} style={{ marginRight: '6px', verticalAlign: 'middle' }} />
              {t('embeddedLLM.storageLabel')}
            </label>
            <div className="config-description">
              <small>
                {t('embeddedLLM.usedSpace')}: {usedSpace}
                <br />
                {t('embeddedLLM.location')}: {modelsDirectory}
              </small>
            </div>
          </div>
        </div>
      </div>
    </CollapsibleSection>
  );
};
