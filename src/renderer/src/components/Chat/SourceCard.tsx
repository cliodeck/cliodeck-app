import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChatSource } from '../../stores/chatStore';
import './SourceCard.css';

interface SourceCardProps {
  source: ChatSource;
  index: number;
}

export const SourceCard: React.FC<SourceCardProps> = React.memo(({ source, index }) => {
  const { t } = useTranslation('common');
  const [isExpanded, setIsExpanded] = useState(false);

  const handleOpenPDF = async () => {
    try {
      const result = await window.electron.pdf.getDocument(source.documentId);
      if (result.success && result.document?.fileURL) {
        const openResult = await window.electron.shell.openPath(result.document.fileURL);
        if (!openResult.success) {
          console.error('Failed to open PDF:', openResult.error);
        }
      } else {
        console.error('Document not found:', source.documentId);
      }
    } catch (error) {
      console.error('Failed to open PDF:', error);
    }
  };

  const formatReference = () => {
    if (source.author && source.year) {
      return `${source.author} (${source.year})`;
    }
    return source.documentTitle;
  };

  const formatSimilarity = () => {
    return `${Math.round(source.similarity * 100)}%`;
  };

  return (
    <div className="source-card">
      <div className="source-header" onClick={() => setIsExpanded(!isExpanded)}>
        <div className="source-index">{t('chat.source')} {index}</div>
        <div className="source-info">
          <div className="source-title">{formatReference()}</div>
          <div className="source-meta">
            {t('chat.page')} {source.pageNumber} • {t('chat.similarity')} {formatSimilarity()}
          </div>
        </div>
        <button className="source-expand-btn">
          {isExpanded ? '▼' : '▶'}
        </button>
      </div>

      {isExpanded && (
        <div className="source-content">
          <div className="source-excerpt">
            <div className="excerpt-label">{t('chat.excerpt')}</div>
            <p className="excerpt-text">{source.chunkContent}</p>
          </div>
          <div className="source-actions">
            <button className="source-action-btn" onClick={handleOpenPDF}>
              📄 {t('chat.openPDF')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
