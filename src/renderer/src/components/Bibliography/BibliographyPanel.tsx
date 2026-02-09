import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, FileStack, Download, BarChart3, Trash2, FileDown } from 'lucide-react';
import { useBibliographyStore } from '../../stores/bibliographyStore';
import { useProjectStore } from '../../stores/projectStore';
import { CitationList } from './CitationList';
import { CollapsibleSection } from '../common/CollapsibleSection';
import { ZoteroImport } from './ZoteroImport';
import { BibImportModeModal } from './BibImportModeModal';
import { BibImportSummaryModal } from './BibImportSummaryModal';
import { BibliographyStats } from './BibliographyStats';
import { TagFilter } from './TagManager';
import { OrphanPDFModal } from './OrphanPDFModal';
import { PDFModificationNotification, usePDFModificationDetection } from './PDFModificationNotification';
import './BibliographyPanel.css';

export const BibliographyPanel: React.FC = () => {
  const { t } = useTranslation('common');
  const currentProject = useProjectStore((state) => state.currentProject);
  const {
    citations,
    filteredCitations,
    searchQuery,
    searchCitations,
    sortBy,
    setSortBy,
    toggleSortOrder,
    sortOrder,
    batchIndexing,
    indexAllPDFs,
    refreshIndexedPDFs,
    downloadAllMissingPDFs,
    getAllTags,
    selectedTags,
    setTagsFilter,
    clearTagsFilter,
  } = useBibliographyStore();

  // PDF Modification Detection
  const { modifiedPDFs, dismissNotification } = usePDFModificationDetection(
    citations,
    currentProject?.path
  );

  // Refresh indexed PDFs on mount
  useEffect(() => {
    refreshIndexedPDFs();
  }, []);

  // Count citations with PDFs and citations needing PDFs
  const citationsWithPDFs = citations.filter((c) => c.file).length;
  const citationsNeedingPDFs = citations.filter(
    (c) => !c.file && c.zoteroAttachments && c.zoteroAttachments.length > 0
  ).length;

  const [showModeModal, setShowModeModal] = useState(false);
  const [showSummaryModal, setShowSummaryModal] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showOrphanPDFModal, setShowOrphanPDFModal] = useState(false);
  const [importSummary, setImportSummary] = useState({
    mode: 'replace' as 'replace' | 'merge',
    totalCitations: 0,
    newCitations: 0,
    duplicates: 0,
  });
  const [pendingFilePath, setPendingFilePath] = useState<string | null>(null);

  const handleImportBibTeX = async () => {
    try {
      const result = await window.electron.dialog.openFile({
        filters: [{ name: 'BibTeX', extensions: ['bib'] }],
      });

      if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
        const sourcePath = result.filePaths[0];
        setPendingFilePath(sourcePath);

        // If we already have citations, show the mode selection modal
        if (citations.length > 0) {
          setShowModeModal(true);
        } else {
          // No citations yet, directly replace (= load)
          await performImport(sourcePath, 'replace');
        }
      }
    } catch (error) {
      console.error('Failed to import BibTeX:', error);
    }
  };

  const performImport = async (sourcePath: string, mode: 'replace' | 'merge') => {
    try {
      let newCitations = 0;
      let duplicates = 0;
      let total = 0;

      if (mode === 'replace') {
        // Replace: load bibliography (replaces all)
        await useBibliographyStore.getState().loadBibliography(sourcePath);
        total = useBibliographyStore.getState().citations.length;
      } else {
        // Merge: use mergeBibliography
        const result = await useBibliographyStore.getState().mergeBibliography(sourcePath);
        newCitations = result.newCitations;
        duplicates = result.duplicates;
        total = result.total;
      }

      // If we have a project, save the bibliography source configuration
      if (currentProject) {
        // Copy the .bib file to the project directory
        const bibFileName = sourcePath.split('/').pop() || 'bibliography.bib';
        const targetPath = `${currentProject.path}/${bibFileName}`;

        // Copy file to project directory
        await window.electron.fs.copyFile(sourcePath, targetPath);

        // Save the bibliography source to project.json
        const projectJsonPath = `${currentProject.path}/project.json`;
        await window.electron.project.setBibliographySource({
          projectPath: projectJsonPath,
          type: 'file',
          filePath: bibFileName,
        });

        console.log('✅ Bibliography source saved to project');
      }

      // Show summary modal
      setImportSummary({
        mode,
        totalCitations: total,
        newCitations,
        duplicates,
      });
      setShowSummaryModal(true);
    } catch (error) {
      console.error('Failed to import BibTeX:', error);
      alert(`Failed to import bibliography: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleReplaceMode = async () => {
    setShowModeModal(false);
    if (pendingFilePath) {
      await performImport(pendingFilePath, 'replace');
      setPendingFilePath(null);
    }
  };

  const handleMergeMode = async () => {
    setShowModeModal(false);
    if (pendingFilePath) {
      await performImport(pendingFilePath, 'merge');
      setPendingFilePath(null);
    }
  };

  const handleIndexAllPDFs = async () => {
    if (batchIndexing.isIndexing) return;

    if (citationsWithPDFs === 0) {
      alert(t('bibliography.noPDFsToIndex'));
      return;
    }

    const confirm = window.confirm(
      t('bibliography.confirmIndexAll', { count: citationsWithPDFs })
    );
    if (!confirm) return;

    try {
      const result = await indexAllPDFs();
      alert(
        t('bibliography.indexAllComplete', {
          indexed: result.indexed,
          skipped: result.skipped,
          errors: result.errors.length,
        })
      );
    } catch (error) {
      console.error('Failed to index all PDFs:', error);
      alert(`${t('bibliography.indexError')} ${error}`);
    }
  };

  const handleDownloadAllPDFs = async () => {
    if (batchIndexing.isIndexing) return;

    if (!currentProject) {
      alert(t('bibliography.noProjectOpen'));
      return;
    }

    if (citationsNeedingPDFs === 0) {
      alert(t('bibliography.noMissingPDFs'));
      return;
    }

    const confirm = window.confirm(
      t('bibliography.confirmDownloadAll', { count: citationsNeedingPDFs })
    );
    if (!confirm) return;

    try {
      const result = await downloadAllMissingPDFs(currentProject.path);
      alert(
        t('bibliography.downloadAllComplete', {
          downloaded: result.downloaded,
          skipped: result.skipped,
          errors: result.errors.length,
        })
      );
    } catch (error) {
      console.error('Failed to download all PDFs:', error);
      alert(`${t('bibliography.downloadError')} ${error}`);
    }
  };

  const handleExportBibTeX = async () => {
    if (citations.length === 0) {
      alert(t('bibliography.noCitationsToExport'));
      return;
    }

    try {
      const result = await window.electron.dialog.saveFile({
        defaultPath: 'bibliography.bib',
        filters: [{ name: 'BibTeX', extensions: ['bib'] }],
      });

      if (!result.canceled && result.filePath) {
        const exportResult = await window.electron.bibliography.export({
          citations,
          filePath: result.filePath,
          format: 'modern',
        });

        if (exportResult.success) {
          alert(t('bibliography.exportSuccess', { count: citations.length }));
        } else {
          alert(`${t('bibliography.exportError')}: ${exportResult.error}`);
        }
      }
    } catch (error) {
      console.error('Failed to export BibTeX:', error);
      alert(`${t('bibliography.exportError')}: ${error}`);
    }
  };

  const handleReindexModifiedPDFs = async (citationIds?: string[]) => {
    if (!currentProject) {
      alert(t('bibliography.noProjectOpen'));
      return;
    }

    const toReindex = citationIds
      ? citations.filter((c) => citationIds.includes(c.id) && c.file)
      : modifiedPDFs.map((m) => citations.find((c) => c.id === m.citationId)).filter((c) => c && c.file);

    if (toReindex.length === 0) {
      alert(t('bibliography.noPDFsToReindex'));
      return;
    }

    const confirm = window.confirm(
      t('bibliography.confirmReindexModified', { count: toReindex.length })
    );
    if (!confirm) return;

    try {
      // Re-index each PDF
      for (const citation of toReindex) {
        if (citation.file) {
          await window.electron.pdf.index(
            citation.file,
            citation.key,
            {
              title: citation.title,
              author: citation.author,
              year: citation.year,
            }
          );
        }
      }

      // Refresh indexed PDFs
      await refreshIndexedPDFs();

      // Dismiss notification
      dismissNotification();

      alert(t('bibliography.reindexComplete', { count: toReindex.length }));
    } catch (error) {
      console.error('Failed to re-index modified PDFs:', error);
      alert(`${t('bibliography.reindexError')}: ${error}`);
    }
  };

  return (
    <div className="bibliography-panel">
      {/* Header */}
      <div className="bibliography-header">
        <button className="toolbar-btn" onClick={handleImportBibTeX} title={t('bibliography.import')}>
          <Plus size={20} strokeWidth={1} />
        </button>
        {citations.length > 0 && (
          <button
            className="toolbar-btn"
            onClick={handleExportBibTeX}
            title={t('bibliography.exportBibTeX')}
          >
            <FileDown size={20} strokeWidth={1} />
          </button>
        )}
        {citationsWithPDFs > 0 && (
          <button
            className="toolbar-btn"
            onClick={handleIndexAllPDFs}
            disabled={batchIndexing.isIndexing}
            title={t('bibliography.indexAllPDFs')}
          >
            <FileStack size={20} strokeWidth={1} />
          </button>
        )}
        {citationsNeedingPDFs > 0 && (
          <button
            className="toolbar-btn"
            onClick={handleDownloadAllPDFs}
            disabled={batchIndexing.isIndexing}
            title={t('bibliography.downloadAllMissing')}
          >
            <Download size={20} strokeWidth={1} />
          </button>
        )}
        {citations.length > 0 && (
          <button
            className="toolbar-btn"
            onClick={() => setShowStats(!showStats)}
            title={t('bibliography.viewStatistics')}
          >
            <BarChart3 size={20} strokeWidth={1} />
          </button>
        )}
        {currentProject && citations.length > 0 && (
          <button
            className="toolbar-btn"
            onClick={() => setShowOrphanPDFModal(true)}
            title={t('bibliography.cleanupOrphanPDFs')}
          >
            <Trash2 size={20} strokeWidth={1} />
          </button>
        )}
      </div>

      {/* Batch Indexing Progress */}
      {batchIndexing.isIndexing && (
        <div className="batch-indexing-progress">
          <div className="batch-progress-header">
            {t('bibliography.indexingProgress', {
              current: batchIndexing.current,
              total: batchIndexing.total,
            })}
          </div>
          {batchIndexing.currentCitation && (
            <div className="batch-progress-current">
              {batchIndexing.currentCitation.title}
            </div>
          )}
          <div className="batch-progress-bar">
            <div
              className="batch-progress-fill"
              style={{
                width: `${(batchIndexing.current / batchIndexing.total) * 100}%`,
              }}
            />
          </div>
          <div className="batch-progress-stats">
            ✅ {batchIndexing.indexed} | ⏭️ {batchIndexing.skipped}
          </div>
        </div>
      )}

      {/* Zotero Import */}
      <ZoteroImport />

      {/* Statistics Dashboard */}
      {showStats && citations.length > 0 && (
        <CollapsibleSection title={t('bibliography.statistics')} defaultExpanded={true}>
          <BibliographyStats citations={citations} />
        </CollapsibleSection>
      )}

      {/* Search & Filters */}
      <CollapsibleSection title={t('bibliography.searchAndFilters')} defaultExpanded={true}>
        <div className="bibliography-controls">
          <div className="search-box">
            <span className="search-icon">🔍</span>
            <input
              type="text"
              className="search-input"
              placeholder={t('bibliography.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => searchCitations(e.target.value)}
            />
          </div>

          <div className="sort-controls">
            <label className="sort-label">{t('bibliography.sortBy')}</label>
            <select
              className="sort-select"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'author' | 'year' | 'title')}
            >
              <option value="author">{t('bibliography.author')}</option>
              <option value="year">{t('bibliography.year')}</option>
              <option value="title">{t('bibliography.titleField')}</option>
            </select>
            <button className="sort-order-btn" onClick={toggleSortOrder} title={t('bibliography.sortBy')}>
              {sortOrder === 'asc' ? '↑' : '↓'}
            </button>
          </div>
        </div>

        {/* Citation Count */}
        <div className="citation-count">
          {filteredCitations.length} citation{filteredCitations.length !== 1 ? 's' : ''}
        </div>

        {/* Tag Filter */}
        {getAllTags().length > 0 && (
          <TagFilter
            selectedTags={selectedTags}
            allTags={getAllTags()}
            onTagsChange={setTagsFilter}
            onClear={clearTagsFilter}
          />
        )}
      </CollapsibleSection>

      {/* Citation List */}
      <CollapsibleSection title={t('bibliography.title')} defaultExpanded={true}>
        <div className="bibliography-content">
          {filteredCitations.length === 0 ? (
            <div className="bibliography-empty">
              <h4>{t('bibliography.noCitations')}</h4>
              <p>{t('bibliography.importPrompt')}</p>
            </div>
          ) : (
            <CitationList citations={filteredCitations} />
          )}
        </div>
      </CollapsibleSection>

      {/* Import Mode Modal */}
      <BibImportModeModal
        isOpen={showModeModal}
        onClose={() => {
          setShowModeModal(false);
          setPendingFilePath(null);
        }}
        onReplace={handleReplaceMode}
        onMerge={handleMergeMode}
        currentCitationCount={citations.length}
      />

      {/* Import Summary Modal */}
      <BibImportSummaryModal
        isOpen={showSummaryModal}
        onClose={() => setShowSummaryModal(false)}
        mode={importSummary.mode}
        totalCitations={importSummary.totalCitations}
        newCitations={importSummary.newCitations}
        duplicates={importSummary.duplicates}
      />

      {/* Orphan PDF Cleanup Modal */}
      {currentProject && (
        <OrphanPDFModal
          isOpen={showOrphanPDFModal}
          onClose={() => setShowOrphanPDFModal(false)}
          projectPath={currentProject.path}
          citations={citations}
        />
      )}

      {/* PDF Modification Notification */}
      <PDFModificationNotification
        modifiedPDFs={modifiedPDFs}
        onReindexAll={() => handleReindexModifiedPDFs()}
        onReindexSingle={(citationId) => handleReindexModifiedPDFs([citationId])}
        onDismiss={dismissNotification}
      />
    </div>
  );
};
