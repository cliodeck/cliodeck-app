import React, { useState } from 'react';
import { Bot, ChevronDown, Search, Shrink, Timer, Waypoints } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { RAGExplanation } from '../../stores/chatStore';

type CorpusSource = NonNullable<RAGExplanation['search']['corpora']>[number]['source'];

/**
 * Ordre d'affichage des corpus : les sources d'abord, le texte de l'auteur
 * ensuite — l'ordre du prompt. Rien n'est omis : un corpus à zéro ou non
 * interrogé se lit aussi (docs/poids-du-manuscrit.md).
 */
const CORPORA: ReadonlyArray<{ source: CorpusSource; key: string; fallback: string }> = [
  { source: 'secondary', key: 'chat.explanation.corpus.secondary', fallback: 'Bibliographie' },
  { source: 'primary', key: 'chat.explanation.corpus.primary', fallback: 'Archives' },
  { source: 'vault', key: 'chat.explanation.corpus.vault', fallback: 'Notes (vault)' },
  { source: 'manuscript', key: 'chat.explanation.corpus.manuscript', fallback: 'Manuscrit' },
  { source: 'readingNotes', key: 'chat.explanation.corpus.readingNotes', fallback: 'Notes de lecture' },
];

/** Milliers avec une décimale, comme les autres tailles du panneau. */
const kilo = (n: number): string => (n / 1000).toFixed(1);

/**
 * Shared Explainable-AI panel.
 *
 * Extracted early in the fusion so both chat shells (now unified in AssistantChat) and
 * the Brainstorm chat can render the same collapsible "how was this
 * answer produced" block. The `RAGExplanation` shape is structurally
 * identical on both surfaces (mirrored in `backend/types/chat-source.ts`).
 */
