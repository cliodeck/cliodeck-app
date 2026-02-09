import React, { useState, useEffect } from 'react';
import { Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import './BeamerConfig.css';

export interface BeamerConfigOptions {
  // Theme options
  theme: string;
  colortheme: string;
  fonttheme: string;
  aspectratio: string;
  navigation: boolean;
  showNotes: boolean;

  // Title page options
  institute?: string;
  logo?: string;
  titlegraphic?: string;

  // TOC options
  showToc: boolean;
  tocBeforeSection: boolean;

  // Frame numbering
  showFrameNumber: boolean;
  frameNumberStyle: 'total' | 'simple' | 'none';

  // Section numbering
  showSectionNumber: boolean;
  sectionNumberInToc: boolean;

  // Footer customization
  showAuthorInFooter: boolean;
  showTitleInFooter: boolean;
  showDateInFooter: boolean;

  // Advanced options
  incremental: boolean; // Incremental lists (reveal items one by one)
  overlays: boolean; // Enable pause/overlay commands
}

interface BeamerConfigProps {
  projectPath: string;
  onConfigChange?: (config: BeamerConfigOptions) => void;
}

const DEFAULT_CONFIG: BeamerConfigOptions = {
  // Theme options
  theme: 'Madrid',
  colortheme: 'default',
  fonttheme: 'default',
  aspectratio: '169',
  navigation: false,
  showNotes: false,

  // Title page options
  institute: '',
  logo: '',
  titlegraphic: '',

  // TOC options
  showToc: false,
  tocBeforeSection: false,

  // Frame numbering
  showFrameNumber: true,
  frameNumberStyle: 'total',

  // Section numbering
  showSectionNumber: false,
  sectionNumberInToc: false,

  // Footer customization
  showAuthorInFooter: false,
  showTitleInFooter: false,
  showDateInFooter: false,

  // Advanced options
  incremental: false,
  overlays: false,
};

// Beamer themes available
const THEMES = [
  { value: 'default', label: 'Default' },
  { value: 'AnnArbor', label: 'Ann Arbor' },
  { value: 'Antibes', label: 'Antibes' },
  { value: 'Bergen', label: 'Bergen' },
  { value: 'Berkeley', label: 'Berkeley' },
  { value: 'Berlin', label: 'Berlin' },
  { value: 'Boadilla', label: 'Boadilla' },
  { value: 'CambridgeUS', label: 'Cambridge US' },
  { value: 'Copenhagen', label: 'Copenhagen' },
  { value: 'Darmstadt', label: 'Darmstadt' },
  { value: 'Dresden', label: 'Dresden' },
  { value: 'Frankfurt', label: 'Frankfurt' },
  { value: 'Goettingen', label: 'Goettingen' },
  { value: 'Hannover', label: 'Hannover' },
  { value: 'Ilmenau', label: 'Ilmenau' },
  { value: 'JuanLesPins', label: 'Juan Les Pins' },
  { value: 'Luebeck', label: 'Luebeck' },
  { value: 'Madrid', label: 'Madrid (défaut)' },
  { value: 'Malmoe', label: 'Malmoe' },
  { value: 'Marburg', label: 'Marburg' },
  { value: 'Montpellier', label: 'Montpellier' },
  { value: 'PaloAlto', label: 'Palo Alto' },
  { value: 'Pittsburgh', label: 'Pittsburgh' },
  { value: 'Rochester', label: 'Rochester' },
  { value: 'Singapore', label: 'Singapore' },
  { value: 'Szeged', label: 'Szeged' },
  { value: 'Warsaw', label: 'Warsaw' },
];

const COLOR_THEMES = [
  { value: 'default', label: 'Default' },
  { value: 'albatross', label: 'Albatross' },
  { value: 'beaver', label: 'Beaver' },
  { value: 'beetle', label: 'Beetle' },
  { value: 'crane', label: 'Crane' },
  { value: 'dolphin', label: 'Dolphin' },
  { value: 'dove', label: 'Dove' },
  { value: 'fly', label: 'Fly' },
  { value: 'lily', label: 'Lily' },
  { value: 'orchid', label: 'Orchid' },
  { value: 'rose', label: 'Rose' },
  { value: 'seagull', label: 'Seagull' },
  { value: 'seahorse', label: 'Seahorse' },
  { value: 'whale', label: 'Whale' },
  { value: 'wolverine', label: 'Wolverine' },
];

const FONT_THEMES = [
  { value: 'default', label: 'Default' },
  { value: 'professionalfonts', label: 'Professional' },
  { value: 'serif', label: 'Serif' },
  { value: 'structurebold', label: 'Structure Bold' },
  { value: 'structureitalicserif', label: 'Structure Italic Serif' },
  { value: 'structuresmallcapsserif', label: 'Structure Small Caps Serif' },
];

export const BeamerConfig: React.FC<BeamerConfigProps> = ({
  projectPath,
  onConfigChange,
}) => {
  const { t } = useTranslation('common');
  const [config, setConfig] = useState<BeamerConfigOptions>(DEFAULT_CONFIG);
  const [isSaving, setIsSaving] = useState(false);

  // Load config from project
  useEffect(() => {
    loadConfig();
  }, [projectPath]);

  const loadConfig = async () => {
    try {
      const configPath = `${projectPath}/beamer-config.json`;
      const exists = await window.electron.fs.exists(configPath);

      if (exists) {
        const content = await window.electron.fs.readFile(configPath);
        const loadedConfig = JSON.parse(content);
        setConfig({ ...DEFAULT_CONFIG, ...loadedConfig });
      }
    } catch (error) {
      console.error('Failed to load Beamer config:', error);
    }
  };

  const saveConfig = async (newConfig: BeamerConfigOptions) => {
    setIsSaving(true);
    try {
      const configPath = `${projectPath}/beamer-config.json`;
      await window.electron.fs.writeFile(configPath, JSON.stringify(newConfig, null, 2));
      setConfig(newConfig);
      onConfigChange?.(newConfig);
    } catch (error) {
      console.error('Failed to save Beamer config:', error);
      alert(t('beamer.saveError'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleChange = (key: keyof BeamerConfigOptions, value: any) => {
    const newConfig = { ...config, [key]: value };
    saveConfig(newConfig);
  };

  const handleTextChange = (key: keyof BeamerConfigOptions, value: any) => {
    // For text inputs, only update local state without saving
    setConfig({ ...config, [key]: value });
  };

  const handleTextBlur = (_key: keyof BeamerConfigOptions) => {
    // Save when user leaves the text field
    saveConfig(config);
  };

  return (
    <div className="beamer-config">
      <div className="config-header">
        <Settings size={18} />
        <h4>{t('beamer.title')}</h4>
      </div>

      {/* Theme Section */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h5 style={{ margin: '0 0 0.75rem 0', color: '#ccc', fontSize: '0.9rem', fontWeight: 600 }}>{t('beamer.appearance')}</h5>

        <div className="config-section">
          <label>{t('beamer.mainTheme')}</label>
          <select
            value={config.theme}
            onChange={(e) => handleChange('theme', e.target.value)}
            disabled={isSaving}
          >
            {THEMES.map(theme => (
              <option key={theme.value} value={theme.value}>{theme.label}</option>
            ))}
          </select>
        </div>

        <div className="config-section">
          <label>{t('beamer.colorTheme')}</label>
          <select
            value={config.colortheme}
            onChange={(e) => handleChange('colortheme', e.target.value)}
            disabled={isSaving}
          >
            {COLOR_THEMES.map(theme => (
              <option key={theme.value} value={theme.value}>{theme.label}</option>
            ))}
          </select>
        </div>

        <div className="config-section">
          <label>{t('beamer.fontTheme')}</label>
          <select
            value={config.fonttheme}
            onChange={(e) => handleChange('fonttheme', e.target.value)}
            disabled={isSaving}
          >
            {FONT_THEMES.map(theme => (
              <option key={theme.value} value={theme.value}>{theme.label}</option>
            ))}
          </select>
        </div>

        <div className="config-section">
          <label>{t('beamer.aspectRatio')}</label>
          <select
            value={config.aspectratio}
            onChange={(e) => handleChange('aspectratio', e.target.value)}
            disabled={isSaving}
          >
            <option value="43">4:3 (Standard)</option>
            <option value="169">16:9 (Widescreen)</option>
            <option value="1610">16:10</option>
            <option value="149">14:9</option>
            <option value="141">1.41:1</option>
            <option value="54">5:4</option>
            <option value="32">3:2</option>
          </select>
        </div>
      </div>

      {/* Title Page Section */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h5 style={{ margin: '0 0 0.75rem 0', color: '#ccc', fontSize: '0.9rem', fontWeight: 600 }}>{t('beamer.titlePage')}</h5>

        <div className="config-section">
          <label>{t('beamer.institution')}</label>
          <input
            type="text"
            value={config.institute || ''}
            onChange={(e) => handleTextChange('institute', e.target.value)}
            onBlur={() => handleTextBlur('institute')}
            placeholder={t('beamer.institutionPlaceholder')}
            disabled={isSaving}
            style={{
              width: '100%',
              padding: '0.5rem 0.75rem',
              backgroundColor: '#1e1e1e',
              color: '#ccc',
              border: '1px solid #3e3e42',
              borderRadius: '4px',
              fontSize: 'var(--font-size-sm)'
            }}
          />
        </div>

        <div className="config-section">
          <label>{t('beamer.logo')}</label>
          <input
            type="text"
            value={config.logo || ''}
            onChange={(e) => handleTextChange('logo', e.target.value)}
            onBlur={() => handleTextBlur('logo')}
            placeholder={t('beamer.logoPlaceholder')}
            disabled={isSaving}
            style={{
              width: '100%',
              padding: '0.5rem 0.75rem',
              backgroundColor: '#1e1e1e',
              color: '#ccc',
              border: '1px solid #3e3e42',
              borderRadius: '4px',
              fontSize: 'var(--font-size-sm)'
            }}
          />
        </div>
      </div>

      {/* Table of Contents Section */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h5 style={{ margin: '0 0 0.75rem 0', color: '#ccc', fontSize: '0.9rem', fontWeight: 600 }}>{t('beamer.toc')}</h5>

        <div className="config-section">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={config.showToc}
              onChange={(e) => handleChange('showToc', e.target.checked)}
              disabled={isSaving}
            />
            <span>{t('beamer.showToc')}</span>
          </label>
        </div>

        <div className="config-section">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={config.tocBeforeSection}
              onChange={(e) => handleChange('tocBeforeSection', e.target.checked)}
              disabled={isSaving || !config.showToc}
            />
            <span>{t('beamer.tocBeforeSection')}</span>
          </label>
        </div>

        <div className="config-section">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={config.sectionNumberInToc}
              onChange={(e) => handleChange('sectionNumberInToc', e.target.checked)}
              disabled={isSaving || !config.showToc}
            />
            <span>{t('beamer.numberSectionsInToc')}</span>
          </label>
        </div>
      </div>

      {/* Numbering Section */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h5 style={{ margin: '0 0 0.75rem 0', color: '#ccc', fontSize: '0.9rem', fontWeight: 600 }}>{t('beamer.numbering')}</h5>

        <div className="config-section">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={config.showFrameNumber}
              onChange={(e) => handleChange('showFrameNumber', e.target.checked)}
              disabled={isSaving}
            />
            <span>{t('beamer.showFrameNumber')}</span>
          </label>
        </div>

        <div className="config-section">
          <label>{t('beamer.numberingStyle')}</label>
          <select
            value={config.frameNumberStyle}
            onChange={(e) => handleChange('frameNumberStyle', e.target.value)}
            disabled={isSaving || !config.showFrameNumber}
          >
            <option value="total">{t('beamer.numberingWithTotal')}</option>
            <option value="simple">{t('beamer.numberingSimple')}</option>
            <option value="none">{t('beamer.numberingNone')}</option>
          </select>
        </div>

        <div className="config-section">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={config.showSectionNumber}
              onChange={(e) => handleChange('showSectionNumber', e.target.checked)}
              disabled={isSaving}
            />
            <span>{t('beamer.numberSections')}</span>
          </label>
        </div>
      </div>

      {/* Footer Section */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h5 style={{ margin: '0 0 0.75rem 0', color: '#ccc', fontSize: '0.9rem', fontWeight: 600 }}>{t('beamer.footer')}</h5>

        <div className="config-section">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={config.showAuthorInFooter}
              onChange={(e) => handleChange('showAuthorInFooter', e.target.checked)}
              disabled={isSaving}
            />
            <span>{t('beamer.showAuthor')}</span>
          </label>
        </div>

        <div className="config-section">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={config.showTitleInFooter}
              onChange={(e) => handleChange('showTitleInFooter', e.target.checked)}
              disabled={isSaving}
            />
            <span>{t('beamer.showTitle')}</span>
          </label>
        </div>

        <div className="config-section">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={config.showDateInFooter}
              onChange={(e) => handleChange('showDateInFooter', e.target.checked)}
              disabled={isSaving}
            />
            <span>{t('beamer.showDate')}</span>
          </label>
        </div>
      </div>

      {/* Advanced Section */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h5 style={{ margin: '0 0 0.75rem 0', color: '#ccc', fontSize: '0.9rem', fontWeight: 600 }}>{t('beamer.advanced')}</h5>

        <div className="config-section">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={config.navigation}
              onChange={(e) => handleChange('navigation', e.target.checked)}
              disabled={isSaving}
            />
            <span>{t('beamer.showNavigation')}</span>
          </label>
        </div>

        <div className="config-section">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={config.showNotes}
              onChange={(e) => handleChange('showNotes', e.target.checked)}
              disabled={isSaving}
            />
            <span>{t('beamer.showNotes')}</span>
          </label>
        </div>

        <div className="config-section">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={config.incremental}
              onChange={(e) => handleChange('incremental', e.target.checked)}
              disabled={isSaving}
            />
            <span>{t('beamer.incrementalLists')}</span>
          </label>
        </div>

        <div className="config-section">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={config.overlays}
              onChange={(e) => handleChange('overlays', e.target.checked)}
              disabled={isSaving}
            />
            <span>{t('beamer.overlays')}</span>
          </label>
        </div>
      </div>

      {isSaving && (
        <div className="config-saving">
          {t('beamer.saving')}
        </div>
      )}

      <div className="config-info">
        <p><strong>{t('beamer.guide')} :</strong></p>

        <p style={{ marginTop: '0.75rem', fontWeight: 600 }}>{t('beamer.guideThemes')}</p>
        <ul>
          <li>{t('beamer.guideThemesDesc1')}</li>
          <li>{t('beamer.guideThemesDesc2')}</li>
          <li>{t('beamer.guideThemesDesc3')}</li>
          <li>{t('beamer.guideThemesDesc4')}</li>
        </ul>

        <p style={{ marginTop: '0.75rem', fontWeight: 600 }}>{t('beamer.guideLogo')}</p>
        <ul>
          <li>{t('beamer.guideLogoDesc1')}</li>
          <li>{t('beamer.guideLogoDesc2')}</li>
          <li>{t('beamer.guideLogoDesc3')}</li>
        </ul>

        <p style={{ marginTop: '0.75rem', fontWeight: 600 }}>{t('beamer.guideToc')}</p>
        <ul>
          <li>{t('beamer.guideTocDesc1')}</li>
          <li>{t('beamer.guideTocDesc2')}</li>
          <li>{t('beamer.guideTocDesc3')}</li>
        </ul>

        <p style={{ marginTop: '0.75rem', fontWeight: 600 }}>{t('beamer.guideAdvanced')}</p>
        <ul>
          <li>{t('beamer.guideAdvancedDesc1')}</li>
          <li>{t('beamer.guideAdvancedDesc2')}</li>
          <li>{t('beamer.guideAdvancedDesc3')}</li>
        </ul>
      </div>
    </div>
  );
};
