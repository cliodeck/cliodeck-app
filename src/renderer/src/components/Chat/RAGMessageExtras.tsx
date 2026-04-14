import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChatMessage } from '../../stores/chatStore';
import { SourceCard } from './SourceCard';

/**
 * Extras rendered below a RAG assistant bubble: "no context" warning,
 * sources list, and the Explainable-AI panel. Extracted from the legacy
 * MessageBubble so the bubble itself can stay generic.
 */
export const RAGMessageExtras: React.FC<{ message: ChatMessage }> = ({ message }) => {
  const { t } = useTranslation('common');
  const [showExplanation, setShowExplanation] = useState(false);

  if (message.role === 'user') return null;

  return (
    <>
      {message.ragUsed === false && !message.isError && (
        <div className="message-no-context-warning">
          <span className="warning-icon">⚠️</span>
          <span className="warning-text">{t('chat.noContextWarning')}</span>
        </div>
      )}

      {message.sources && message.sources.length > 0 && (
        <div className="message-sources">
          <div className="sources-header">
            <span className="sources-icon">📚</span>
            <span className="sources-title">
              {t('chat.sources')} ({message.sources.length})
            </span>
          </div>
          <div className="sources-list">
            {message.sources.map((source, index) => (
              <SourceCard key={index} source={source} index={index + 1} />
            ))}
          </div>
        </div>
      )}

      {message.explanation && (
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
                  <li><strong>Résultats trouvés:</strong> {message.explanation.search.totalResults} chunks</li>
                  <li><strong>Durée:</strong> {message.explanation.search.searchDurationMs}ms {message.explanation.search.cacheHit && '(cache)'}</li>
                  <li><strong>Type de sources:</strong> {
                    message.explanation.search.sourceType === 'primary' ? 'Archives (Tropy)' :
                    message.explanation.search.sourceType === 'secondary' ? 'Bibliographie (PDFs)' : 'Toutes'
                  }</li>
                </ul>
                {message.explanation.search.documents.length > 0 && (
                  <details className="explanation-documents">
                    <summary>Documents consultés ({message.explanation.search.documents.length})</summary>
                    <ul>
                      {message.explanation.search.documents.map((doc, i) => (
                        <li key={i}>
                          <strong>{doc.title}</strong>
                          <span className="doc-meta"> ({doc.chunkCount} chunks, score: {(doc.similarity * 100).toFixed(1)}%)</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>

              {message.explanation.compression && (
                <div className="explanation-section">
                  <h4>🗜️ Compression</h4>
                  <ul>
                    <li><strong>État:</strong> {message.explanation.compression.enabled ? 'Activée' : 'Désactivée'}</li>
                    {message.explanation.compression.enabled && (
                      <>
                        <li><strong>Chunks:</strong> {message.explanation.compression.originalChunks} → {message.explanation.compression.finalChunks}</li>
                        <li><strong>Taille:</strong> {(message.explanation.compression.originalSize / 1000).toFixed(1)}k → {(message.explanation.compression.finalSize / 1000).toFixed(1)}k caractères</li>
                        <li><strong>Réduction:</strong> {message.explanation.compression.reductionPercent.toFixed(1)}%</li>
                        {message.explanation.compression.strategy && (
                          <li><strong>Stratégie:</strong> {message.explanation.compression.strategy}</li>
                        )}
                      </>
                    )}
                  </ul>
                </div>
              )}

              {message.explanation.graph?.enabled && (
                <div className="explanation-section">
                  <h4>🔗 Graphe de connaissances</h4>
                  <ul>
                    <li><strong>Documents liés:</strong> {message.explanation.graph.relatedDocsFound}</li>
                    {message.explanation.graph.documentTitles.length > 0 && (
                      <li><strong>Titres:</strong> {message.explanation.graph.documentTitles.join(', ')}</li>
                    )}
                  </ul>
                </div>
              )}

              <div className="explanation-section">
                <h4>🤖 Génération</h4>
                <ul>
                  <li><strong>Fournisseur:</strong> {message.explanation.llm.provider}</li>
                  <li><strong>Modèle:</strong> {message.explanation.llm.model}</li>
                  <li><strong>Fenêtre de contexte:</strong> {message.explanation.llm.contextWindow} tokens</li>
                  <li><strong>Température:</strong> {message.explanation.llm.temperature}</li>
                  <li><strong>Taille du prompt:</strong> {(message.explanation.llm.promptSize / 1000).toFixed(1)}k caractères</li>
                </ul>
              </div>

              <div className="explanation-section">
                <h4>⏱️ Temps d'exécution</h4>
                <ul>
                  <li><strong>Recherche:</strong> {message.explanation.timing.searchMs}ms</li>
                  {message.explanation.timing.compressionMs && (
                    <li><strong>Compression:</strong> {message.explanation.timing.compressionMs}ms</li>
                  )}
                  <li><strong>Génération:</strong> {message.explanation.timing.generationMs}ms</li>
                  <li><strong>Total:</strong> {message.explanation.timing.totalMs}ms</li>
                </ul>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
};
