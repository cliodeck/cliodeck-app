import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RAGExplanation } from '../../stores/chatStore';

/**
 * Shared Explainable-AI panel.
 *
 * Extracted from `RAGMessageExtras.tsx` so both the legacy RAG chat and
 * the Brainstorm chat can render the same collapsible "how was this
 * answer produced" block. The `RAGExplanation` shape is structurally
 * identical on both surfaces (mirrored in `backend/types/chat-source.ts`).
 */
export const ExplanationPanel: React.FC<{ explanation: RAGExplanation }> = ({
  explanation,
}) => {
  const { t } = useTranslation('common');
  const [showExplanation, setShowExplanation] = useState(false);

  return (
    <div className="message-explanation">
      <button
        className="explanation-toggle"
        onClick={() => setShowExplanation(!showExplanation)}
      >
        <span className="explanation-icon">🔍</span>
        <span className="explanation-title">
          {showExplanation
            ? t('chat.hideExplanation', 'Masquer les détails')
            : t('chat.showExplanation', 'Comment cette réponse a été générée')}
        </span>
        <span className={`explanation-chevron ${showExplanation ? 'open' : ''}`}>▼</span>
      </button>

      {showExplanation && (
        <div className="explanation-content">
          <div className="explanation-section">
            <h4>🔎 Recherche</h4>
            <ul>
              <li><strong>Résultats trouvés:</strong> {explanation.search.totalResults} chunks</li>
              <li><strong>Durée:</strong> {explanation.search.searchDurationMs}ms {explanation.search.cacheHit && '(cache)'}</li>
              <li><strong>Type de sources:</strong> {
                explanation.search.sourceType === 'primary' ? 'Archives (Tropy)' :
                explanation.search.sourceType === 'secondary' ? 'Bibliographie (PDFs)' : 'Toutes'
              }</li>
            </ul>
            {explanation.search.documents.length > 0 && (
              <details className="explanation-documents">
                <summary>Documents consultés ({explanation.search.documents.length})</summary>
                <ul>
                  {explanation.search.documents.map((doc, i) => (
                    <li key={i}>
                      <strong>{doc.title}</strong>
                      <span className="doc-meta"> ({doc.chunkCount} chunks, score: {(doc.similarity * 100).toFixed(1)}%)</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>

          {explanation.compression && (
            <div className="explanation-section">
              <h4>🗜️ Compression</h4>
              <ul>
                <li><strong>État:</strong> {explanation.compression.enabled ? 'Activée' : 'Désactivée'}</li>
                {explanation.compression.enabled && (
                  <>
                    <li><strong>Chunks:</strong> {explanation.compression.originalChunks} → {explanation.compression.finalChunks}</li>
                    <li><strong>Taille:</strong> {(explanation.compression.originalSize / 1000).toFixed(1)}k → {(explanation.compression.finalSize / 1000).toFixed(1)}k caractères</li>
                    <li><strong>Réduction:</strong> {explanation.compression.reductionPercent.toFixed(1)}%</li>
                    {explanation.compression.strategy && (
                      <li><strong>Stratégie:</strong> {explanation.compression.strategy}</li>
                    )}
                  </>
                )}
              </ul>
            </div>
          )}

          {explanation.graph?.enabled && (
            <div className="explanation-section">
              <h4>🔗 Graphe de connaissances</h4>
              <ul>
                <li><strong>Documents liés:</strong> {explanation.graph.relatedDocsFound}</li>
                {explanation.graph.documentTitles.length > 0 && (
                  <li><strong>Titres:</strong> {explanation.graph.documentTitles.join(', ')}</li>
                )}
              </ul>
            </div>
          )}

          <div className="explanation-section">
            <h4>🤖 Génération</h4>
            <ul>
              <li><strong>Fournisseur:</strong> {explanation.llm.provider}</li>
              <li><strong>Modèle:</strong> {explanation.llm.model}</li>
              <li><strong>Fenêtre de contexte:</strong> {explanation.llm.contextWindow} tokens</li>
              <li><strong>Température:</strong> {explanation.llm.temperature}</li>
              <li><strong>Taille du prompt:</strong> {(explanation.llm.promptSize / 1000).toFixed(1)}k caractères</li>
            </ul>
          </div>

          <div className="explanation-section">
            <h4>⏱️ Temps d'exécution</h4>
            <ul>
              <li><strong>Recherche:</strong> {explanation.timing.searchMs}ms</li>
              {explanation.timing.compressionMs && (
                <li><strong>Compression:</strong> {explanation.timing.compressionMs}ms</li>
              )}
              <li><strong>Génération:</strong> {explanation.timing.generationMs}ms</li>
              <li><strong>Total:</strong> {explanation.timing.totalMs}ms</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
};
