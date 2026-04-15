/**
 * AnalyzePanel — center surface for the `analyze` workspace mode.
 *
 * Aggregates existing analytical components (CorpusExplorer, Similarity,
 * Textometrics) behind simple tabs so historians have one place to go when
 * they flip the mode to "Analyser". No new analytics are introduced here —
 * this is pure routing / composition.
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Network, GitCompareArrows, BarChart3 } from 'lucide-react';
import { CorpusExplorerPanel } from '../Corpus/CorpusExplorerPanel';
import { TextometricsPanel } from '../Corpus/TextometricsPanel';
import { SimilarityPanel } from '../Similarity/SimilarityPanel';
import { useSimilarityStore } from '../../stores/similarityStore';
import './AnalyzePanel.css';

type AnalyzeTab = 'corpus' | 'similarity' | 'textometrics';

export const AnalyzePanel: React.FC = () => {
  const { t } = useTranslation('common');
  const [tab, setTab] = useState<AnalyzeTab>('corpus');
  const openSimilarity = useSimilarityStore((s) => s.openPanel);
  const isSimilarityOpen = useSimilarityStore((s) => s.isPanelOpen);

  // SimilarityPanel returns null unless `isPanelOpen` is true — nudge the
  // store open whenever the user lands on that tab so the surface is visible.
  useEffect(() => {
    if (tab === 'similarity' && !isSimilarityOpen) {
      openSimilarity();
    }
  }, [tab, isSimilarityOpen, openSimilarity]);

  const tabs: { id: AnalyzeTab; icon: React.ReactNode; label: string }[] = [
    { id: 'corpus', icon: <Network size={16} />, label: t('analyze.tabs.corpus') },
    { id: 'similarity', icon: <GitCompareArrows size={16} />, label: t('analyze.tabs.similarity') },
    { id: 'textometrics', icon: <BarChart3 size={16} />, label: t('analyze.tabs.textometrics') },
  ];

  return (
    <div className="analyze-panel">
      <header className="analyze-panel__header">
        <h2 className="analyze-panel__title">{t('analyze.title')}</h2>
        <p className="analyze-panel__subtitle">{t('analyze.subtitle')}</p>
      </header>

      <div className="analyze-panel__tabs" role="tablist">
        {tabs.map(({ id, icon, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`analyze-panel__tab${tab === id ? ' analyze-panel__tab--active' : ''}`}
            onClick={() => setTab(id)}
          >
            {icon}
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div className="analyze-panel__body" role="tabpanel">
        {tab === 'corpus' && <CorpusExplorerPanel />}
        {tab === 'similarity' && <SimilarityPanel />}
        {tab === 'textometrics' && <TextometricsPanel />}
      </div>
    </div>
  );
};