export const ExplanationPanel: React.FC<{ explanation: RAGExplanation }> = ({
  explanation,
}) => {
  const { t } = useTranslation('common');
  const [showExplanation, setShowExplanation] = useState(false);
  // Les deux champs manquent aux explications persistées avant leur ajout :
  // l'ancienne ligne « Type de sources » reste le repli.
  const { corpora, contextChars } = explanation.search;
  const manuscriptPercent =
    contextChars && contextChars.total > 0
      ? Math.round((contextChars.manuscript / contextChars.total) * 100)
      : 0;

  return (
    <div className="message-explanation">
      <button
        className="explanation-toggle"
        onClick={() => setShowExplanation(!showExplanation)}
      >
        <span className="explanation-icon"><Search size={14} /></span>
        <span className="explanation-title">
          {showExplanation
            ? t('chat.hideExplanation', 'Masquer les détails')
            : t('chat.showExplanation', 'Comment cette réponse a été générée')}
        </span>
        <span className={`explanation-chevron ${showExplanation ? 'open' : ''}`}><ChevronDown size={12} /></span>
      </button>

      {showExplanation && (
        <div className="explanation-content" data-testid="explanation-content">
          <div className="explanation-section">
            <h4><Search size={14} /> {t('chat.explanation.searchHeading', 'Recherche')}</h4>
            <ul>
              <li><strong>{t('chat.explanation.resultsFound', 'Résultats trouvés:')}</strong> {explanation.search.totalResults} {t('chat.explanation.chunks', 'chunks')}</li>
              <li><strong>{t('chat.explanation.duration', 'Durée:')}</strong> {explanation.search.searchDurationMs}ms {explanation.search.cacheHit && t('chat.explanation.cacheHitSuffix', '(cache)')}</li>
              {corpora ? (
                <li data-testid="explanation-corpora">
                  <strong>{t('chat.explanation.corporaLabel', 'Par corpus:')}</strong>{' '}
                  {CORPORA.map((c, i) => {
                    const entry = corpora.find((x) => x.source === c.source);
                    // Absent ou non tenté : non interrogé. Tenté mais en
                    // échec : un zéro ferait croire qu'il n'avait rien à dire.
                    const value =
                      !entry || !entry.attempted
                        ? t('chat.explanation.corpusNotSearched', 'non interrogé')
                        : entry.ok || entry.selectedCount > 0
                          ? String(entry.selectedCount)
                          : t('chat.explanation.corpusFailed', 'échec');
                    return (
                      <React.Fragment key={c.source}>
                        {i > 0 && ' · '}
                        <span data-testid={`explanation-corpus-${c.source}`}>
                          {t(c.key, c.fallback)} {value}
                        </span>
                      </React.Fragment>
                    );
                  })}
                </li>
              ) : (
                <li><strong>{t('chat.explanation.sourceTypeLabel', 'Type de sources:')}</strong> {
                  explanation.search.sourceType === 'primary' ? t('chat.explanation.sourceTypePrimary', 'Archives (Tropy)') :
                  explanation.search.sourceType === 'secondary' ? t('chat.explanation.sourceTypeSecondary', 'Bibliographie (PDFs)') : t('chat.explanation.sourceTypeAll', 'Toutes')
                }</li>
              )}
              {contextChars && (
                <li data-testid="explanation-context-chars">
                  <strong>{t('chat.explanation.contextLabel', 'Contexte:')}</strong>{' '}
                  {kilo(contextChars.total)}k {t('chat.explanation.chars', 'caractères')}
                  {contextChars.manuscript > 0 && (
                    <>
                      {', '}
                      {t('chat.explanation.contextManuscriptShare', 'dont manuscrit')}{' '}
                      {kilo(contextChars.manuscript)}k ({manuscriptPercent} %)
                    </>
                  )}
                </li>
              )}
            </ul>
            {explanation.search.documents.length > 0 && (
              <details className="explanation-documents">
                <summary>{t('chat.explanation.documentsConsulted', 'Documents consultés')} ({explanation.search.documents.length})</summary>
                <ul>
                  {explanation.search.documents.map((doc, i) => (
                    <li key={i}>
                      <strong>{doc.title}</strong>
                      <span className="doc-meta"> ({doc.chunkCount} {t('chat.explanation.chunks', 'chunks')}, {t('chat.explanation.score', 'score')}: {(doc.similarity * 100).toFixed(1)}%)</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>

          {explanation.compression && (
            <div className="explanation-section">
              <h4><Shrink size={14} /> {t('chat.explanation.compressionHeading', 'Compression')}</h4>
              <ul>
                <li><strong>{t('chat.explanation.state', 'État:')}</strong> {explanation.compression.enabled ? t('chat.explanation.enabled', 'Activée') : t('chat.explanation.disabled', 'Désactivée')}</li>
                {explanation.compression.enabled && (
                  <>
                    <li><strong>{t('chat.explanation.chunksLabel', 'Chunks:')}</strong> {explanation.compression.originalChunks} → {explanation.compression.finalChunks}</li>
                    <li><strong>{t('chat.explanation.size', 'Taille:')}</strong> {(explanation.compression.originalSize / 1000).toFixed(1)}k → {(explanation.compression.finalSize / 1000).toFixed(1)}k {t('chat.explanation.chars', 'caractères')}</li>
                    <li><strong>{t('chat.explanation.reduction', 'Réduction:')}</strong> {explanation.compression.reductionPercent.toFixed(1)}%</li>
                    {explanation.compression.strategy && (
                      <li><strong>{t('chat.explanation.strategy', 'Stratégie:')}</strong> {explanation.compression.strategy}</li>
                    )}
                  </>
                )}
              </ul>
            </div>
          )}

          {explanation.graph?.enabled && (
            <div className="explanation-section">
              <h4><Waypoints size={14} /> {t('chat.explanation.graphHeading', 'Graphe de connaissances')}</h4>
              <ul>
                <li><strong>{t('chat.explanation.relatedDocs', 'Documents liés:')}</strong> {explanation.graph.relatedDocsFound}</li>
                {explanation.graph.documentTitles.length > 0 && (
                  <li><strong>{t('chat.explanation.titles', 'Titres:')}</strong> {explanation.graph.documentTitles.join(', ')}</li>
                )}
              </ul>
            </div>
          )}

          <div className="explanation-section">
            <h4><Bot size={14} /> {t('chat.explanation.generationHeading', 'Génération')}</h4>
            <ul>
              <li><strong>{t('chat.explanation.provider', 'Fournisseur:')}</strong> {explanation.llm.provider}</li>
              <li><strong>{t('chat.explanation.model', 'Modèle:')}</strong> {explanation.llm.model}</li>
              <li><strong>{t('chat.explanation.contextWindow', 'Fenêtre de contexte:')}</strong> {explanation.llm.contextWindow} tokens</li>
              <li><strong>{t('chat.explanation.temperature', 'Température:')}</strong> {explanation.llm.temperature}</li>
              <li><strong>{t('chat.explanation.promptSize', 'Taille du prompt:')}</strong> {(explanation.llm.promptSize / 1000).toFixed(1)}k {t('chat.explanation.chars', 'caractères')}</li>
            </ul>
          </div>

          <div className="explanation-section">
            <h4><Timer size={14} /> {t('chat.explanation.timingHeading', 'Temps d\'exécution')}</h4>
            <ul>
              <li><strong>{t('chat.explanation.searchTime', 'Recherche:')}</strong> {explanation.timing.searchMs}ms</li>
              {explanation.timing.compressionMs && (
                <li><strong>{t('chat.explanation.compressionTime', 'Compression:')}</strong> {explanation.timing.compressionMs}ms</li>
              )}
              <li><strong>{t('chat.explanation.generationTime', 'Génération:')}</strong> {explanation.timing.generationMs}ms</li>
              <li><strong>{t('chat.explanation.totalTime', 'Total:')}</strong> {explanation.timing.totalMs}ms</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
};
