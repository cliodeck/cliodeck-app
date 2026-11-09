import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, FileStack, Download, BarChart3, Trash2, FileDown, ArrowDown, ArrowUp, CheckCircle, Search, SkipForward, AlertTriangle } from 'lucide-react';
import { useBibliographyStore } from '../../stores/bibliographyStore';
import type { BibliographyProblem } from '../../stores/bibliography/types';
import {
  BibliographyFileError,
  BibliographyMergeRefusedError,
  BibliographyReplaceRefusedError,
} from '../../stores/bibliography/citationSlice';
import { useProjectStore } from '../../stores/projectStore';
import { withErrorDetails } from './errorDetails';
import { describeNotAttached } from '../../stores/bibliography/zoteroSlice';
import { isPdfPath } from '../../../../../backend/core/bibliography/pdf-attachment';
import { useDialogStore } from '../../stores/dialogStore';
import { useMenuIntentStore } from '../../stores/menuIntentStore';
import { refusedAsProjectChanged, stillIn, stillShown } from '../../services/still-in-project';
import { CitationList } from './CitationList';
import { CollapsibleSection } from '../common/CollapsibleSection';
import { ZoteroImport } from './ZoteroImport';
import { BibImportModeModal } from './BibImportModeModal';
import { BibImportSummaryModal } from './BibImportSummaryModal';
import { BibliographyStats } from './BibliographyStats';
import { TagFilter } from './TagManager';
import { OrphanPDFModal } from './OrphanPDFModal';
import {
  PDFModificationNotification,
  usePDFModificationDetection,
  type ModifiedPDF,
} from './PDFModificationNotification';
import './BibliographyPanel.css';

/** Clés montrées dans le bandeau avant « … et N autre(s) ». */
const SHOWN_KEYS = 8;

/**
 * Le `.bib` attendu du projet ne s'est pas lu, ou pas en entier : ce qui manque, les clés en
 * cause, et quoi faire. Il disparaît à la lecture suivante d'un fichier redevenu lisible.
 */
