import React from 'react';
import { useTranslation } from 'react-i18next';
import { CollapsibleSection } from '../common/CollapsibleSection';
import { useLanguageStore } from '../../stores/languageStore';
import { useRAGQueryStore } from '../../stores/ragQueryStore';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from '../../i18n';

export const LanguageConfigSection: React.FC = () => {
  const { t } = useTranslation('common');
  const { currentLanguage, setLanguage } = useLanguageStore();
  const setRAGParams = useRAGQueryStore((state) => state.setParams);

  const handleLanguageChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newLanguage = e.target.value as SupportedLanguage;
    await setLanguage(newLanguage);

    // Sync systemPromptLanguage with the new language (only FR/EN are supported for prompts)
    if (newLanguage === 'fr' || newLanguage === 'en') {
      try {
        // Update Electron config
        const currentRag = await window.electron.config.get('rag') || {};
        console.log('Syncing systemPromptLanguage to:', newLanguage, 'current RAG config:', currentRag);
        await window.electron.config.set('rag', {
          ...currentRag,
          systemPromptLanguage: newLanguage
        });

        // Update RAG query store (used by chat)
        setRAGParams({ systemPromptLanguage: newLanguage });

        console.log('systemPromptLanguage synced successfully (config + store)');
      } catch (error) {
        console.error('Failed to sync systemPromptLanguage:', error);
      }
    }
  };

  return (
    <CollapsibleSection title={t('settings.language')} defaultExpanded={false}>
      <div className="config-section">
        <div className="config-section-content">
          <div className="config-field">
            <label className="config-label">
              {t('settings.selectLanguage')}
              <span className="config-help">
                {t('settings.languageSelector.label')}
              </span>
            </label>
            <select
              value={currentLanguage}
              onChange={handleLanguageChange}
              className="config-select"
            >
              {Object.entries(SUPPORTED_LANGUAGES).map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
            <div className="config-description">
              <small>
                • {t('settings.languageSelector.changeWarning')}
              </small>
            </div>
          </div>
        </div>
      </div>
    </CollapsibleSection>
  );
};
