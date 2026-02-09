import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FolderOpen,
  RefreshCw,
  Eye,
  EyeOff,
  Languages,
  FileText,
  Search,
  BarChart3,
  Archive,
} from 'lucide-react';
import { usePrimarySourcesStore } from '../../stores/primarySourcesStore';
import { useProjectStore } from '../../stores/projectStore';
import { CollapsibleSection } from '../common/CollapsibleSection';
import { PrimarySourceList } from './PrimarySourceList';
import { PrimarySourceStats } from './PrimarySourceStats';
import { OCRSettingsModal } from './OCRSettingsModal';
import { TranscriptionImportModal } from './TranscriptionImportModal';
import './PrimarySourcesPanel.css';

export const PrimarySourcesPanel: React.FC = () => {
  const { t } = useTranslation('common');
  const currentProject = useProjectStore((state) => state.currentProject);
  const {
    sources,
    filteredSources,
    projectInfo,
    isSyncing,
    syncProgress,
    searchQuery,
    statistics,
    searchSources,
    openTPYProject,
    syncTPY,
    startWatching,
    stopWatching,
    refreshSources,
    refreshStatistics,
    loadOCRLanguages,
  } = usePrimarySourcesStore();

  const [showOCRModal, setShowOCRModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showStats, setShowStats] = useState(false);

  // Load OCR languages on mount
  useEffect(() => {
    loadOCRLanguages();
  }, [loadOCRLanguages]);

  // Load project info and sources when project changes
  useEffect(() => {
    const loadData = async () => {
      if (currentProject) {
        // D'abord récupérer les infos du projet Tropy (restaure tpyPath et projectInfo)
        await usePrimarySourcesStore.getState().getProjectInfo();
        // Ensuite charger les sources et stats
        await refreshSources();
        await refreshStatistics();
      }
    };
    loadData();
  }, [currentProject, refreshSources, refreshStatistics]);

  const handleOpenTPY = async () => {
    try {
      // On macOS, .tropy files are actually packages (folders with .tropy extension)
      // containing project.tpy and an assets folder.
      // We use openDirectory to allow selecting .tropy packages directly.
      const result = await window.electron.dialog.openFile({
        title: t('primarySources.selectTropyProject', 'Select Tropy Project'),
        message: t('primarySources.selectTropyMessage', 'Choose a .tropy package or .tpy file'),
        properties: ['openFile', 'openDirectory'],
        filters: [
          { name: 'Tropy Project', extensions: ['tropy', 'tpy'] },
        ],
      });

      if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
        const projectPath = result.filePaths[0];

        // Validate that it's a valid Tropy project path
        if (!projectPath.endsWith('.tropy') && !projectPath.endsWith('.tpy')) {
          alert(t('primarySources.invalidProject', 'Please select a .tropy package or .tpy file'));
          return;
        }

        const openResult = await openTPYProject(projectPath);

        if (!openResult.success) {
          alert(`Failed to open Tropy project: ${openResult.error}`);
        }
      }
    } catch (error) {
      console.error('Failed to open Tropy project:', error);
    }
  };

  const handleSync = async () => {
    const result = await syncTPY({
      performOCR: false,
      ocrLanguage: 'fra',
    });

    if (!result.success && result.errors && result.errors.length > 0) {
      console.error('Sync errors:', result.errors);
    }
  };

  const handleToggleWatching = async () => {
    if (projectInfo?.isWatching) {
      await stopWatching();
    } else {
      await startWatching();
    }
  };

  const withTranscription = statistics?.withTranscription || 0;
  const withoutTranscription = statistics?.withoutTranscription || 0;

  // Si aucun projet ClioDeck n'est ouvert, afficher un message
  if (!currentProject) {
    return (
      <div className="primary-sources-panel">
        <div className="primary-sources-empty" style={{ marginTop: '2rem' }}>
          <Archive size={48} strokeWidth={1} />
          <h4>{t('primarySources.noClioDeckProject', 'No Project Open')}</h4>
          <p>{t('primarySources.openClioDeckFirst', 'Open or create a ClioDeck project first to use primary sources.')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="primary-sources-panel">
      {/* Header Toolbar */}
      <div className="primary-sources-header">
        <button
          className="toolbar-btn"
          onClick={handleOpenTPY}
          title={t('primarySources.openProject', 'Open Tropy Project')}
        >
          <FolderOpen size={20} strokeWidth={1} />
        </button>

        {projectInfo && (
          <>
            <button
              className={`toolbar-btn ${isSyncing ? 'syncing' : ''}`}
              onClick={handleSync}
              disabled={isSyncing}
              title={t('primarySources.sync', 'Synchronize')}
            >
              <RefreshCw size={20} strokeWidth={1} className={isSyncing ? 'spinning' : ''} />
            </button>

            <button
              className={`toolbar-btn ${projectInfo.isWatching ? 'active' : ''}`}
              onClick={handleToggleWatching}
              title={
                projectInfo.isWatching
                  ? t('primarySources.stopWatching', 'Stop auto-sync')
                  : t('primarySources.startWatching', 'Enable auto-sync')
              }
            >
              {projectInfo.isWatching ? (
                <Eye size={20} strokeWidth={1} />
              ) : (
                <EyeOff size={20} strokeWidth={1} />
              )}
            </button>

            <div className="toolbar-separator" />

            <button
              className="toolbar-btn"
              onClick={() => setShowOCRModal(true)}
              title={t('primarySources.ocr', 'OCR Settings')}
            >
              <Languages size={20} strokeWidth={1} />
            </button>

            <button
              className="toolbar-btn"
              onClick={() => setShowImportModal(true)}
              title={t('primarySources.importTranscription', 'Import Transcription')}
            >
              <FileText size={20} strokeWidth={1} />
            </button>

            <div className="toolbar-separator" />

            <button
              className="toolbar-btn"
              onClick={() => setShowStats(!showStats)}
              title={t('primarySources.statistics', 'Statistics')}
            >
              <BarChart3 size={20} strokeWidth={1} />
            </button>
          </>
        )}
      </div>

      {/* Scrollable Content Area */}
      <div className="primary-sources-content">
        {/* Sync Progress */}
        {isSyncing && syncProgress && (
          <div className="sync-progress">
            <div className="sync-progress-bar">
              <div
                className="sync-progress-fill"
                style={{ width: `${(syncProgress.current / syncProgress.total) * 100}%` }}
              />
            </div>
            <span className="sync-progress-text">
              {syncProgress.phase === 'reading' && t('primarySources.reading', 'Reading project...')}
              {syncProgress.phase === 'processing' &&
                `${t('primarySources.processing', 'Processing')} ${syncProgress.current}/${syncProgress.total}`}
              {syncProgress.phase === 'indexing' && t('primarySources.indexing', 'Indexing...')}
              {syncProgress.currentItem && ` - ${syncProgress.currentItem}`}
            </span>
          </div>
        )}

        {/* Project Info */}
        {projectInfo && (
          <div className="tropy-project-info">
            <Archive size={16} strokeWidth={1} />
            <span className="project-name">{projectInfo.name}</span>
            <span className="source-count">{sources.length} sources</span>
            {projectInfo.isWatching && (
              <span className="watching-badge">{t('primarySources.autoSync', 'Auto-sync')}</span>
            )}
          </div>
        )}

        {/* Statistics Panel */}
        {showStats && statistics && <PrimarySourceStats statistics={statistics} />}

        {/* Search & Filters */}
        <CollapsibleSection
          title={t('primarySources.searchAndFilters', 'Search & Filters')}
          defaultExpanded={true}
        >
          <div className="search-box">
            <Search size={16} strokeWidth={1} className="search-icon" />
            <input
              type="text"
              placeholder={t('primarySources.searchPlaceholder', 'Search sources...')}
              value={searchQuery}
              onChange={(e) => searchSources(e.target.value)}
            />
          </div>

          {/* Transcription Status */}
          <div className="transcription-status">
            <span className="status-item with-transcription">
              {withTranscription} {t('primarySources.withTranscription', 'with transcription')}
            </span>
            <span className="status-item without-transcription">
              {withoutTranscription} {t('primarySources.withoutTranscription', 'without transcription')}
            </span>
          </div>
        </CollapsibleSection>

        {/* Source List */}
        <CollapsibleSection
          title={t('primarySources.sources', 'Primary Sources')}
          defaultExpanded={true}
        >
          {!projectInfo ? (
            <div className="primary-sources-empty">
              <Archive size={48} strokeWidth={1} />
              <h4>{t('primarySources.noProject', 'No Tropy Project')}</h4>
              <p>{t('primarySources.openPrompt', 'Click the folder icon to open a Tropy project (.tropy or .tpy)')}</p>
            </div>
          ) : sources.length === 0 ? (
            <div className="primary-sources-empty">
              <FileText size={48} strokeWidth={1} />
              <h4>{t('primarySources.noSources', 'No Sources')}</h4>
              <p>{t('primarySources.syncPrompt', 'Click sync to import sources from Tropy')}</p>
            </div>
          ) : (
            <PrimarySourceList sources={filteredSources} />
          )}
        </CollapsibleSection>
      </div>

      {/* Modals */}
      <OCRSettingsModal isOpen={showOCRModal} onClose={() => setShowOCRModal(false)} />
      <TranscriptionImportModal isOpen={showImportModal} onClose={() => setShowImportModal(false)} />
    </div>
  );
};
