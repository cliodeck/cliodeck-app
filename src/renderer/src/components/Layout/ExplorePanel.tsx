/**
 * ExplorePanel — center surface for the `explore` workspace mode.
 *
 * Aggregates analytical components (CorpusExplorer, Similarity,
 * Textometrics) behind simple tabs so historians have one place to go when
 * they want to know their corpus before brainstorming. No new analytics
 * are introduced here — this is pure routing / composition.
 */

import React, { Suspense, lazy, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Network, GitCompareArrows, BarChart3 } from 'lucide-react';
import { PanelLoadingFallback } from '../common/PanelLoadingFallback';
import { useSimilarityStore } from '../../stores/similarityStore';
import './ExplorePanel.css';

const CorpusExplorerPanel = lazy(() =>
  import('../Corpus/CorpusExplorerPanel').then((m) => ({ default: m.CorpusExplorerPanel })),
);
const TextometricsPanel = lazy(() =>
  import('../Corpus/TextometricsPanel').then((m) => ({ default: m.TextometricsPanel })),
);
const SimilarityPanel = lazy(() =>
  import('../Similarity/SimilarityPanel').then((m) => ({ default: m.SimilarityPanel })),
);

type ExploreTab = 'corpus' | 'similarity' | 'textometrics';

export const ExplorePanel: React.FC = () => {
  const { t } = useTranslation('common');
  const [tab, setTab] = useState<ExploreTab>('corpus');
  const openSimilarity = useSimilarityStore((s) => s.openPanel);
  const isSimilarityOpen = useSimilarityStore((s) => s.isPanelOpen);

  // SimilarityPanel returns null unless `isPanelOpen` is true — nudge the
  // store open whenever the user lands on that tab so the surface is visible.
  useEffect(() => {
    if (tab === 'similarity' && !isSimilarityOpen) {
      openSimilarity();
    }
  }, [tab, isSimilarityOpen, openSimilarity]);

  const tabs: { id: ExploreTab; icon: React.ReactNode; label: string }[] = [
    { id: 'corpus', icon: <Network size={16} />, label: t('explore.tabs.corpus') },
    { id: 'similarity', icon: <GitCompareArrows size={16} />, label: t('explore.tabs.similarity') },
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
          {tab === 'similarity' && <SimilarityPanel />}
          {tab === 'textometrics' && <TextometricsPanel />}
        </Suspense>
      </div>
    </div>
  );
};
