import React from 'react';
import { useTranslation } from 'react-i18next';
import { CollapsibleSection } from '../common/CollapsibleSection';

export interface EditorConfig {
  fontSize: number;
  wordWrap: boolean;
  showMinimap: boolean;
  fontFamily: string;
}

interface EditorConfigSectionProps {
  config: EditorConfig;
  onChange: (config: EditorConfig) => void;
}

export const EditorConfigSection: React.FC<EditorConfigSectionProps> = ({ config, onChange }) => {
  const { t } = useTranslation('common');

  const handleFieldChange = (field: keyof EditorConfig, value: EditorConfig[keyof EditorConfig]) => {
    onChange({ ...config, [field]: value });
  };

  return (
    <CollapsibleSection title={t('editor.title')} defaultExpanded={false}>
      <div className="config-section">
        <div className="config-section-content">
          {/* Font Size */}
          <div className="config-field">
            <label className="config-label">
              {t('editor.fontSize')}
              <span className="config-help">
                {t('editor.fontSizeHelp')}
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="range"
                min="10"
                max="24"
                value={config.fontSize}
                onChange={(e) => handleFieldChange('fontSize', parseInt(e.target.value))}
                className="config-slider"
              />
              <input
                type="number"
                min="10"
                max="24"
                value={config.fontSize}
                onChange={(e) => handleFieldChange('fontSize', parseInt(e.target.value))}
                className="config-number"
              />
            </div>
            <div className="config-description">
              {t('editor.fontSizeCurrent', { size: config.fontSize })}
              <br />
              <small>{t('editor.fontSizeScope')}</small>
            </div>
          </div>

          {/* Word Wrap */}
          <div className="config-field">
            <label className="config-label">
              <input
                type="checkbox"
                checked={config.wordWrap}
                onChange={(e) => handleFieldChange('wordWrap', e.target.checked)}
                style={{ marginRight: '8px' }}
              />
              {t('editor.wordWrap')}
              <span className="config-help">
                {t('editor.wordWrapHelp')}
              </span>
            </label>
          </div>

          {/* Show Minimap */}
          <div className="config-field">
            <label className="config-label">
              <input
                type="checkbox"
                checked={config.showMinimap}
                onChange={(e) => handleFieldChange('showMinimap', e.target.checked)}
                style={{ marginRight: '8px' }}
              />
              {t('editor.minimap')}
              <span className="config-help">
                {t('editor.minimapHelp')}
              </span>
            </label>
          </div>

          {/* Font Family */}
          <div className="config-field">
            <label className="config-label">
              {t('editor.fontFamily')}
              <span className="config-help">
                {t('editor.fontFamilyHelp')}
              </span>
            </label>
            <select
              value={config.fontFamily}
              onChange={(e) => handleFieldChange('fontFamily', e.target.value)}
              className="config-select"
            >
              <optgroup label={t('editor.fontGroup.prose')}>
                <option value="serif">{t('editor.font.serif')}</option>
                <option value="sans">{t('editor.font.sans')}</option>
              </optgroup>
              <optgroup label={t('editor.fontGroup.mono')}>
                <option value="system">{t('editor.font.system')}</option>
                <option value="jetbrains">JetBrains Mono</option>
                <option value="fira">Fira Code</option>
                <option value="source">Source Code Pro</option>
                <option value="cascadia">Cascadia Code</option>
              </optgroup>
            </select>
            <div className="config-description">
              <small>
                {t('editor.fontAvailability')}
              </small>
            </div>
          </div>

        </div>
      </div>
    </CollapsibleSection>
  );
};