const BibliographyProblemBanner: React.FC<{ problem: BibliographyProblem }> = ({ problem }) => {
  const { t } = useTranslation('common');
  const { file } = problem;
  const parts: React.ReactNode[] = [];
  if (problem.kind === 'missing') {
    parts.push(t('bibliography.bibMissing', { file }));
  } else if (problem.kind === 'unreadable') {
    parts.push(
      problem.reason === 'encoding'
        ? t('bibliography.bibNotUtf8', { file })
        : t('bibliography.bibUnreadable', { file, error: problem.detail })
    );
  } else {
    if (problem.unreadKeys.length > 0) {
      const keys = problem.unreadKeys.slice(0, SHOWN_KEYS).map((key) => `@${key}`).join(', ');
      const more = problem.unreadKeys.length - SHOWN_KEYS;
      parts.push(t('bibliography.unreadEntries', { count: problem.unreadKeys.length, file }));
      parts.push(
        <span className="bibliography-problem-keys">
          {keys}
          {more > 0 && ` ${t('zotero.sync.more', { count: more })}`}
        </span>
      );
    }
    if (problem.metadataUnreadable) {
      parts.push(t('bibliography.metadataUnreadable', { file: '.cliodeck/bibliography-metadata.json' }));
    }
  }
  parts.push(t('bibliography.reopenAfterFix'));

  return (
    <div className="bibliography-problem" role="alert">
      <AlertTriangle size={16} aria-hidden="true" />
      <div className="bibliography-problem-text">
        {parts.map((part, i) => (
          <p key={i}>{part}</p>
        ))}
      </div>
    </div>
  );
};

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

  // Absent, illisible ou lu en partie : une liste vide n'est pas une bibliographie vide, et le
  // bandeau dit ce qui manque, à la place de « Aucune citation disponible ».
  const bibliographyProblem = useBibliographyStore((state) => state.bibliographyProblem);

  // PDF Modification Detection
  const { modifiedPDFs, acknowledge, dismissNotification } = usePDFModificationDetection(
    citations,
    currentProject?.path
  );

  // Refresh indexed PDFs on mount
  useEffect(() => {
    refreshIndexedPDFs();
  }, []);

  // Count citations with PDFs and citations needing PDFs
  const citationsWithPDFs = useMemo(
    () => citations.filter((c) => isPdfPath(c.file)).length,
    [citations]
  );
  const citationsNeedingPDFs = useMemo(
    () => citations.filter(
      (c) => !isPdfPath(c.file) && c.zoteroAttachments && c.zoteroAttachments.length > 0
    ).length,
    [citations]
  );

  // Tags filtrables : dépendent aussi des notes de lecture (étiquettes du
  // projet) et de l'affichage des tags automatiques de Zotero.
  const readingNotes = useBibliographyStore((state) => state.readingNotes);
  const showAutomaticZoteroTags = useBibliographyStore((state) => state.showAutomaticZoteroTags);
  const setShowAutomaticZoteroTags = useBibliographyStore((state) => state.setShowAutomaticZoteroTags);
  const allTags = useMemo(
    () => getAllTags(),
    [citations, readingNotes, showAutomaticZoteroTags, getAllTags]
  );
  const hasAutomaticZoteroTags = useMemo(
    () => citations.some((c) => c.zoteroTags?.some((tag) => tag.automatic)),
    [citations]
  );

  const [showModeModal, setShowModeModal] = useState(false);
  const [showSummaryModal, setShowSummaryModal] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showOrphanPDFModal, setShowOrphanPDFModal] = useState(false);
  const [importSummary, setImportSummary] = useState({
    mode: 'replace' as 'replace' | 'merge',
    totalCitations: 0,
    newCitations: 0,
    duplicates: 0,
    unreadKeys: [] as string[],
    file: '',
    inProject: true,
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

        // If we already have citations, show the mode selection modal. Un `.bib` du projet qui
        // ne se lit pas n'est pas une bibliographie vide : pas de remplacement sans le demander.
        if (citations.length > 0 || bibliographyProblem) {
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

  // Bibliographie › Importer BibTeX : le bouton de ce panneau, même s'il vient d'être monté par
  // la commande. Une bibliographie déjà là passe par le choix remplacer / fusionner.
  const menuIntent = useMenuIntentStore((state) => state.intent);
  useEffect(() => {
    if (useMenuIntentStore.getState().consume('import-bibtex')) void handleImportBibTeX();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- l'intention seule déclenche, une fois
  }, [menuIntent]);

  /**
   * L'import n'a pas abouti : dire pourquoi et quoi faire, dans la langue de l'interface. Un fichier
   * importé qui ne se lit pas, une fusion arrêtée parce que le `.bib` du projet ne s'est pas lu en
   * entier : le main n'a rien écrit, et le bandeau, qui parle du `.bib` du projet, ne change pas.
   */
  const importFailureMessage = (error: unknown): string => {
    if (error instanceof BibliographyFileError) {
      const { problem } = error;
      if (problem.kind === 'unreadable' && problem.reason === 'encoding') {
        return t('bibliography.bibNotUtf8', { file: problem.file });
      }
      return t('bibliography.bibUnreadable', {
        file: problem.file,
        error: problem.kind === 'unreadable' ? problem.detail : error.message,
      });
    }
    if (error instanceof BibliographyMergeRefusedError) {
      const { problem } = error;
      if (!problem) return t('bibImport.projectUnreadable');
      // Les mots du bandeau et de la synchronisation Zotero, refusée pour la même raison.
      let detail: string;
      if (problem.kind === 'partial') {
        const listed = problem.unreadKeys.slice(0, SHOWN_KEYS).map((key) => `• @${key}`);
        if (problem.unreadKeys.length > SHOWN_KEYS) {
          listed.push(t('zotero.sync.more', { count: problem.unreadKeys.length - SHOWN_KEYS }));
        }
        detail = `${t('zotero.sync.unreadEntries', { count: problem.unreadKeys.length, file: problem.file })}\n${listed.join('\n')}`;
      } else {
        detail =
          problem.reason === 'encoding'
            ? t('bibliography.bibNotUtf8', { file: problem.file })
            : t('bibliography.bibUnreadable', { file: problem.file, error: problem.detail });
      }
      return `${t('bibImport.mergeRefused')}\n\n${detail}`;
    }
    if (error instanceof BibliographyReplaceRefusedError) {
      return t('bibImport.targetOutsideProject', { file: error.file });
    }
    return withErrorDetails(t('bibImport.failed'), [error instanceof Error ? error.message : String(error)]);
  };

  const performImport = async (sourcePath: string, mode: 'replace' | 'merge') => {
    // Le projet où l'on a cliqué : le main y écrit, et rien ne s'affiche dans un autre.
    const projectPath = currentProject?.path ?? null;
    try {
      const outcome = await useBibliographyStore.getState().importBibliography(sourcePath, mode, projectPath);
      if (!outcome) return;

      // Le main rend le refus de project.json sans lever. Les références sont écrites et relues :
      // le récapitulatif suit.
      if (!outcome.sourceSaved) {
        await useDialogStore
          .getState()
          .showAlert(withErrorDetails(t('bibliography.sourceNotSaved'), outcome.sourceError ? [outcome.sourceError] : []));
      }

      setImportSummary({
        mode,
        totalCitations: outcome.total,
        newCitations: outcome.newCitations,
        duplicates: outcome.duplicates,
        unreadKeys: outcome.unreadKeys,
        file: outcome.file,
        // Sans projet, il n'y a pas de fichier du projet : le récapitulatif n'en parle pas.
        inProject: projectPath !== null,
      });
      setShowSummaryModal(true);
    } catch (error) {
      console.error('Failed to import BibTeX:', error);
      // Un échec arrivé pendant que l'auteur ouvrait un autre projet ne s'y affiche pas.
      if (projectPath && !(await stillIn(projectPath))) return;
      await useDialogStore.getState().showAlert(importFailureMessage(error));
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

  /**
   * Un lot arrêté parce que son projet n'est plus l'ouvert (S18-2-0). L'onglet Projets démonte ce
   * panneau sans arrêter le geste : l'alerte s'affiche donc souvent par-dessus l'autre projet. Elle
   * nomme le projet d'origine, dit ce qui a été fait et ce qui reste, et comment le terminer : la
   * relance du lot pour ce qui n'a pas été traité, « Indexer tous les PDFs » pour un PDF rattaché
   * mais pas indexé, que la relance du téléchargement écarterait.
   */
  const alertBatchInterrupted = (
    batchKey: string,
    projectName: string,
    progress: { done: number; remaining: number; errors: string[]; toIndex?: number }
  ) => {
    const batch = t(batchKey);
    const toIndex = progress.toIndex ?? 0;
    const message = [
      t('bibliography.batchInterrupted', {
        batch,
        project: projectName,
        done: progress.done,
        errors: progress.errors.length,
        remaining: progress.remaining,
      }),
      progress.remaining > 0 ? t('bibliography.batchInterruptedResume', { batch, project: projectName }) : '',
      toIndex > 0
        ? t('bibliography.batchInterruptedToIndex', {
            pending: toIndex,
            project: projectName,
            indexAll: t('bibliography.indexAllPDFs'),
          })
        : '',
    ]
      .filter(Boolean)
      .join(' ');
    return useDialogStore.getState().showAlert(withErrorDetails(message, progress.errors));
  };

  const handleIndexAllPDFs = async () => {
    if (batchIndexing.isIndexing) return;

    if (!currentProject) {
      await useDialogStore.getState().showAlert(t('bibliography.noProjectOpen'));
      return;
    }

    if (citationsWithPDFs === 0) {
      await useDialogStore.getState().showAlert(t('bibliography.noPDFsToIndex'));
      return;
    }

    const confirmed = await useDialogStore.getState().showConfirm(
      t('bibliography.confirmIndexAll', { count: citationsWithPDFs })
    );
    if (!confirmed) return;

    try {
      const result = await indexAllPDFs(currentProject.path);
      if (result.interrupted) {
        await alertBatchInterrupted('bibliography.indexAllPDFs', currentProject.name, {
          done: result.indexed,
          remaining: result.remaining ?? 0,
          errors: result.errors,
        });
        return;
      }
      await useDialogStore.getState().showAlert(
        withErrorDetails(
          t('bibliography.indexAllComplete', {
            indexed: result.indexed,
            skipped: result.skipped,
            errors: result.errors.length,
          }),
          result.errors
        )
      );
    } catch (error) {
      console.error('Failed to index all PDFs:', error);
      await useDialogStore.getState().showAlert(`${t('bibliography.indexError')} ${error}`);
    }
  };

  const handleDownloadAllPDFs = async () => {
    if (batchIndexing.isIndexing) return;

    if (!currentProject) {
      await useDialogStore.getState().showAlert(t('bibliography.noProjectOpen'));
      return;
    }

    if (citationsNeedingPDFs === 0) {
      await useDialogStore.getState().showAlert(t('bibliography.noMissingPDFs'));
      return;
    }

    const confirmed = await useDialogStore.getState().showConfirm(
      t('bibliography.confirmDownloadAll', { count: citationsNeedingPDFs })
    );
    if (!confirmed) return;

    try {
      const result = await downloadAllMissingPDFs(currentProject.path);
      if (result.interrupted) {
        await alertBatchInterrupted('bibliography.downloadAllMissing', currentProject.name, {
          done: result.downloaded,
          remaining: result.remaining ?? 0,
          errors: result.errors,
          toIndex: result.toIndex,
        });
        return;
      }
      if (result.stopped) {
        // Des métadonnées illisibles refusent tout rattachement : le lot s'est arrêté au premier PDF.
        await useDialogStore.getState().showAlert(
          withErrorDetails(
            [
              [
                t('bibliography.downloadAllStopped', {
                  batch: t('bibliography.downloadAllMissing'),
                  done: result.downloaded,
                  errors: result.errors.length,
                  remaining: result.remaining ?? 0,
                }),
                (result.remaining ?? 0) > 0 ? t('bibliography.downloadAllStoppedRest') : '',
              ]
                .filter(Boolean)
                .join(' '),
              describeNotAttached(t, result.stopped),
            ].join('\n\n'),
            result.errors
          )
        );
        return;
      }
      await useDialogStore.getState().showAlert(
        withErrorDetails(
          t('bibliography.downloadAllComplete', {
            downloaded: result.downloaded,
            skipped: result.skipped,
            errors: result.errors.length,
          }),
          result.errors
        )
      );
    } catch (error) {
      console.error('Failed to download all PDFs:', error);
      await useDialogStore.getState().showAlert(`${t('bibliography.downloadError')} ${error}`);
    }
  };

  const handleExportBibTeX = async () => {
    if (citations.length === 0) {
      await useDialogStore.getState().showAlert(t('bibliography.noCitationsToExport'));
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
          await useDialogStore.getState().showAlert(t('bibliography.exportSuccess', { count: citations.length }));
        } else {
          await useDialogStore.getState().showAlert(`${t('bibliography.exportError')}: ${exportResult.error}`);
        }
      }
    } catch (error) {
      console.error('Failed to export BibTeX:', error);
      await useDialogStore.getState().showAlert(`${t('bibliography.exportError')}: ${error}`);
    }
  };

  const handleReindexModifiedPDFs = async (selected: ModifiedPDF[] = modifiedPDFs) => {
    if (!currentProject) {
      await useDialogStore.getState().showAlert(t('bibliography.noProjectOpen'));
      return;
    }

    // Chaque PDF du bandeau avec sa référence : la clé BibTeX seule peut être commune à plusieurs.
    const toReindex = selected.flatMap((pdf) => {
      const citation = citations.find((c) => c.id === pdf.citationId && c.zoteroKey === pdf.zoteroKey);
      return citation && isPdfPath(citation.file) ? [{ pdf, citation, file: citation.file }] : [];
    });

    if (toReindex.length === 0) {
      await useDialogStore.getState().showAlert(t('bibliography.noPDFsToReindex'));
      return;
    }

    const confirmed = await useDialogStore.getState().showConfirm(
      t('bibliography.confirmReindexModified', { count: toReindex.length })
    );
    if (!confirmed) return;

    // Le projet du geste : un autre ouvert entre-temps ne reçoit ni les PDF de celui-ci, ni sa relecture.
    const { path: projectPath, name: projectName } = currentProject;
    const reindexed: ModifiedPDF[] = [];
    const errors: string[] = [];
    const interrupted = () =>
      alertBatchInterrupted('bibliography.reindexAll', projectName, {
        done: reindexed.length,
        remaining: toReindex.length - reindexed.length - errors.length,
        errors,
      });

    try {
      // Re-index each PDF
      for (const { pdf, citation, file } of toReindex) {
        if (!(await stillIn(projectPath))) return await interrupted();
        const result = await window.electron.pdf.index(
          file,
          citation.key,
          {
            title: citation.title,
            author: citation.author,
            year: citation.year,
          },
          projectPath
        );
        if (result?.success) {
          reindexed.push(pdf);
          // Il quitte le bandeau et le projet retient son MD5 aussitôt, pas en fin de lot : un lot
          // interrompu plus loin ne le fera pas réindexer une seconde fois. Tant que l'écran montre
          // son projet seulement (le main refuse s'il a déjà basculé) : ailleurs, ce serait une
          // réponse donnée dans l'autre. Ceux en échec restent au bandeau.
          if (stillShown(projectPath)) await acknowledge([pdf]);
        } else if (!refusedAsProjectChanged(result)) errors.push(`${citation.title}: ${result?.error}`);
        if (refusedAsProjectChanged(result) || !(await stillIn(projectPath))) return await interrupted();
      }

      // Refresh indexed PDFs
      await refreshIndexedPDFs();

      await useDialogStore.getState().showAlert(
        withErrorDetails(
          t('bibliography.reindexComplete', { indexed: reindexed.length, errors: errors.length }),
          errors
        )
      );
    } catch (error) {
      console.error('Failed to re-index modified PDFs:', error);
      await useDialogStore.getState().showAlert(`${t('bibliography.reindexError')}: ${error}`);
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
            <span><CheckCircle size={12} /> {batchIndexing.indexed}</span>
            <span><SkipForward size={12} /> {batchIndexing.skipped}</span>
          </div>
        </div>
      )}

      {bibliographyProblem && <BibliographyProblemBanner problem={bibliographyProblem} />}

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
            <span className="search-icon"><Search size={14} /></span>
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
              {sortOrder === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
            </button>
          </div>
        </div>

        {/* Citation Count */}
        <div className="citation-count">
          {filteredCitations.length} citation{filteredCitations.length !== 1 ? 's' : ''}
        </div>

        {/* Tags automatiques de Zotero : masqués par défaut, jamais perdus. */}
        {hasAutomaticZoteroTags && (
          <label className="automatic-tags-setting">
            <input
              type="checkbox"
              checked={showAutomaticZoteroTags}
              onChange={(e) => setShowAutomaticZoteroTags(e.target.checked)}
            />
            {t('bibliography.showAutomaticTags')}
          </label>
        )}

        {/* Tag Filter */}
        {allTags.length > 0 && (
          <TagFilter
            selectedTags={selectedTags}
            allTags={allTags}
            onTagsChange={setTagsFilter}
            onClear={clearTagsFilter}
          />
        )}
      </CollapsibleSection>

      {/* Citation List */}
      <CollapsibleSection title={t('bibliography.title')} defaultExpanded={true}>
        <div className="bibliography-content">
          {filteredCitations.length > 0 ? (
            <CitationList citations={filteredCitations} />
          ) : bibliographyProblem ? null : (
            <div className="bibliography-empty">
              <h4>{t('bibliography.noCitations')}</h4>
              <p>{t('bibliography.importPrompt')}</p>
            </div>
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
        projectFileProblem={bibliographyProblem}
      />

      {/* Import Summary Modal */}
      <BibImportSummaryModal
        isOpen={showSummaryModal}
        onClose={() => setShowSummaryModal(false)}
        mode={importSummary.mode}
        totalCitations={importSummary.totalCitations}
        newCitations={importSummary.newCitations}
        duplicates={importSummary.duplicates}
        unreadKeys={importSummary.unreadKeys}
        file={importSummary.file}
        inProject={importSummary.inProject}
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
        onReindexSingle={(pdf) => handleReindexModifiedPDFs([pdf])}
        onDismiss={dismissNotification}
      />
    </div>
  );
};
