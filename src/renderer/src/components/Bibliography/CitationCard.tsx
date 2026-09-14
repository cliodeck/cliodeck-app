import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import { Citation, useBibliographyStore } from '../../stores/bibliographyStore';
import { PDFSelectionDialog } from './PDFSelectionDialog';
import { TagManager } from './TagManager';
import { useProjectStore } from '../../stores/projectStore';
import { useDialogStore } from '../../stores/dialogStore';
import { useEditorStore } from '../../stores/editorStore';
import {
  hiddenAutomaticCount,
  projectTagsOf,
  readingNoteOf,
  sourceTagsOf,
} from '../../stores/bibliography/referenceTags';
import './CitationCard.css';

interface CitationCardProps {
  citation: Citation;
}

export const CitationCard: React.FC<CitationCardProps> = React.memo(({ citation }) => {
  const { t } = useTranslation('common');
  const [isExpanded, setIsExpanded] = useState(false);
  const [isIndexing, setIsIndexing] = useState(false);
  const [showPDFSelection, setShowPDFSelection] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);
  const {
    selectCitation,
    insertCitation,
    indexPDFFromCitation,
    reindexPDFFromCitation,
    downloadAndIndexZoteroPDF,
    indexedFilePaths,
    indexedBibtexKeys,
    readingNotes,
    showAutomaticZoteroTags,
    setShowAutomaticZoteroTags,
    setProjectTags,
    openReadingNote,
  } = useBibliographyStore();
  const loadFile = useEditorStore((state) => state.loadFile);
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

  // Ce qui appartient à Zotero (lecture seule) et ce qui appartient au projet.
  const sourceTags = sourceTagsOf(citation, showAutomaticZoteroTags);
  const hiddenAutomatic = hiddenAutomaticCount(citation, showAutomaticZoteroTags);
  const hasAutomaticTags = (citation.zoteroTags ?? []).some((tag) => tag.automatic);
  const projectTags = projectTagsOf(citation, readingNotes);
  const hasReadingNote = !!readingNoteOf(citation, readingNotes);
  const allProjectTags = [...new Set(readingNotes.flatMap((note) => note.tags))].sort((a, b) => a.localeCompare(b));

  const handleProjectTagsChange = async (tags: string[]) => {
    try {
      await setProjectTags(citation.id, tags);
    } catch (error) {
      await useDialogStore.getState().showAlert(
        t('bibliography.readingNoteError', { error: error instanceof Error ? error.message : String(error) })
      );
    }
  };

  /** Ouvre la note de lecture dans l'éditeur, en la créant au besoin. */
  const handleOpenReadingNote = async () => {
    try {
      const file = await openReadingNote(citation.id);
      if (file) await loadFile(file);
    } catch (error) {
      await useDialogStore.getState().showAlert(
        t('bibliography.readingNoteError', { error: error instanceof Error ? error.message : String(error) })
      );
    }
  };

  const handleIndexPDF = async () => {
    if (isIndexing) return;

    // If already indexed, ask if user wants to re-index
    if (isIndexed) {
      const shouldReindex = await useDialogStore.getState().showConfirm(t('bibliography.reindexConfirm', { title: citation.title }));
      if (!shouldReindex) return;

      setIsIndexing(true);
      try {
        await reindexPDFFromCitation(citation.id);
        await useDialogStore.getState().showAlert(t('bibliography.pdfReindexed', { title: citation.title }));
      } catch (error) {
        await useDialogStore.getState().showAlert(`${t('bibliography.indexError')} ${error}`);
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
          const shouldReindex = await useDialogStore.getState().showConfirm(t('bibliography.reindexConfirm', { title: citation.title }));
          if (shouldReindex) {
            await reindexPDFFromCitation(citation.id);
            await useDialogStore.getState().showAlert(t('bibliography.pdfReindexed', { title: citation.title }));
          }
        } else {
          await useDialogStore.getState().showAlert(`${t('bibliography.pdfIndexed')} ${citation.title}`);
        }
      } catch (error) {
        await useDialogStore.getState().showAlert(`${t('bibliography.indexError')} ${error}`);
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
      await useDialogStore.getState().showAlert(t('bibliography.noProjectOpen'));
      return;
    }

    setIsIndexing(true);
    try {
      await downloadAndIndexZoteroPDF(citation.id, attachmentKey, currentProject.path);
      await useDialogStore.getState().showAlert(t('bibliography.pdfDownloadedAndIndexed', { title: citation.title }));
    } catch (error) {
      await useDialogStore.getState().showAlert(`${t('bibliography.downloadError')} ${error}`);
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
            {/* Un ouvrage dirigé n'a pas d'auteur : c'est son directeur
                qui le désigne, et le titre s'il n'y a ni l'un ni l'autre.
                Une ligne vide laissait la fiche sans identité. */}
            <div className="citation-author">
              {citation.author || citation.editor || citation.title}
            </div>
            {citation.year && <div className="citation-year">({citation.year})</div>}
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
            {/* La clé qu'on écrit dans le texte (`[@clé]`). Discrète, mais
                visible : l'app la fabrique, et elle peut changer quand une
                clé invalide est refaite à la synchronisation. */}
            <div className="detail-item">
              <span className="detail-label">{t('bibliography.citeKey')}</span>
              <span className="detail-value citation-key">
                <code>@{citation.id}</code>
                <button
                  type="button"
                  className="citation-key-copy"
                  title={keyCopied ? t('bibliography.keyCopied') : t('bibliography.copyKey')}
                  aria-label={t('bibliography.copyKey')}
                  onClick={(e) => {
                    e.stopPropagation();
                    void navigator.clipboard.writeText(citation.id).then(() => {
                      setKeyCopied(true);
                      setTimeout(() => setKeyCopied(false), 1500);
                    });
                  }}
                >
                  {keyCopied ? <Check size={11} /> : <Copy size={11} />}
                </button>
              </span>
            </div>
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

            {/* Tags de Zotero (ou du fichier) : lecture seule. Les
                automatiques sont masqués par défaut. */}
            {(sourceTags.length > 0 || hiddenAutomatic > 0) && (
              <div className="detail-item">
                <span className="detail-label">
                  {citation.zoteroTags ? t('bibliography.zoteroTags') : t('bibliography.fileTags')}
                </span>
                <div className="detail-value citation-source-tags">
                  {sourceTags.length > 0 && (
                    <TagManager tags={sourceTags} onTagsChange={() => {}} allTags={[]} readOnly />
                  )}
                  {hasAutomaticTags && (
                    <button
                      type="button"
                      className="automatic-tags-toggle"
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowAutomaticZoteroTags(!showAutomaticZoteroTags);
                      }}
                    >
                      {showAutomaticZoteroTags
                        ? t('bibliography.hideAutomaticTags')
                        : t('bibliography.automaticTagsHidden', { count: hiddenAutomatic })}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Étiquettes du projet : écrites dans la note de lecture. */}
            <div className="detail-item" onClick={(e) => e.stopPropagation()}>
              <span className="detail-label">{t('bibliography.projectTags')}</span>
              <div className="detail-value">
                <TagManager tags={projectTags} onTagsChange={handleProjectTagsChange} allTags={allProjectTags} />
              </div>
            </div>

            {citation.zoteroNotes && citation.zoteroNotes.length > 0 && (
              <div className="detail-item">
                <span className="detail-label">{t('bibliography.zoteroNotes')}</span>
                <div className="detail-value citation-zotero-notes">
                  {citation.zoteroNotes.map((note) => (
                    <p key={note.key} className="citation-zotero-note">
                      {note.text}
                    </p>
                  ))}
                </div>
              </div>
            )}

            {citation.notes && (
              <div className="detail-item">
                <span className="detail-label">{t('bibliography.bibNote')}</span>
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
                  void handleOpenReadingNote();
                }}
                title={hasReadingNote ? t('bibliography.openReadingNote') : t('bibliography.createReadingNote')}
              >
                📝 {hasReadingNote ? t('bibliography.openReadingNote') : t('bibliography.createReadingNote')}
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
    </>
  );
});
