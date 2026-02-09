import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { marked } from 'marked';
import { ChatMessage, RAGExplanation } from '../../stores/chatStore';
import { useModeStore } from '../../stores/modeStore';
import { SourceCard } from './SourceCard';
import './MessageBubble.css';

interface MessageBubbleProps {
  message: ChatMessage;
  isStreaming?: boolean;
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({ message, isStreaming = false }) => {
  const { t, i18n } = useTranslation('common');
  const lang = (i18n.language?.substring(0, 2) as 'fr' | 'en') || 'fr';
  const isUser = message.role === 'user';
  const [showExplanation, setShowExplanation] = useState(false);
  const { modes } = useModeStore();

  // Find mode name for badge display
  const modeName = useMemo(() => {
    if (!message.modeId || message.modeId === 'default-assistant') return null;
    const mode = modes.find((m) => m.metadata.id === message.modeId);
    return mode?.metadata.name[lang] || message.modeId;
  }, [message.modeId, modes, lang]);

  // Parse markdown for assistant messages
  const htmlContent = useMemo(() => {
    if (isUser) return null;

    try {
      return marked.parse(message.content, {
        breaks: true,
        gfm: true,
      });
    } catch (error) {
      console.error('Markdown parsing error:', error);
      return message.content;
    }
  }, [message.content, isUser]);

  const formatTime = (date: Date) => {
    return new Intl.DateTimeFormat('fr-FR', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  };

  return (
    <div className={`message-bubble ${isUser ? 'user' : 'assistant'}`}>
      <div className="message-header">
        <span className="message-avatar">{isUser ? '👤' : '🤖'}</span>
        <span className="message-role">{isUser ? t('chat.you') : t('chat.assistant')}</span>
        <span className="message-time">{formatTime(message.timestamp)}</span>
        {isStreaming && <span className="streaming-indicator">●</span>}
        {!isUser && modeName && (
          <span className="message-mode-badge">{modeName}</span>
        )}
      </div>

      <div className="message-content">
        {isUser ? (
          <p>{message.content}</p>
        ) : (
          <div
            className="message-markdown"
            dangerouslySetInnerHTML={{ __html: htmlContent || message.content }}
          />
        )}
      </div>

      {/* Warning when RAG was not used (but not for error messages) */}
      {!isUser && message.ragUsed === false && !message.isError && (
        <div className="message-no-context-warning">
          <span className="warning-icon">⚠️</span>
          <span className="warning-text">{t('chat.noContextWarning')}</span>
        </div>
      )}

      {/* Sources */}
      {message.sources && message.sources.length > 0 && (
        <div className="message-sources">
          <div className="sources-header">
            <span className="sources-icon">📚</span>
            <span className="sources-title">{t('chat.sources')} ({message.sources.length})</span>
          </div>
          <div className="sources-list">
            {message.sources.map((source, index) => (
              <SourceCard key={index} source={source} index={index + 1} />
            ))}
          </div>
        </div>
      )}

      {/* RAG Explanation (Explainable AI) */}
      {!isUser && message.explanation && (
        <div className="message-explanation">
          <button
            className="explanation-toggle"
            onClick={() => setShowExplanation(!showExplanation)}
          >
            <span className="explanation-icon">🔍</span>
            <span className="explanation-title">
              {showExplanation ? t('chat.hideExplanation', 'Masquer les détails') : t('chat.showExplanation', 'Comment cette réponse a été générée')}
            </span>
            <span className={`explanation-chevron ${showExplanation ? 'open' : ''}`}>▼</span>
          </button>

          {showExplanation && (
            <div className="explanation-content">
              {/* Search section */}
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

              {/* Compression section */}
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

              {/* Graph section */}
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

              {/* LLM section */}
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

              {/* Timing section */}
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
    </div>
  );
};
