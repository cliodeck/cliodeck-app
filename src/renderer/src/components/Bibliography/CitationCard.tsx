import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Citation, useBibliographyStore } from '../../stores/bibliographyStore';
import { PDFSelectionDialog } from './PDFSelectionDialog';
import { CitationMetadataModal } from './CitationMetadataModal';
import { TagManager } from './TagManager';
import { useProjectStore } from '../../stores/projectStore';
import './CitationCard.css';

interface CitationCardProps {
  citation: Citation;
}

export const CitationCard: React.FC<CitationCardProps> = ({ citation }) => {
  const { t } = useTranslation('common');
  const [isExpanded, setIsExpanded] = useState(false);
  const [isIndexing, setIsIndexing] = useState(false);
  const [showPDFSelection, setShowPDFSelection] = useState(false);
  const [showMetadataModal, setShowMetadataModal] = useState(false);
  const { selectCitation, insertCitation, indexPDFFromCitation, reindexPDFFromCitation, downloadAndIndexZoteroPDF, updateCitationMetadata, getAllTags, indexedFilePaths, indexedBibtexKeys } = useBibliographyStore();
  const { currentProject } = useProjectStore();

  const hasPDF = !!citation.file;
  const hasZoteroPDFs = !!citation.zoteroAttachments && citation.zoteroAttachments.length > 0;
  const zoteroCount = citation.zoteroAttachments?.length || 0;
  // Check if indexed by file path OR by bibtexKey (for cases where PDFs were indexed separately)
  // Subscribe to the actual state (indexedFilePaths, indexedBibtexKeys) to trigger re-renders
  const isIndexedByFile = hasPDF && indexedFilePaths.has(citation.file!);
  const isIndexedByKey = indexedBibtexKeys.has(citation.id);
  const isIndexed = isIndexedByFile || isIndexedByKey;

  // Debug: log for first citation only
  if (citation.id === 'unesco_ai_2025') {
    console.log(`🔍 CitationCard[${citation.id}]: indexedBibtexKeys.size=${indexedBibtexKeys.size}, isIndexedByKey=${isIndexedByKey}, isIndexed=${isIndexed}`);
  }

  // Note: refreshIndexedPDFs is called once at the BibliographyPanel level,
  // no need to call it for each card

  const handleInsert = () => {
    insertCitation(citation.id);
  };

  const handleIndexPDF = async () => {
    if (isIndexing) return;

    // If already indexed, ask if user wants to re-index
    if (isIndexed) {
      const shouldReindex = window.confirm(t('bibliography.reindexConfirm', { title: citation.title }));
      if (!shouldReindex) return;

      setIsIndexing(true);
      try {
        await reindexPDFFromCitation(citation.id);
        alert(t('bibliography.pdfReindexed', { title: citation.title }));
      } catch (error) {
        alert(`${t('bibliography.indexError')} ${error}`);
      } finally {
        setIsIndexing(false);
      }
      return;
    }

    // Check if citation has local PDF
    if (hasPDF) {
      setIsIndexing(true);
      try {
        const result = await indexPDFFromCitation(citation.id);
        if (result.alreadyIndexed) {
          const shouldReindex = window.confirm(t('bibliography.reindexConfirm', { title: citation.title }));
          if (shouldReindex) {
            await reindexPDFFromCitation(citation.id);
            alert(t('bibliography.pdfReindexed', { title: citation.title }));
          }
        } else {
          alert(`${t('bibliography.pdfIndexed')} ${citation.title}`);
        }
      } catch (error) {
        alert(`${t('bibliography.indexError')} ${error}`);
      } finally {
        setIsIndexing(false);
      }
      return;
    }

    // If no local PDF but has Zotero PDFs, show selection dialog
    if (hasZoteroPDFs) {
      if (citation.zoteroAttachments!.length === 1) {
        // Only one PDF - download directly
        handleZoteroPDFSelection(citation.zoteroAttachments![0].key);
      } else {
        // Multiple PDFs - show selection dialog
        setShowPDFSelection(true);
      }
    }
  };

  const handleZoteroPDFSelection = async (attachmentKey: string) => {
    setShowPDFSelection(false);
    if (!currentProject?.path) {
      alert(t('bibliography.noProjectOpen'));
      return;
    }

    setIsIndexing(true);
    try {
      await downloadAndIndexZoteroPDF(citation.id, attachmentKey, currentProject.path);
      alert(t('bibliography.pdfDownloadedAndIndexed', { title: citation.title }));
    } catch (error) {
      alert(`${t('bibliography.downloadError')} ${error}`);
    } finally {
      setIsIndexing(false);
    }
  };

  return (
    <>
      <div className="citation-card" onClick={() => selectCitation(citation.id)}>
        <div className="citation-header" onClick={(e) => {
          e.stopPropagation();
          setIsExpanded(!isExpanded);
        }}>
          <div className="citation-main">
            <div className="citation-author">{citation.author}</div>
            <div className="citation-year">({citation.year})</div>
            {(hasPDF || isIndexedByKey) && (
              <span className="pdf-badge" title={isIndexed ? t('bibliography.indexed') : t('bibliography.notIndexed')}>
                {isIndexed ? '✅' : '📄'}
              </span>
            )}
            {hasZoteroPDFs && (
              <span
                className="zotero-pdf-badge"
                title={`${zoteroCount} PDF${zoteroCount > 1 ? 's' : ''} ${t('bibliography.availableInZotero')}`}
              >
                📎 {zoteroCount}
              </span>
            )}
          </div>
          <button className="expand-btn">
            {isExpanded ? '▼' : '▶'}
          </button>
        </div>

        <div className="citation-title">{citation.title}</div>

        {isExpanded && (
          <div className="citation-details">
            {citation.journal && (
              <div className="detail-item">
                <span className="detail-label">{t('bibliography.journal')}</span>
                <span className="detail-value">{citation.journal}</span>
              </div>
            )}
            {citation.publisher && (
              <div className="detail-item">
                <span className="detail-label">{t('bibliography.publisher')}</span>
                <span className="detail-value">{citation.publisher}</span>
              </div>
            )}
            {citation.booktitle && (
              <div className="detail-item">
                <span className="detail-label">{t('bibliography.booktitle')}</span>
                <span className="detail-value">{citation.booktitle}</span>
              </div>
            )}

            {citation.tags && citation.tags.length > 0 && (
              <div className="detail-item">
                <span className="detail-label">Tags:</span>
                <div className="detail-value">
                  <TagManager tags={citation.tags} onTagsChange={() => {}} allTags={[]} readOnly />
                </div>
              </div>
            )}

            {citation.notes && (
              <div className="detail-item">
                <span className="detail-label">Notes:</span>
                <span className="detail-value">{citation.notes}</span>
              </div>
            )}

            <div className="citation-actions">
              <button className="action-btn primary" onClick={handleInsert}>
                ✍️ {t('bibliography.insertCitation')}
              </button>
              {(hasPDF || hasZoteroPDFs || isIndexedByKey) && (
                <button
                  className={`action-btn ${isIndexed ? 'indexed' : 'secondary'}`}
                  onClick={handleIndexPDF}
                  disabled={isIndexing}
                >
                  {isIndexing ? '⏳' : isIndexed ? '🔄' : '🔍'}{' '}
                  {isIndexing
                    ? t('bibliography.indexing')
                    : isIndexed
                      ? t('bibliography.reindex')
                      : t('bibliography.indexPDFButton')}
                </button>
              )}
              <button
                className="action-btn secondary"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowMetadataModal(true);
                }}
              >
                🏷️ {t('bibliography.editMetadata')}
              </button>
            </div>
          </div>
        )}
      </div>

      {showPDFSelection && citation.zoteroAttachments && (
        <PDFSelectionDialog
          citationTitle={citation.title}
          attachments={citation.zoteroAttachments}
          onSelect={handleZoteroPDFSelection}
          onCancel={() => setShowPDFSelection(false)}
        />
      )}

      {showMetadataModal && (
        <CitationMetadataModal
          isOpen={showMetadataModal}
          onClose={() => setShowMetadataModal(false)}
          citation={citation}
          allTags={getAllTags()}
          onSave={(updatedCitation) => {
            updateCitationMetadata(citation.id, updatedCitation);
          }}
        />
      )}
    </>
  );
};
