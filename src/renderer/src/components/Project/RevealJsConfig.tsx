import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

const THEMES = [
  { value: 'black', label: 'Black (défaut)' },
  { value: 'white', label: 'White' },
  { value: 'league', label: 'League' },
  { value: 'beige', label: 'Beige' },
  { value: 'sky', label: 'Sky' },
  { value: 'night', label: 'Night' },
  { value: 'serif', label: 'Serif' },
  { value: 'simple', label: 'Simple' },
  { value: 'solarized', label: 'Solarized' },
  { value: 'blood', label: 'Blood' },
  { value: 'moon', label: 'Moon' },
];

const TRANSITIONS = [
  { value: 'slide', label: 'Slide (défaut)' },
  { value: 'none', label: 'Aucune' },
  { value: 'fade', label: 'Fondu' },
  { value: 'convex', label: 'Convexe' },
  { value: 'concave', label: 'Concave' },
  { value: 'zoom', label: 'Zoom' },
];

interface RevealConfig {
  theme: string;
  transition: string;
  controls: boolean;
  progress: boolean;
  slideNumber: boolean;
  history: boolean;
}

const DEFAULT_CONFIG: RevealConfig = {
  theme: 'black',
  transition: 'slide',
  controls: true,
  progress: true,
  slideNumber: false,
  history: true,
};

interface Props {
  projectPath: string;
}

export const RevealJsConfig: React.FC<Props> = ({ projectPath }) => {
  const { t } = useTranslation('common');
  const [config, setConfig] = useState<RevealConfig>(DEFAULT_CONFIG);

  useEffect(() => {
    (async () => {
      try {
        const path = `${projectPath}/reveal-config.json`;
        if (await window.electron.fs.exists(path)) {
          const raw = await window.electron.fs.readFile(path);
          setConfig({ ...DEFAULT_CONFIG, ...JSON.parse(raw) });
        }
      } catch { /* use defaults */ }
    })();
  }, [projectPath]);

  const save = async (next: RevealConfig) => {
    setConfig(next);
    try {
      await window.electron.fs.writeFile(
        `${projectPath}/reveal-config.json`,
        JSON.stringify(next, null, 2)
      );
    } catch (e) {
      console.error('Failed to save reveal-config.json', e);
    }
  };

  const set = (key: keyof RevealConfig, value: RevealConfig[keyof RevealConfig]) =>
    save({ ...config, [key]: value });

  const row = (label: string, children: React.ReactNode) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.6rem' }}>
      <label style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{label}</label>
      {children}
    </div>
  );

  const selectStyle: React.CSSProperties = {
    background: 'var(--bg-app)',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: '4px', padding: '3px 6px', fontSize: '0.82rem', minWidth: '130px',
  };

  return (
    <div style={{ padding: '0.5rem 0' }}>
      {row(t('revealjs.theme'), (
        <select style={selectStyle} value={config.theme} onChange={e => set('theme', e.target.value)}>
          {THEMES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      ))}

      {row(t('revealjs.transition'), (
        <select style={selectStyle} value={config.transition} onChange={e => set('transition', e.target.value)}>
          {TRANSITIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      ))}

      {[
        ['controls',    t('revealjs.controls')],
        ['progress',    t('revealjs.progress')],
        ['slideNumber', t('revealjs.slideNumber')],
        ['history',     t('revealjs.history')],
      ].map(([key, label]) => (
        <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '0.5rem' }}>
          <input
            type="checkbox"
            id={`rcfg-${key}`}
            checked={config[key as keyof RevealConfig] as boolean}
            onChange={e => set(key as keyof RevealConfig, e.target.checked)}
          />
          <label htmlFor={`rcfg-${key}`} style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            {label}
          </label>
        </div>
      ))}

      <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.75rem' }}>
        {t('revealjs.configHint')}
      </p>
    </div>
  );
};
