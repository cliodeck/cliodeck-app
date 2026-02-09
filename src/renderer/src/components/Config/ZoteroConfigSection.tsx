import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, XCircle, ExternalLink } from 'lucide-react';
import { CollapsibleSection } from '../common/CollapsibleSection';

export interface ZoteroConfig {
  userId: string;
  apiKey: string;
  autoSync: boolean;
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

  const handleTestConnection = async () => {
    if (!config.userId || !config.apiKey) {
      alert(t('zotero.enterCredentials'));
      return;
    }

    setIsTesting(true);
    setTestStatus('idle');

    try {
      const result = await window.electron.zotero.testConnection(config.userId, config.apiKey);
      setTestStatus(result.success ? 'success' : 'error');

      if (result.success) {
        setTimeout(() => setTestStatus('idle'), 3000);
      }
    } catch (error) {
      setTestStatus('error');
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <CollapsibleSection title="Zotero" defaultExpanded={false}>
      <div className="config-section">
        <div className="config-section-content">
        <p className="config-description">
          {t('zotero.configDescription')}
        </p>

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

        <p className="config-help" style={{ marginTop: '8px' }}>
          {t('zotero.projectNote')}
        </p>

        <div className="config-actions">
          <button
            className="config-btn secondary"
            onClick={handleTestConnection}
            disabled={isTesting || !config.userId || !config.apiKey}
          >
            {isTesting ? (
              t('zotero.testing')
            ) : testStatus === 'success' ? (
              <>
                <CheckCircle size={16} style={{ color: '#4caf50' }} />
                {t('zotero.connectionOk')}
              </>
            ) : testStatus === 'error' ? (
              <>
                <XCircle size={16} style={{ color: '#f44336' }} />
                {t('zotero.connectionFailed')}
              </>
            ) : (
              t('zotero.testConnection')
            )}
          </button>

          <a
            href="https://www.zotero.org/settings/keys"
            target="_blank"
            rel="noopener noreferrer"
            className="config-link"
          >
            <ExternalLink size={14} />
            {t('zotero.getApiKey')}
          </a>
        </div>
        </div>
      </div>
    </CollapsibleSection>
  );
};
