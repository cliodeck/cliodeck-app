/**
 * Similarity Card
 *
 * Displays a single source recommendation with actions.
 * Supports both secondary sources (PDFs) and primary sources (Tropy).
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Quote, ChevronDown, ChevronUp, BookOpen, Archive } from 'lucide-react';
import { useEditorStore } from '../../stores/editorStore';
import { logger } from '../../utils/logger';
import type { PDFRecommendation } from '../../stores/similarityStore';
import './SimilarityCard.css';

interface SimilarityCardProps {
  recommendation: PDFRecommendation;
}

export const SimilarityCard: React.FC<SimilarityCardProps> = ({ recommendation }) => {
  const { t } = useTranslation('common');
  const { insertTextAtCursor } = useEditorStore();
  const [showPreview, setShowPreview] = useState(false);

  const {
    pdfId,
    title,
    authors,
    similarity,
    chunkPreview,
    zoteroKey,
    pageNumber,
    sourceType,
    sourceId,
    archive,
    date,
  } = recommendation;

  // Determine if this is a primary source
  const isPrimarySource = sourceType === 'primary';

  // Format similarity as percentage
  const similarityPercent = Math.round(similarity * 100);

  // Get similarity color class
  const getSimilarityClass = () => {
    if (similarityPercent >= 80) return 'similarity-high';
    if (similarityPercent >= 60) return 'similarity-medium';
    return 'similarity-low';
  };

  // Open source (PDF or primary source info)
  const handleOpenSource = async () => {
    if (isPrimarySource) {
      // For primary sources, show the source details
      logger.component('SimilarityCard', 'Opening primary source', { sourceId, title });
      try {
        const result = await window.electron.tropy.getSource(sourceId || '');
        if (result.success && result.source) {
          // For now, just log the source info - could open a modal in the future
          console.log('Primary source:', result.source);
          // If the source has photos, we could open them
          if (result.source.photos && result.source.photos.length > 0) {
            const firstPhoto = result.source.photos[0];
            if (firstPhoto.path) {
              await window.electron.shell.openPath(firstPhoto.path);
            }
          }
        }
      } catch (error) {
        logger.error('SimilarityCard', 'Failed to open primary source', error);
      }
    } else {
      // For secondary sources (PDFs)
      logger.component('SimilarityCard', 'Opening PDF', { pdfId, title });
      try {
        // Get document to find file path
        const result = await window.electron.pdf.getDocument(pdfId);
        if (result.success && result.document?.fileURL) {
          // Open the PDF file with the system default application
          await window.electron.shell.openPath(result.document.fileURL);
          logger.component('SimilarityCard', 'PDF opened', { path: result.document.fileURL });
        } else {
          logger.error('SimilarityCard', 'Document not found or no file path', { pdfId });
          alert(`Could not find PDF file for: ${title}`);
        }
      } catch (error) {
        logger.error('SimilarityCard', 'Failed to open PDF', error);
        alert(`Failed to open PDF: ${title}`);
      }
    }
  };

  // Insert citation at cursor
  const handleInsertCitation = () => {
    logger.component('SimilarityCard', 'Inserting citation', { zoteroKey, title });

    let citation: string;
    if (zoteroKey) {
      // Use Pandoc/CSL citation format
      citation = `[@${zoteroKey}]`;
    } else {
      // Fallback: use title
      const shortTitle = title.length > 30 ? title.substring(0, 30) + '...' : title;
      citation = `[${shortTitle}]`;
    }

    insertTextAtCursor(citation);
  };

  return (
    <div className={`similarity-card ${isPrimarySource ? 'primary-source' : 'secondary-source'}`}>
      {/* Source type badge */}
      <div className={`similarity-card-badge ${isPrimarySource ? 'badge-primary' : 'badge-secondary'}`}>
        {isPrimarySource ? (
          <>
            <Archive size={12} />
            <span>{t('similarity.badge.primary', 'Primary')}</span>
          </>
        ) : (
          <>
            <BookOpen size={12} />
            <span>{t('similarity.badge.secondary', 'Secondary')}</span>
          </>
        )}
      </div>

      {/* Header with title and similarity score */}
      <div className="similarity-card-header">
        <div className="similarity-card-info">
          <div className="similarity-card-title" title={title}>
            {title}
          </div>
          {authors && authors.length > 0 && (
            <div className="similarity-card-authors">
              {authors.join(', ')}
            </div>
          )}
          {/* Primary source specific info */}
          {isPrimarySource && (archive || date) && (
            <div className="similarity-card-meta">
              {archive && <span className="similarity-card-archive">{archive}</span>}
              {date && <span className="similarity-card-date">{date}</span>}
            </div>
          )}
        </div>
        <div className={`similarity-card-score ${getSimilarityClass()}`}>
          {similarityPercent}%
        </div>
      </div>

      {/* Preview toggle */}
      {chunkPreview && (
        <button
          className="similarity-card-preview-toggle"
          onClick={() => setShowPreview(!showPreview)}
        >
          {showPreview ? (
            <>
              <ChevronUp size={14} />
              {t('similarity.hidePreview')}
            </>
          ) : (
            <>
              <ChevronDown size={14} />
              {t('similarity.showPreview')}
            </>
          )}
        </button>
      )}

      {/* Preview content */}
      {showPreview && chunkPreview && (
        <div className="similarity-card-preview">
          <p className="similarity-card-preview-text">{chunkPreview}</p>
          {pageNumber && (
            <span className="similarity-card-page">
              {t('similarity.page', { page: pageNumber })}
            </span>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="similarity-card-actions">
        <button
          className="similarity-card-action"
          onClick={handleOpenSource}
          title={isPrimarySource ? t('similarity.openSource', 'Open Source') : t('similarity.openPDF')}
        >
          <ExternalLink size={14} />
          {isPrimarySource ? t('similarity.openSource', 'Open') : t('similarity.openPDF')}
        </button>
        <button
          className="similarity-card-action"
          onClick={handleInsertCitation}
          title={t('similarity.insertCitation')}
        >
          <Quote size={14} />
          {t('similarity.insertCitation')}
        </button>
      </div>
    </div>
  );
};
