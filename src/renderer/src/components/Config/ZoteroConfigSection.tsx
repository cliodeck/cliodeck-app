import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, XCircle, ExternalLink, FolderOpen } from 'lucide-react';
import { CollapsibleSection } from '../common/CollapsibleSection';
import { useDialogStore } from '../../stores/dialogStore';

export interface ZoteroConfig {
  mode: 'api' | 'local';
  userId: string;
  apiKey: string;
  autoSync: boolean;
  dataDirectory: string;
}

interface ZoteroConfigSectionProps {
  config: ZoteroConfig;
  onChange: (config: ZoteroConfig) => void;
}

export const ZoteroConfigSection: React.FC<ZoteroConfigSectionProps> = ({
  config,
  onChange,
}) => {
  const { t } = useTranslation('common');
  const [isTesting, setIsTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'success' | 'error'>('idle');

  const mode = config.mode || 'api';

  const handleTestConnection = async () => {
    if (mode === 'api') {
      if (!config.userId || !config.apiKey) {
        await useDialogStore.getState().showAlert(t('zotero.enterCredentials'));
        return;
      }
      setIsTesting(true);
      setTestStatus('idle');
      try {
        const result = await window.electron.zotero.testConnection({
          mode: 'api',
          userId: config.userId,
          apiKey: config.apiKey,
        });
        setTestStatus(result.success ? 'success' : 'error');
        if (result.success) {
          setTimeout(() => setTestStatus('idle'), 3000);
        }
      } catch {
        setTestStatus('error');
      } finally {
        setIsTesting(false);
      }
    } else {
      if (!config.dataDirectory) {
        await useDialogStore.getState().showAlert(t('zotero.enterDataDirectory'));
        return;
      }
      setIsTesting(true);
      setTestStatus('idle');
      try {
        const result = await window.electron.zotero.testConnection({
          mode: 'local',
          dataDirectory: config.dataDirectory,
        });
        setTestStatus(result.success ? 'success' : 'error');
        if (result.success) {
          setTimeout(() => setTestStatus('idle'), 3000);
        }
      } catch {
        setTestStatus('error');
      } finally {
        setIsTesting(false);
      }
    }
  };

  const handleBrowseDirectory = async () => {
    try {
      const result = await window.electron.dialog.openFile({
        properties: ['openDirectory'],
        title: t('zotero.dataDirectory'),
      });
      if (result && !result.canceled && result.filePaths?.length > 0) {
        onChange({ ...config, dataDirectory: result.filePaths[0] });
      }
    } catch (error) {
      console.error('Failed to open directory dialog:', error);
    }
  };

  const isTestDisabled = mode === 'api'
    ? (isTesting || !config.userId || !config.apiKey)
    : (isTesting || !config.dataDirectory);

  return (
    <CollapsibleSection title="Zotero" defaultExpanded={false}>
      <div className="config-section">
        <div className="config-section-content">
        <p className="config-description">
          {t('zotero.configDescription')}
        </p>

        {/* Mode selector */}
        <div className="config-field">
          <label>{t('zotero.mode')}</label>
          <div style={{ display: 'flex', gap: '16px', marginTop: '4px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input
                type="radio"
                name="zotero-mode"
                value="local"
                checked={mode === 'local'}
                onChange={() => onChange({ ...config, mode: 'local' })}
              />
              {t('zotero.modeLocal')}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input
                type="radio"
                name="zotero-mode"
                value="api"
                checked={mode === 'api'}
                onChange={() => onChange({ ...config, mode: 'api' })}
              />
              {t('zotero.modeApi')}
            </label>
          </div>
        </div>

        {mode === 'api' ? (
          <>
            <div className="config-field">
              <label>User ID</label>
              <input
                type="text"
                value={config.userId}
                onChange={(e) => onChange({ ...config, userId: e.target.value })}
                placeholder="123456"
              />
            </div>

            <div className="config-field">
              <label>API Key</label>
              <input
                type="password"
                value={config.apiKey}
                onChange={(e) => onChange({ ...config, apiKey: e.target.value })}
                placeholder={t('zotero.apiKeyPlaceholder')}
              />
            </div>
          </>
        ) : (
          <div className="config-field">
            <label>{t('zotero.dataDirectory')}</label>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                type="text"
                value={config.dataDirectory || ''}
                onChange={(e) => onChange({ ...config, dataDirectory: e.target.value })}
                placeholder={t('zotero.dataDirectoryPlaceholder')}
                style={{ flex: 1 }}
              />
              <button
                className="config-btn secondary"
                onClick={handleBrowseDirectory}
                style={{ whiteSpace: 'nowrap' }}
              >
                <FolderOpen size={16} />
                {t('zotero.browse')}
              </button>
            </div>
            <p className="config-help" style={{ marginTop: '4px' }}>
              {t('zotero.dataDirectoryHelp')}
            </p>
          </div>
        )}

        <p className="config-help" style={{ marginTop: '8px' }}>
          {t('zotero.projectNote')}
        </p>

        <div className="config-actions">
          <button
            className="config-btn secondary"
            onClick={handleTestConnection}
            disabled={isTestDisabled}
          >
            {isTesting ? (
              t('zotero.testing')
            ) : testStatus === 'success' ? (
              <>
                <CheckCircle size={16} style={{ color: '#4caf50' }} />
                {mode === 'api' ? t('zotero.connectionOk') : t('zotero.localConnectionOk')}
              </>
            ) : testStatus === 'error' ? (
              <>
                <XCircle size={16} style={{ color: '#f44336' }} />
                {mode === 'api' ? t('zotero.connectionFailed') : t('zotero.localConnectionFailed')}
              </>
            ) : (
              t('zotero.testConnection')
            )}
          </button>

          {mode === 'api' && (
            <a
              href="https://www.zotero.org/settings/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="config-link"
            >
              <ExternalLink size={14} />
              {t('zotero.getApiKey')}
            </a>
          )}
        </div>
        </div>
      </div>
    </CollapsibleSection>
  );
};
