/**
 * TopicModelingSection - Gestion de l'environnement Python pour le topic modeling
 */
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CollapsibleSection } from '../common/CollapsibleSection';
import './ConfigPanel.css';

interface TopicModelingStatus {
  installed: boolean;
  venvPath?: string;
  pythonVersion?: string;
  error?: string;
}

export const TopicModelingSection: React.FC = () => {
  const { t } = useTranslation('common');
  const [status, setStatus] = useState<TopicModelingStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState<string[]>([]);

  // Load status on mount
  useEffect(() => {
    checkStatus();
  }, []);

  const checkStatus = async () => {
    setLoading(true);
    try {
      const result = await window.electron.topicModeling.checkStatus();
      console.log('Topic modeling status result:', result);
      if (result.success) {
        // Les propriétés sont directement sur result (pas de .data imbriqué)
        setStatus({
          installed: result.installed,
          venvPath: result.venvPath,
          pythonVersion: result.pythonVersion,
          error: result.error,
        });
      } else {
        setStatus({ installed: false, error: result.error });
      }
    } catch (error: any) {
      console.error('Failed to check topic modeling status:', error);
      setStatus({ installed: false, error: error.message || t('topicModeling.installError') });
    } finally {
      setLoading(false);
    }
  };

  const setupEnvironment = async () => {
    setInstalling(true);
    setInstallProgress([]);

    // Listen for progress messages
    const removeListener = window.electron.topicModeling.onSetupProgress((message) => {
      setInstallProgress((prev) => [...prev, message]);
    });

    try {
      const result = await window.electron.topicModeling.setupEnvironment();

      // La réponse est { success: true } directement (pas de .data imbriqué)
      if (result.success) {
        setInstallProgress((prev) => [...prev, `✅ ${t('topicModeling.installSuccess')}`]);
        // Reload status
        await checkStatus();
      } else {
        setInstallProgress((prev) => [
          ...prev,
          `❌ ${t('topicModeling.installError')}: ${result.error || 'Unknown error'}`,
        ]);
      }
    } catch (error: any) {
      console.error('Failed to setup environment:', error);
      setInstallProgress((prev) => [...prev, `❌ ${t('topicModeling.installError')}: ${error.message}`]);
    } finally {
      setInstalling(false);
      removeListener();
    }
  };

  return (
    <CollapsibleSection title={t('topicModeling.title')} defaultExpanded={false}>
      <div className="config-section">
        <div className="config-section-content">
          <p className="config-help">
            {t('topicModeling.description')}
          </p>

          {loading ? (
            <p className="config-help">{t('topicModeling.loading')}</p>
          ) : (
            <>
              <div className="topic-modeling-status">
                <div className={`topic-status-indicator ${status?.installed ? 'topic-status-success' : 'topic-status-warning'}`}>
                  <span className="topic-status-dot"></span>
                  <span className="topic-status-text">
                    {status?.installed ? t('topicModeling.installed') : t('topicModeling.notInstalled')}
                  </span>
                </div>

                {status?.installed && status.pythonVersion && (
                  <div className="topic-status-details">
                    <span>{status.pythonVersion}</span>
                    <span className="topic-status-path">{status.venvPath}</span>
                  </div>
                )}

                {status?.error && !status.installed && (
                  <div className="topic-status-error">
                    {status.error}
                  </div>
                )}
              </div>

              <div className="topic-modeling-actions">
                {(!status || !status.installed) && (
                  <button onClick={setupEnvironment} disabled={installing} className="config-btn primary">
                    {installing ? t('topicModeling.installingButton') : t('topicModeling.installButton')}
                  </button>
                )}

                {status && status.installed && (
                  <>
                    <button onClick={setupEnvironment} disabled={installing} className="config-btn-small">
                      {installing ? t('topicModeling.reinstallingButton') : t('topicModeling.reinstallButton')}
                    </button>
                    <button onClick={checkStatus} disabled={loading || installing} className="config-btn-small">
                      {t('topicModeling.checkButton')}
                    </button>
                  </>
                )}
              </div>

              {installing && installProgress.length > 0 && (
                <div className="topic-install-progress">
                  <div className="topic-progress-log">
                    {installProgress.map((msg, idx) => (
                      <div key={idx} className="topic-progress-message">
                        {msg}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!installing && installProgress.length > 0 && (
                <button onClick={() => setInstallProgress([])} className="config-btn-small" style={{ marginTop: '8px' }}>
                  {t('topicModeling.clearLog')}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </CollapsibleSection>
  );
};
