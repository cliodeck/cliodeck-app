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
  libraryID?: number;
}

const blankToUndefined = <T,>(value: T | ''): T | undefined => (value === '' ? undefined : value);

/**
 * Ce que l'auteur a changé depuis la lecture du fichier, rien d'autre : une synchronisation a pu y
 * poser une autre collection entre-temps, et l'écraser par ce qui est à l'écran ferait repartir la
 * synchronisation suivante de l'ancienne. Une clé à `undefined` efface.
 */
function changedFields(
  loaded: ProjectZoteroConfig,
  edited: ProjectZoteroConfig,
  mode: 'api' | 'local'
): ProjectZoteroConfig {
  const changes: ProjectZoteroConfig = {};
  if (blankToUndefined(edited.collectionKey) !== blankToUndefined(loaded.collectionKey)) {
    changes.collectionKey = blankToUndefined(edited.collectionKey);
  }
  if (mode === 'api' && blankToUndefined(edited.groupId) !== blankToUndefined(loaded.groupId)) {
    changes.groupId = blankToUndefined(edited.groupId);
  }
  if (mode === 'local' && edited.libraryID !== loaded.libraryID) {
    changes.libraryID = edited.libraryID;
  }
  return changes;
}

interface ZoteroLibraryInfo {
  libraryID: number;
  type: 'user' | 'group';
  name: string;
  groupID?: number;
}

export const ZoteroProjectSettings: React.FC<ZoteroProjectSettingsProps> = ({
  projectPath,
}) => {
  const { t } = useTranslation('common');
  const [config, setConfig] = useState<ProjectZoteroConfig>({});
  const [loaded, setLoaded] = useState<ProjectZoteroConfig>({});
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [saveFailed, setSaveFailed] = useState(false);
  const [zoteroMode, setZoteroMode] = useState<'api' | 'local'>('api');
  const [libraries, setLibraries] = useState<ZoteroLibraryInfo[]>([]);
  const [isLoadingLibraries, setIsLoadingLibraries] = useState(false);

  // projectPath is the directory, we need the project.json file path
  const projectFilePath = projectPath.endsWith('project.json')
    ? projectPath
    : `${projectPath}/project.json`;

  useEffect(() => {
    // Une lecture du projet précédent qui répond après l'ouverture de celui-ci ne s'affiche pas :
    // l'auteur la prendrait pour celle de ce projet (S17-1-7).
    let current = true;
    loadConfig(() => current);
    return () => {
      current = false;
    };
  }, [projectPath]);

  const loadConfig = async (isCurrent: () => boolean) => {
    try {
      // Load global Zotero config to get mode and dataDirectory
      const globalConfig = await window.electron.config.get('zotero');
      if (!isCurrent()) return;
      const mode = globalConfig?.mode || 'api';
      setZoteroMode(mode);

      // Load project-specific Zotero config from project.json
      const projectConfig = await window.electron.project.getConfig(projectFilePath);
      if (!isCurrent()) return;
      const stored: ProjectZoteroConfig = {
        groupId: projectConfig?.zotero?.groupId || '',
        collectionKey: projectConfig?.zotero?.collectionKey || '',
        libraryID: projectConfig?.zotero?.libraryID,
      };
      setConfig(stored);
      setLoaded(stored);

      // If local mode, load libraries
      if (mode === 'local' && globalConfig?.dataDirectory) {
        loadLibraries(globalConfig.dataDirectory);
      }
    } catch (error) {
      console.error('Failed to load project Zotero config:', error);
    }
  };

  const loadLibraries = async (dir: string) => {
    setIsLoadingLibraries(true);
    try {
      const result = await window.electron.zotero.listLibraries(dir);
      if (result.success && result.libraries) {
        setLibraries(result.libraries);
      }
    } catch (error) {
      console.error('Failed to load Zotero libraries:', error);
    } finally {
      setIsLoadingLibraries(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveMessage('');
    setSaveFailed(false);
    try {
      const result = await window.electron.project.updateConfig(projectFilePath, {
        zotero: changedFields(loaded, config, zoteroMode),
      });
      if (!result?.success) {
        console.error('Project Zotero config refused:', result?.error);
        setSaveFailed(true);
        setSaveMessage(t('project.zoteroNotSaved'));
        return;
      }
      setLoaded(config);
      setSaveMessage(t('settings.saved'));
      setTimeout(() => setSaveMessage(''), 3000);
    } catch (error) {
      console.error('Failed to save project Zotero config:', error);
      setSaveFailed(true);
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

          {zoteroMode === 'api' ? (
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
          ) : (
            <div className="config-field">
              <label className="config-label">
                {t('project.zoteroLibrary')}
              </label>
              {isLoadingLibraries ? (
                <p className="config-help">{t('project.zoteroLibraryLoading')}</p>
              ) : (
                <select
                  value={config.libraryID ?? ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    setConfig({
                      ...config,
                      libraryID: val ? Number(val) : undefined,
                    });
                  }}
                  className="config-input"
                >
                  <option value="">{t('project.zoteroLibraryPersonal')}</option>
                  {libraries
                    .filter((lib) => lib.type === 'group')
                    .map((lib) => (
                      <option key={lib.libraryID} value={lib.libraryID}>
                        {lib.name}
                      </option>
                    ))}
                </select>
              )}
              <span className="config-help">
                {t('project.zoteroLibraryHelp')}
              </span>
            </div>
          )}

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

          {/* Le panneau est étroit : à côté du bouton, un message long écrase et déborde. */}
          <div className="config-actions" style={{ marginTop: '12px', flexWrap: 'wrap' }}>
            <button
              className="config-btn primary"
              onClick={handleSave}
              disabled={isSaving}
            >
              <Save size={16} />
              {isSaving ? t('settings.saving') : t('settings.save')}
            </button>
            {saveMessage && (
              <span className={saveFailed ? 'save-message error' : 'save-message'} role={saveFailed ? 'alert' : undefined}>
                {saveMessage}
              </span>
            )}
          </div>
        </div>
      </div>
    </CollapsibleSection>
  );
};
