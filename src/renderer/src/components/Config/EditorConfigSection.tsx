import React from 'react';
import { useTranslation } from 'react-i18next';
import { CollapsibleSection } from '../common/CollapsibleSection';

export interface EditorConfig {
  fontSize: number;
  wordWrap: boolean;
  showMinimap: boolean;
  fontFamily: string;
  defaultEditorMode: 'wysiwyg' | 'source';
}

interface EditorConfigSectionProps {
  config: EditorConfig;
  onChange: (config: EditorConfig) => void;
}

export const EditorConfigSection: React.FC<EditorConfigSectionProps> = ({ config, onChange }) => {
  const { t } = useTranslation('common');

  const handleFieldChange = (field: keyof EditorConfig, value: any) => {
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
                Taille du texte dans l'éditeur Markdown (Monaco Editor)
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
              Taille actuelle: {config.fontSize}px
              <br />
              <small>S'applique uniquement à l'éditeur de texte principal</small>
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
                Les longues lignes sont automatiquement coupées pour rester visibles
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
                Barre de défilement avec aperçu miniature du document (comme dans VS Code)
              </span>
            </label>
          </div>

          {/* Font Family */}
          <div className="config-field">
            <label className="config-label">
              {t('editor.fontFamily')}
              <span className="config-help">
                Choisissez la police pour l'éditeur de code
              </span>
            </label>
            <select
              value={config.fontFamily}
              onChange={(e) => handleFieldChange('fontFamily', e.target.value)}
              className="config-select"
            >
              <option value="system">Polices système (SF Mono, Monaco, Consolas)</option>
              <option value="jetbrains">JetBrains Mono</option>
              <option value="fira">Fira Code</option>
              <option value="source">Source Code Pro</option>
              <option value="cascadia">Cascadia Code</option>
            </select>
            <div className="config-description">
              <small>
                Les polices système sont toujours disponibles. Les autres nécessitent d'être installées sur votre système.
              </small>
            </div>
          </div>

          {/* Default Editor Mode */}
          <div className="config-field">
            <label className="config-label">
              {t('editor.defaultEditorMode')}
              <span className="config-help">
                {t('editor.defaultEditorModeHelp')}
              </span>
            </label>
            <select
              value={config.defaultEditorMode || 'wysiwyg'}
              onChange={(e) => handleFieldChange('defaultEditorMode', e.target.value as 'wysiwyg' | 'source')}
              className="config-select"
            >
              <option value="wysiwyg">{t('editor.modeWysiwyg')}</option>
              <option value="source">{t('editor.modeSource')}</option>
            </select>
          </div>
        </div>
      </div>
    </CollapsibleSection>
  );
};
