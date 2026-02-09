import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Save } from 'lucide-react';
import { CollapsibleSection } from '../common/CollapsibleSection';

interface ZoteroProjectSettingsProps {
  projectPath: string;
}

interface ProjectZoteroConfig {
  groupId?: string;
  collectionKey?: string;
}

export const ZoteroProjectSettings: React.FC<ZoteroProjectSettingsProps> = ({
  projectPath,
}) => {
  const { t } = useTranslation('common');
  const [config, setConfig] = useState<ProjectZoteroConfig>({});
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  // projectPath is the directory, we need the project.json file path
  const projectFilePath = projectPath.endsWith('project.json')
    ? projectPath
    : `${projectPath}/project.json`;

  useEffect(() => {
    loadConfig();
  }, [projectPath]);

  const loadConfig = async () => {
    try {
      // Load project-specific Zotero config from project.json
      const projectConfig = await window.electron.project.getConfig(projectFilePath);
      if (projectConfig?.zotero) {
        setConfig({
          groupId: projectConfig.zotero.groupId || '',
          collectionKey: projectConfig.zotero.collectionKey || '',
        });
      }
    } catch (error) {
      console.error('Failed to load project Zotero config:', error);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveMessage('');
    try {
      await window.electron.project.updateConfig(projectFilePath, {
        zotero: {
          groupId: config.groupId || undefined,
          collectionKey: config.collectionKey || undefined,
        },
      });
      setSaveMessage(t('settings.saved'));
      setTimeout(() => setSaveMessage(''), 3000);
    } catch (error) {
      console.error('Failed to save project Zotero config:', error);
      setSaveMessage(t('settings.saveError'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <CollapsibleSection title={t('project.zoteroSettings')} defaultExpanded={false}>
      <div className="config-section">
        <div className="config-section-content">
          <p className="config-help">
            {t('project.zoteroSettingsHelp')}
          </p>

          <div className="config-field">
            <label className="config-label">
              {t('project.zoteroGroupId')}
            </label>
            <input
              type="text"
              value={config.groupId || ''}
              onChange={(e) => setConfig({ ...config, groupId: e.target.value })}
              placeholder={t('project.zoteroGroupIdPlaceholder')}
              className="config-input"
            />
            <span className="config-help">
              {t('project.zoteroGroupIdHelp')}
            </span>
          </div>

          <div className="config-field">
            <label className="config-label">
              {t('project.zoteroCollectionKey')}
            </label>
            <input
              type="text"
              value={config.collectionKey || ''}
              onChange={(e) => setConfig({ ...config, collectionKey: e.target.value })}
              placeholder={t('project.zoteroCollectionKeyPlaceholder')}
              className="config-input"
            />
            <span className="config-help">
              {t('project.zoteroCollectionKeyHelp')}
            </span>
          </div>

          <div className="config-actions" style={{ marginTop: '12px' }}>
            <button
              className="config-btn primary"
              onClick={handleSave}
              disabled={isSaving}
            >
              <Save size={16} />
              {isSaving ? t('settings.saving') : t('settings.save')}
            </button>
            {saveMessage && (
              <span className="save-message">{saveMessage}</span>
            )}
          </div>
        </div>
      </div>
    </CollapsibleSection>
  );
};
