import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, ExternalLink, ChevronDown, ChevronRight } from 'lucide-react';
import './AboutModal.css';

interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface Dependency {
  name: string;
  license: string;
  url: string;
}

const dependencies: Dependency[] = [
  { name: '@milkdown/crepe', license: 'MIT', url: 'https://github.com/Milkdown/milkdown' },
  { name: '@milkdown/kit', license: 'MIT', url: 'https://github.com/Milkdown/milkdown' },
  { name: '@monaco-editor/react', license: 'MIT', url: 'https://github.com/suren-atoyan/monaco-react' },
  { name: 'better-sqlite3', license: 'MIT', url: 'https://github.com/WiseLibs/better-sqlite3' },
  { name: 'docx', license: 'MIT', url: 'https://docx.js.org' },
  { name: 'docxtemplater', license: 'MIT', url: 'https://github.com/open-xml-templating/docxtemplater' },
  { name: 'Electron', license: 'MIT', url: 'https://github.com/electron/electron' },
  { name: 'electron-store', license: 'MIT', url: 'https://github.com/sindresorhus/electron-store' },
  { name: 'graphology', license: 'MIT', url: 'https://github.com/graphology/graphology' },
  { name: 'graphology-communities-louvain', license: 'MIT', url: 'https://github.com/graphology/graphology' },
  { name: 'graphology-layout-forceatlas2', license: 'MIT', url: 'https://github.com/graphology/graphology' },
  { name: 'hnswlib-node', license: 'Apache-2.0', url: 'https://github.com/yoshoku/hnswlib-node' },
  { name: 'i18next', license: 'MIT', url: 'https://www.i18next.com' },
  { name: 'lru-cache', license: 'BlueOak-1.0.0', url: 'https://github.com/isaacs/node-lru-cache' },
  { name: 'Lucide', license: 'ISC', url: 'https://lucide.dev' },
  { name: 'marked', license: 'MIT', url: 'https://marked.js.org' },
  { name: 'natural', license: 'MIT', url: 'https://github.com/NaturalNode/natural' },
  { name: 'node-llama-cpp', license: 'MIT', url: 'https://node-llama-cpp.withcat.ai' },
  { name: 'pdf-poppler', license: 'ISC', url: 'https://github.com/kb47/pdf-poppler' },
  { name: 'pdfjs-dist', license: 'Apache-2.0', url: 'https://github.com/mozilla/pdfjs-dist' },
  { name: 'PizZip', license: 'MIT / GPL-3.0', url: 'https://github.com/open-xml-templating/pizzip' },
  { name: 'Puppeteer', license: 'Apache-2.0', url: 'https://github.com/puppeteer/puppeteer' },
  { name: 'React', license: 'MIT', url: 'https://reactjs.org' },
  { name: 'react-error-boundary', license: 'MIT', url: 'https://github.com/bvaughn/react-error-boundary' },
  { name: 'react-force-graph', license: 'MIT', url: 'https://github.com/vasturiano/react-force-graph' },
  { name: 'react-i18next', license: 'MIT', url: 'https://github.com/i18next/react-i18next' },
  { name: 'react-resizable-panels', license: 'MIT', url: 'https://github.com/bvaughn/react-resizable-panels' },
  { name: 'Recharts', license: 'MIT', url: 'https://github.com/recharts/recharts' },
  { name: 'Tesseract.js', license: 'Apache-2.0', url: 'https://github.com/naptha/tesseract.js' },
  { name: 'Zod', license: 'MIT', url: 'https://zod.dev' },
  { name: 'Zustand', license: 'MIT', url: 'https://github.com/pmndrs/zustand' },
];

const licenseGroups = dependencies.reduce<Record<string, Dependency[]>>((acc, dep) => {
  if (!acc[dep.license]) acc[dep.license] = [];
  acc[dep.license].push(dep);
  return acc;
}, {});

const licenseOrder = ['MIT', 'Apache-2.0', 'ISC', 'BlueOak-1.0.0', 'MIT / GPL-3.0'];

export const AboutModal: React.FC<AboutModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation('common');
  const [creditsOpen, setCreditsOpen] = useState(false);

  if (!isOpen) return null;

  const openExternalLink = (url: string) => {
    window.electron.shell.openExternal(url);
  };

  return (
    <div className="about-modal" onClick={onClose}>
      <div className="about-content" onClick={(e) => e.stopPropagation()}>
        <div className="about-header">
          <h3>{t('about.title')}</h3>
          <button className="close-btn" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="about-body">
          <div className="about-section">
            <p className="about-license">
              <strong>{t('about.license')}:</strong> AGPL{' '}
              <button
                className="about-link"
                onClick={() => openExternalLink('https://github.com/inactinique/cliodeck')}
              >
                {t('about.githubRepo')} <ExternalLink size={14} />
              </button>
            </p>
          </div>
          <div className="about-section">
            <p className="about-description">
              {t('about.description')}{' '}
              <button
                className="about-link"
                onClick={() => openExternalLink('https://inactinique.net')}
              >
                Frédéric Clavert <ExternalLink size={14} />
              </button>{' '}
              {t('about.developedWith')}
            </p>
          </div>
          <div className="about-section about-credits-section">
            <button
              className="about-credits-toggle"
              onClick={() => setCreditsOpen(!creditsOpen)}
            >
              {creditsOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <strong>{t('about.openSourceCredits')}</strong>
              <span className="about-credits-count">{dependencies.length} {t('about.libraries')}</span>
            </button>
            {creditsOpen && (
              <div className="about-credits-list">
                <p className="about-credits-intro">{t('about.creditsIntro')}</p>
                {licenseOrder.filter(l => licenseGroups[l]).map((license) => (
                  <div key={license} className="about-license-group">
                    <h4 className="about-license-group-title">{license}</h4>
                    <div className="about-deps-grid">
                      {licenseGroups[license].map((dep) => (
                        <button
                          key={dep.name}
                          className="about-dep-item"
                          onClick={() => openExternalLink(dep.url)}
                          title={dep.url}
                        >
                          {dep.name} <ExternalLink size={10} />
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
