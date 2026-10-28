/**
 * ExplorePanel — center surface for the `explore` workspace mode.
 *
 * Aggregates analytical components (CorpusExplorer, Textometrics) behind
 * simple tabs so historians have one place to go when they want to know
 * their corpus before brainstorming. No new analytics are introduced here —
 * this is pure routing / composition.
 *
 * Similarity is NOT here: it compares the text being written with the
 * corpus, so it belongs to the Write workspace (editor toolbar), where it
 * already lives. A second entry point under Explore showed an empty panel
 * without an open document (removed 2026-10-28).
 */

import React, { Suspense, lazy, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Network, BarChart3 } from 'lucide-react';
import { PanelLoadingFallback } from '../common/PanelLoadingFallback';
import './ExplorePanel.css';

const CorpusExplorerPanel = lazy(() =>
  import('../Corpus/CorpusExplorerPanel').then((m) => ({ default: m.CorpusExplorerPanel })),
);
const TextometricsPanel = lazy(() =>
  import('../Corpus/TextometricsPanel').then((m) => ({ default: m.TextometricsPanel })),
);
type ExploreTab = 'corpus' | 'textometrics';

export const ExplorePanel: React.FC = () => {
  const { t } = useTranslation('common');
  const [tab, setTab] = useState<ExploreTab>('corpus');

  const tabs: { id: ExploreTab; icon: React.ReactNode; label: string }[] = [
    { id: 'corpus', icon: <Network size={16} />, label: t('explore.tabs.corpus') },
    { id: 'textometrics', icon: <BarChart3 size={16} />, label: t('explore.tabs.textometrics') },
  ];

  return (
    <div className="explore-panel">
      <header className="explore-panel__header">
        <h2 className="explore-panel__title">{t('explore.title')}</h2>
        <p className="explore-panel__subtitle">{t('explore.subtitle')}</p>
      </header>

      <div className="explore-panel__tabs" role="tablist">
        {tabs.map(({ id, icon, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`explore-panel__tab${tab === id ? ' explore-panel__tab--active' : ''}`}
            onClick={() => setTab(id)}
          >
            {icon}
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div className="explore-panel__body" role="tabpanel">
        <Suspense fallback={<PanelLoadingFallback />}>
          {tab === 'corpus' && <CorpusExplorerPanel />}
          {tab === 'textometrics' && <TextometricsPanel />}
        </Suspense>
      </div>
    </div>
  );
};
