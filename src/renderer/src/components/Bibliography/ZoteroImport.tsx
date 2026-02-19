import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, RefreshCw, GitCompare } from 'lucide-react';
import { useBibliographyStore } from '../../stores/bibliographyStore';
import { useProjectStore } from '../../stores/projectStore';
import { useDialogStore } from '../../stores/dialogStore';
import { SyncPreviewModal } from './SyncPreviewModal';

interface ZoteroCollection {
  key: string;
  name: string;
  parentCollection?: string;
}

interface ZoteroLibraryInfo {
  libraryID: number;
  type: 'user' | 'group';
  name: string;
  groupID?: number;
}

export const ZoteroImport: React.FC = () => {
  const { t } = useTranslation('common');
  const currentProject = useProjectStore((state) => state.currentProject);
  const [zoteroMode, setZoteroMode] = useState<'api' | 'local'>('api');
  const [userId, setUserId] = useState<string>('');
  const [apiKey, setApiKey] = useState<string>('');
  const [dataDirectory, setDataDirectory] = useState<string>('');
  const [groupId, setGroupId] = useState<string>('');
  const [libraries, setLibraries] = useState<ZoteroLibraryInfo[]>([]);
  const [selectedLibraryID, setSelectedLibraryID] = useState<number | undefined>(undefined);
  const [collections, setCollections] = useState<ZoteroCollection[]>([]);
  const [selectedCollection, setSelectedCollection] = useState<string>('');
  const [isLoadingCollections, setIsLoadingCollections] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [syncDiff, setSyncDiff] = useState<any>(null);

  // Calculate depth of a collection in hierarchy
  const getCollectionDepth = (collectionKey: string): number => {
    const col = collections.find((c) => c.key === collectionKey);
    if (!col || !col.parentCollection) return 0;
    return 1 + getCollectionDepth(col.parentCollection);
  };

  // Check if configured based on mode
  const isConfigured = zoteroMode === 'api'
    ? (!!userId && !!apiKey)
    : !!dataDirectory;

  // Build common options for IPC calls
  const buildOptions = (extra: Record<string, any> = {}): any => {
    const base = zoteroMode === 'api'
      ? { mode: 'api', userId, apiKey, groupId: groupId || undefined }
      : { mode: 'local', dataDirectory, libraryID: selectedLibraryID };
    return { ...base, ...extra };
  };

  // Load config on mount and when project changes
  useEffect(() => {
    loadZoteroConfig();
  }, [currentProject]);

  // Load libraries when in local mode and configured
  useEffect(() => {
    if (zoteroMode === 'local' && dataDirectory) {
      loadLibraries(dataDirectory);
    }
  }, [zoteroMode, dataDirectory]);

  const loadLibraries = async (dir: string) => {
    try {
      const result = await window.electron.zotero.listLibraries(dir);
      if (result.success && result.libraries) {
        setLibraries(result.libraries);
      }
    } catch (error) {
      console.error('Failed to load Zotero libraries:', error);
    }
  };

  const loadZoteroConfig = async () => {
    try {
      // Load global Zotero config
      const globalConfig = await window.electron.config.get('zotero');
      if (globalConfig) {
        const mode = globalConfig.mode || 'api';
        setZoteroMode(mode);
        setUserId(globalConfig.userId || '');
        setApiKey(globalConfig.apiKey || '');
        setDataDirectory(globalConfig.dataDirectory || '');
      }

      // Load project-specific Zotero config
      if (currentProject?.path) {
        const projectFilePath = `${currentProject.path}/project.json`;
        const projectConfig = await window.electron.project.getConfig(projectFilePath);

        if (projectConfig?.zotero?.groupId) {
          setGroupId(projectConfig.zotero.groupId);
        } else {
          setGroupId('');
        }
        if (projectConfig?.zotero?.libraryID !== undefined) {
          setSelectedLibraryID(projectConfig.zotero.libraryID);
        } else {
          setSelectedLibraryID(undefined);
        }
        if (projectConfig?.zotero?.collectionKey) {
          setSelectedCollection(projectConfig.zotero.collectionKey);
        } else {
          setSelectedCollection('');
        }
      } else {
        setGroupId('');
        setSelectedLibraryID(undefined);
        setSelectedCollection('');
      }
    } catch (error) {
      console.error('Failed to load Zotero config:', error);
    }
  };

  const handleLibraryChange = (newLibraryID: number | undefined) => {
    setSelectedLibraryID(newLibraryID);
    // Reset collections when library changes
    setCollections([]);
    setSelectedCollection('');
  };

  const handleLoadCollections = async () => {
    if (!isConfigured) {
      await useDialogStore.getState().showAlert(t('zotero.import.configureFirst'));
      return;
    }

    setIsLoadingCollections(true);

    try {
      const result = await window.electron.zotero.listCollections(buildOptions());
      if (result.success && result.collections) {
        setCollections(result.collections);
      } else {
        await useDialogStore.getState().showAlert(t('zotero.import.loadCollectionsError'));
      }
    } catch (error) {
      console.error('Failed to load collections:', error);
      await useDialogStore.getState().showAlert(t('zotero.import.loadCollectionsError'));
    } finally {
      setIsLoadingCollections(false);
    }
  };

  const handleImport = async () => {
    if (!isConfigured) {
      await useDialogStore.getState().showAlert(t('zotero.import.configureFirst'));
      return;
    }

    setIsImporting(true);

    try {
      // Determine target directory based on current project
      let targetDirectory: string | undefined;
      let projectJsonPath: string | undefined;

      if (currentProject) {
        targetDirectory = currentProject.path;
        projectJsonPath = `${currentProject.path}/project.json`;
      }

      // Sync to get BibTeX
      const syncResult = await window.electron.zotero.sync(buildOptions({
        collectionKey: selectedCollection || undefined,
        downloadPDFs: false,
        exportBibTeX: true,
        targetDirectory,
      }));

      if (syncResult.success && syncResult.bibtexPath) {
        // Load the exported BibTeX into bibliography
        await useBibliographyStore.getState().loadBibliography(syncResult.bibtexPath);

        // Get the loaded citations
        const loadedCitations = useBibliographyStore.getState().citations;
        const citationCount = loadedCitations.length;

        // Enrich citations with Zotero attachment information (for PDF download)
        console.log('Enriching citations with Zotero attachment info...');
        const enrichResult = await window.electron.zotero.enrichCitations(buildOptions({
          citations: loadedCitations,
          collectionKey: selectedCollection || undefined,
        }));

        if (enrichResult.success && enrichResult.citations) {
          // Update store with enriched citations
          useBibliographyStore.setState({ citations: enrichResult.citations });

          // Count how many have PDF attachments available
          const withPDFs = enrichResult.citations.filter(
            (c: any) => c.zoteroAttachments && c.zoteroAttachments.length > 0
          ).length;
          console.log(`${withPDFs} citations have PDF attachments available in Zotero`);

          // Save metadata to persist zoteroAttachments across restarts
          if (targetDirectory) {
            try {
              await window.electron.bibliography.saveMetadata({
                projectPath: targetDirectory,
                citations: enrichResult.citations,
              });
            } catch (metaError) {
              console.error('Failed to save bibliography metadata:', metaError);
            }
          }
        } else {
          console.warn('Failed to enrich citations with attachment info:', enrichResult.error);
        }

        // If we have a project, save the bibliography source configuration
        if (projectJsonPath && currentProject) {
          const bibFileName = syncResult.bibtexPath.split('/').pop() || 'bibliography.bib';

          await window.electron.project.setBibliographySource({
            projectPath: projectJsonPath,
            type: 'zotero',
            filePath: bibFileName,
            zoteroCollection: selectedCollection || undefined,
          });
        }

        await useDialogStore.getState().showAlert(t('zotero.import.success', { count: citationCount }));

        // Reset selection
        setSelectedCollection('');
      } else {
        await useDialogStore.getState().showAlert(t('zotero.import.error', { error: syncResult.error }));
      }
    } catch (error) {
      console.error('Import failed:', error);
      await useDialogStore.getState().showAlert(t('zotero.import.genericError'));
    } finally {
      setIsImporting(false);
    }
  };

  const handleCheckUpdates = async () => {
    if (!isConfigured) {
      await useDialogStore.getState().showAlert(t('zotero.import.configureFirst'));
      return;
    }

    const citations = useBibliographyStore.getState().citations;
    if (citations.length === 0) {
      await useDialogStore.getState().showAlert('No citations in bibliography. Please import first.');
      return;
    }

    setIsCheckingUpdates(true);

    try {
      const result = await window.electron.zotero.checkUpdates(buildOptions({
        localCitations: citations,
        collectionKey: selectedCollection || undefined,
      }));

      if (result.success && result.diff) {
        if (result.hasChanges) {
          setSyncDiff(result.diff);
          setShowSyncModal(true);
        } else {
          await useDialogStore.getState().showAlert('Your bibliography is up to date! No changes detected.');
        }
      } else {
        await useDialogStore.getState().showAlert(`Failed to check updates: ${result.error}`);
      }
    } catch (error) {
      console.error('Failed to check updates:', error);
      await useDialogStore.getState().showAlert(`Error checking updates: ${error}`);
    } finally {
      setIsCheckingUpdates(false);
    }
  };

  const handleApplySync = async (strategy: 'local' | 'remote' | 'manual', resolution?: any) => {
    if (!syncDiff) return;

    setShowSyncModal(false);

    try {
      const currentCitations = useBibliographyStore.getState().citations;

      const result = await window.electron.zotero.applyUpdates(buildOptions({
        currentCitations,
        diff: syncDiff,
        strategy,
        resolution,
      }));

      if (result.success && result.finalCitations) {
        // Update bibliography store with new citations
        useBibliographyStore.setState({ citations: result.finalCitations });

        // Save metadata to persist zoteroAttachments across restarts
        if (currentProject?.path) {
          try {
            await window.electron.bibliography.saveMetadata({
              projectPath: currentProject.path,
              citations: result.finalCitations,
            });
          } catch (metaError) {
            console.error('Failed to save bibliography metadata:', metaError);
          }
        }

        // Show summary
        await useDialogStore.getState().showAlert(
          `Sync complete!\n\n` +
          `Added: ${result.addedCount}\n` +
          `Modified: ${result.modifiedCount}\n` +
          `Deleted: ${result.deletedCount}\n` +
          (result.skippedCount ? `Skipped: ${result.skippedCount}\n` : '')
        );

        // Clear sync diff
        setSyncDiff(null);
      } else {
        await useDialogStore.getState().showAlert(`Failed to apply updates: ${result.error}`);
      }
    } catch (error) {
      console.error('Failed to apply sync:', error);
      await useDialogStore.getState().showAlert(`Error applying sync: ${error}`);
    }
  };

  return (
    <div className="zotero-import">
      <div className="zotero-import-header">
        <h4>{t('zotero.import.title')}</h4>
        {!isConfigured && (
          <p className="zotero-warning">
            {t('zotero.import.configWarning')}
          </p>
        )}
        {!currentProject && (
          <p className="zotero-info">
            {t('zotero.import.projectInfo')}
          </p>
        )}
      </div>

      <div className="zotero-import-controls">
        {/* Library selector (local mode only) */}
        {zoteroMode === 'local' && libraries.length > 0 && (
          <div className="zotero-library-selector" style={{ marginBottom: '8px' }}>
            <select
              value={selectedLibraryID ?? ''}
              onChange={(e) => {
                const val = e.target.value;
                handleLibraryChange(val ? Number(val) : undefined);
              }}
              disabled={!isConfigured}
              className="zotero-select"
            >
              <option value="">{t('zotero.import.allLibraries')}</option>
              {libraries.map((lib) => (
                <option key={lib.libraryID} value={lib.libraryID}>
                  {lib.type === 'user' ? t('zotero.import.personalLibrary') : lib.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="zotero-collection-selector">
          <select
            value={selectedCollection}
            onChange={(e) => setSelectedCollection(e.target.value)}
            disabled={!isConfigured || collections.length === 0}
            className="zotero-select"
          >
            <option value="">
              {collections.length === 0 ? t('zotero.import.loadCollections') : t('zotero.import.allItems')}
            </option>
            {collections.map((col) => {
              const depth = getCollectionDepth(col.key);
              const indent = '\u00A0\u00A0\u00A0'.repeat(depth);
              const prefix = depth > 0 ? '└─ ' : '';
              return (
                <option key={col.key} value={col.key}>
                  {indent}{prefix}{col.name}
                </option>
              );
            })}
          </select>

          <button
            className="toolbar-btn"
            onClick={handleLoadCollections}
            disabled={!isConfigured || isLoadingCollections}
            title={t('zotero.import.loadCollectionsButton')}
          >
            <RefreshCw size={16} className={isLoadingCollections ? 'spinning' : ''} />
          </button>
        </div>

        <button
          className="zotero-import-btn"
          onClick={handleImport}
          disabled={!isConfigured || isImporting}
        >
          <Download size={16} />
          {isImporting ? t('zotero.import.importing') : t('zotero.import.importButton')}
        </button>

        <button
          className="zotero-update-btn"
          onClick={handleCheckUpdates}
          disabled={!isConfigured || isCheckingUpdates}
          title={t('zotero.import.checkUpdatesButton')}
        >
          <GitCompare size={16} />
          {isCheckingUpdates ? t('zotero.import.checking') : t('zotero.import.updateButton')}
        </button>
      </div>

      {/* Sync Preview Modal */}
      {syncDiff && (
        <SyncPreviewModal
          isOpen={showSyncModal}
          onClose={() => {
            setShowSyncModal(false);
            setSyncDiff(null);
          }}
          diff={syncDiff}
          onApplySync={handleApplySync}
        />
      )}
    </div>
  );
};
