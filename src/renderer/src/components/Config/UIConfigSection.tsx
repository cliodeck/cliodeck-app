import React from 'react';
import { useTranslation } from 'react-i18next';
import { CollapsibleSection } from '../common/CollapsibleSection';
import { useTheme, type ThemeMode } from '../../hooks/useTheme';

export const UIConfigSection: React.FC = () => {
  const { t } = useTranslation('common');
  const { config, setConfig, currentTheme } = useTheme();

  const handleThemeModeChange = (mode: ThemeMode) => {
    setConfig({ ...config, mode });
  };

  const handleAutoSwitchToggle = (enabled: boolean) => {
    setConfig({ ...config, autoSwitchEnabled: enabled });
  };

  const handleLightModeStartChange = (time: string) => {
    setConfig({ ...config, lightModeStart: time });
  };

  const handleDarkModeStartChange = (time: string) => {
    setConfig({ ...config, darkModeStart: time });
  };

  return (
    <CollapsibleSection title={t('ui.title')} defaultExpanded={false}>
      <div className="config-section">
        <div className="config-section-content">
          {/* Theme Mode */}
          <div className="config-field">
            <label className="config-label">
              {t('ui.theme.title')}
              <span className="config-help">
                {t('ui.theme.description')}
              </span>
            </label>
            <select
              value={config.mode}
              onChange={(e) => handleThemeModeChange(e.target.value as ThemeMode)}
              className="config-select"
            >
              <option value="light">{t('ui.theme.light')}</option>
              <option value="dark">{t('ui.theme.dark')}</option>
              <option value="auto">{t('ui.theme.auto')}</option>
            </select>
            <div className="config-description">
              <small>
                {t('ui.theme.currentTheme')}: {currentTheme === 'light' ? t('ui.theme.light') : t('ui.theme.dark')}
              </small>
            </div>
          </div>

          {/* Auto Switch Settings - Only shown when 'auto' mode is selected */}
          {config.mode === 'auto' && (
            <>
              <div className="config-field">
                <label className="config-label">
                  {t('ui.theme.autoSwitch.title')}
                  <span className="config-help">
                    {t('ui.theme.autoSwitch.description')}
                  </span>
                </label>
                <div className="config-input-group">
                  <input
                    type="checkbox"
                    checked={config.autoSwitchEnabled}
                    onChange={(e) => handleAutoSwitchToggle(e.target.checked)}
                    className="config-checkbox"
                  />
                  <span>{config.autoSwitchEnabled ? t('ui.theme.enabled') : t('ui.theme.disabled')}</span>
                </div>
              </div>

              {config.autoSwitchEnabled && (
                <>
                  <div className="config-field">
                    <label className="config-label">
                      {t('ui.theme.lightModeStart')}
                      <span className="config-help">
                        {t('ui.theme.lightModeStartDescription')}
                      </span>
                    </label>
                    <input
                      type="time"
                      value={config.lightModeStart}
                      onChange={(e) => handleLightModeStartChange(e.target.value)}
                      className="config-input"
                    />
                  </div>

                  <div className="config-field">
                    <label className="config-label">
                      {t('ui.theme.darkModeStart')}
                      <span className="config-help">
                        {t('ui.theme.darkModeStartDescription')}
                      </span>
                    </label>
                    <input
                      type="time"
                      value={config.darkModeStart}
                      onChange={(e) => handleDarkModeStartChange(e.target.value)}
                      className="config-input"
                    />
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </CollapsibleSection>
  );
};
