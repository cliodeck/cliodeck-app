import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import './PDFCard.css';

interface PDFDocument {
  id: string;
  title: string;
  author?: string;
  year?: string;
  bibtexKey?: string;
  pageCount: number;
  chunkCount?: number;
  indexedAt: Date;
}

interface PDFCardProps {
  document: PDFDocument;
  onDelete: (id: string) => void;
}

export const PDFCard: React.FC<PDFCardProps> = ({ document, onDelete }) => {
  const { t } = useTranslation('common');
  const [isExpanded, setIsExpanded] = useState(false);

  const formatDate = (date: Date) => {
    return new Intl.DateTimeFormat('fr-FR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(date));
  };

  // Format author similar to CitationCard
  const formatAuthor = () => {
    if (document.author) {
      return document.author;
    }
    return t('pdfIndex.unknownAuthor');
  };

  return (
    <div className="pdf-card">
      <div className="pdf-card-header" onClick={() => setIsExpanded(!isExpanded)}>
        <div className="pdf-header-main">
          <div className="pdf-author-year">
            <span className="pdf-author">{formatAuthor()}</span>
            {document.year && <span className="pdf-year">({document.year})</span>}
            {document.bibtexKey && (
              <span className="pdf-bibtex-badge" title={t('pdfIndex.bibtexKey')}>
                🔗 {document.bibtexKey}
              </span>
            )}
          </div>
          <button className="expand-btn">
            {isExpanded ? '▼' : '▶'}
          </button>
        </div>
      </div>

      <div className="pdf-title-preview">{document.title}</div>

      {isExpanded && (
        <div className="pdf-card-details">
          {/* Metadata */}
          <div className="pdf-detail-item">
            <span className="pdf-detail-label">{t('pdfIndex.pages')}:</span>
            <span className="pdf-detail-value">{document.pageCount}</span>
          </div>
          {document.chunkCount !== undefined && (
            <div className="pdf-detail-item">
              <span className="pdf-detail-label">{t('pdfIndex.chunks')}:</span>
              <span className="pdf-detail-value">{document.chunkCount}</span>
            </div>
          )}
          <div className="pdf-detail-item">
            <span className="pdf-detail-label">{t('pdfIndex.indexedAt')}:</span>
            <span className="pdf-detail-value">{formatDate(document.indexedAt)}</span>
          </div>

          <div className="pdf-actions">
            <button className="pdf-action-btn danger" onClick={() => onDelete(document.id)}>
              🗑️ {t('pdfIndex.delete')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
