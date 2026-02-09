import React, { useState, useEffect } from 'react';
import { Settings } from 'lucide-react';
import './PresentationConfig.css';

export interface RevealJsConfig {
  theme: 'black' | 'white' | 'league' | 'beige' | 'sky' | 'night' | 'serif' | 'simple' | 'solarized' | 'blood' | 'moon';
  transition: 'none' | 'fade' | 'slide' | 'convex' | 'concave' | 'zoom';
  controls: boolean;
  progress: boolean;
  slideNumber: boolean;
  showNotes: boolean;
  center: boolean;
  loop: boolean;
  autoSlide: number;
}

interface PresentationConfigProps {
  projectPath: string;
  onConfigChange?: (config: RevealJsConfig) => void;
}

const DEFAULT_CONFIG: RevealJsConfig = {
  theme: 'black',
  transition: 'slide',
  controls: true,
  progress: true,
  slideNumber: false,
  showNotes: false,
  center: true,
  loop: false,
  autoSlide: 0,
};

export const PresentationConfig: React.FC<PresentationConfigProps> = ({
  projectPath,
  onConfigChange,
}) => {
  const [config, setConfig] = useState<RevealJsConfig>(DEFAULT_CONFIG);
  const [isSaving, setIsSaving] = useState(false);

  // Load config from project
  useEffect(() => {
    loadConfig();
  }, [projectPath]);

  const loadConfig = async () => {
    try {
      const configPath = `${projectPath}/reveal-config.json`;
      const exists = await window.electron.fs.exists(configPath);

      if (exists) {
        const content = await window.electron.fs.readFile(configPath);
        const loadedConfig = JSON.parse(content);
        setConfig({ ...DEFAULT_CONFIG, ...loadedConfig });
      }
    } catch (error) {
      console.error('Failed to load presentation config:', error);
    }
  };

  const saveConfig = async (newConfig: RevealJsConfig) => {
    setIsSaving(true);
    try {
      const configPath = `${projectPath}/reveal-config.json`;
      await window.electron.fs.writeFile(configPath, JSON.stringify(newConfig, null, 2));
      setConfig(newConfig);
      onConfigChange?.(newConfig);
    } catch (error) {
      console.error('Failed to save presentation config:', error);
      alert('Erreur lors de la sauvegarde de la configuration');
    } finally {
      setIsSaving(false);
    }
  };

  const handleChange = (key: keyof RevealJsConfig, value: any) => {
    const newConfig = { ...config, [key]: value };
    saveConfig(newConfig);
  };

  return (
    <div className="presentation-config">
      <div className="config-header">
        <Settings size={18} />
        <h4>Configuration de la présentation</h4>
      </div>

      <div className="config-section">
        <label>Thème</label>
        <select
          value={config.theme}
          onChange={(e) => handleChange('theme', e.target.value)}
          disabled={isSaving}
        >
          <option value="black">Black (défaut)</option>
          <option value="white">White</option>
          <option value="league">League</option>
          <option value="beige">Beige</option>
          <option value="sky">Sky</option>
          <option value="night">Night</option>
          <option value="serif">Serif</option>
          <option value="simple">Simple</option>
          <option value="solarized">Solarized</option>
          <option value="blood">Blood</option>
          <option value="moon">Moon</option>
        </select>
      </div>

      <div className="config-section">
        <label>Transition</label>
        <select
          value={config.transition}
          onChange={(e) => handleChange('transition', e.target.value)}
          disabled={isSaving}
        >
          <option value="none">Aucune</option>
          <option value="fade">Fade</option>
          <option value="slide">Slide (défaut)</option>
          <option value="convex">Convex</option>
          <option value="concave">Concave</option>
          <option value="zoom">Zoom</option>
        </select>
      </div>

      <div className="config-section">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={config.controls}
            onChange={(e) => handleChange('controls', e.target.checked)}
            disabled={isSaving}
          />
          <span>Afficher les contrôles de navigation</span>
        </label>
      </div>

      <div className="config-section">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={config.progress}
            onChange={(e) => handleChange('progress', e.target.checked)}
            disabled={isSaving}
          />
          <span>Afficher la barre de progression</span>
        </label>
      </div>

      <div className="config-section">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={config.slideNumber}
            onChange={(e) => handleChange('slideNumber', e.target.checked)}
            disabled={isSaving}
          />
          <span>Afficher les numéros de slides</span>
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
          <span>Mode présentateur avec notes (touche S)</span>
        </label>
        <small className="config-hint">
          Activez cette option pour voir vos notes pendant la présentation
        </small>
      </div>

      <div className="config-section">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={config.center}
            onChange={(e) => handleChange('center', e.target.checked)}
            disabled={isSaving}
          />
          <span>Centrer les slides verticalement</span>
        </label>
      </div>

      <div className="config-section">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={config.loop}
            onChange={(e) => handleChange('loop', e.target.checked)}
            disabled={isSaving}
          />
          <span>Boucle infinie</span>
        </label>
      </div>

      <div className="config-section">
        <label>Défilement automatique (secondes)</label>
        <input
          type="number"
          min="0"
          step="1"
          value={config.autoSlide / 1000}
          onChange={(e) => handleChange('autoSlide', parseInt(e.target.value) * 1000)}
          disabled={isSaving}
          placeholder="0 = désactivé"
        />
        <small className="config-hint">
          0 = désactivé. Définissez le nombre de secondes entre chaque slide.
        </small>
      </div>

      {isSaving && (
        <div className="config-saving">
          Sauvegarde...
        </div>
      )}
    </div>
  );
};
