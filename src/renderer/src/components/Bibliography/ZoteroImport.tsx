import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, RefreshCw, GitCompare } from 'lucide-react';
import { useBibliographyStore } from '../../stores/bibliographyStore';
import { useProjectStore } from '../../stores/projectStore';
import { SyncPreviewModal } from './SyncPreviewModal';

interface ZoteroCollection {
  key: string;
  name: string;
  parentCollection?: string;
}

export const ZoteroImport: React.FC = () => {
  const { t } = useTranslation('common');
  const currentProject = useProjectStore((state) => state.currentProject);
  const [userId, setUserId] = useState<string>('');
  const [apiKey, setApiKey] = useState<string>('');
  const [groupId, setGroupId] = useState<string>('');
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

  // Load config on mount and when project changes
  useEffect(() => {
    loadZoteroConfig();
  }, [currentProject]);

  const loadZoteroConfig = async () => {
    try {
      // Load global Zotero config (userId and apiKey only - groupId is per-project)
      const globalConfig = await window.electron.config.get('zotero');
      if (globalConfig) {
        setUserId(globalConfig.userId || '');
        setApiKey(globalConfig.apiKey || '');
      }

      // Load project-specific Zotero config (groupId and collectionKey)
      if (currentProject?.path) {
        const projectFilePath = `${currentProject.path}/project.json`;
        const projectConfig = await window.electron.project.getConfig(projectFilePath);
        // groupId comes from project config only
        if (projectConfig?.zotero?.groupId) {
          setGroupId(projectConfig.zotero.groupId);
          console.log('📁 Using project groupId:', projectConfig.zotero.groupId);
        } else {
          setGroupId(''); // No groupId = personal library
        }
        if (projectConfig?.zotero?.collectionKey) {
          setSelectedCollection(projectConfig.zotero.collectionKey);
          console.log('📁 Using project collectionKey:', projectConfig.zotero.collectionKey);
        } else {
          setSelectedCollection('');
        }
      } else {
        // No project open - reset project-specific settings
        setGroupId('');
        setSelectedCollection('');
      }
    } catch (error) {
      console.error('Failed to load Zotero config:', error);
    }
  };

  const handleLoadCollections = async () => {
    if (!userId || !apiKey) {
      alert(t('zotero.import.configureFirst'));
      return;
    }

    setIsLoadingCollections(true);

    try {
      const result = await window.electron.zotero.listCollections(userId, apiKey, groupId || undefined);
      if (result.success && result.collections) {
        setCollections(result.collections);
      } else {
        alert(t('zotero.import.loadCollectionsError'));
      }
    } catch (error) {
      console.error('Failed to load collections:', error);
      alert(t('zotero.import.loadCollectionsError'));
    } finally {
      setIsLoadingCollections(false);
    }
  };

  const handleImport = async () => {
    if (!userId || !apiKey) {
      alert(t('zotero.import.configureFirst'));
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

      console.log('🔍 Zotero import - Project paths:', {
        currentProjectPath: currentProject?.path,
        targetDirectory,
        projectJsonPath
      });

      // Sync to get BibTeX
      const syncResult = await window.electron.zotero.sync({
        userId,
        apiKey,
        groupId: groupId || undefined,
        collectionKey: selectedCollection || undefined,
        downloadPDFs: false,
        exportBibTeX: true,
        targetDirectory,
      });

      if (syncResult.success && syncResult.bibtexPath) {
        // Load the exported BibTeX into bibliography
        await useBibliographyStore.getState().loadBibliography(syncResult.bibtexPath);

        // Get the loaded citations
        const loadedCitations = useBibliographyStore.getState().citations;
        const citationCount = loadedCitations.length;

        // Enrich citations with Zotero attachment information (for PDF download)
        console.log('🔗 Enriching citations with Zotero attachment info...');
        const enrichResult = await window.electron.zotero.enrichCitations({
          userId,
          apiKey,
          groupId: groupId || undefined,
          citations: loadedCitations,
          collectionKey: selectedCollection || undefined,
        });

        if (enrichResult.success && enrichResult.citations) {
          // Update store with enriched citations
          useBibliographyStore.setState({ citations: enrichResult.citations });
          console.log(`✅ Enriched ${enrichResult.citations.length} citations with attachment info`);

          // Count how many have PDF attachments available
          const withPDFs = enrichResult.citations.filter(
            (c: any) => c.zoteroAttachments && c.zoteroAttachments.length > 0
          ).length;
          console.log(`📎 ${withPDFs} citations have PDF attachments available in Zotero`);

          // Save metadata to persist zoteroAttachments across restarts
          if (targetDirectory) {
            try {
              await window.electron.bibliography.saveMetadata({
                projectPath: targetDirectory,
                citations: enrichResult.citations,
              });
              console.log('💾 Bibliography metadata saved for persistence');
            } catch (metaError) {
              console.error('⚠️ Failed to save bibliography metadata:', metaError);
            }
          }
        } else {
          console.warn('⚠️ Failed to enrich citations with attachment info:', enrichResult.error);
        }

        // If we have a project, save the bibliography source configuration
        if (projectJsonPath && currentProject) {
          // Get just the filename for relative path
          const bibFileName = syncResult.bibtexPath.split('/').pop() || 'bibliography.bib';

          await window.electron.project.setBibliographySource({
            projectPath: projectJsonPath,
            type: 'zotero',
            filePath: bibFileName,
            zoteroCollection: selectedCollection || undefined,
          });

          console.log('✅ Bibliography source saved to project');
        }

        alert(t('zotero.import.success', { count: citationCount }));

        // Reset selection
        setSelectedCollection('');
      } else {
        alert(t('zotero.import.error', { error: syncResult.error }));
      }
    } catch (error) {
      console.error('Import failed:', error);
      alert(t('zotero.import.genericError'));
    } finally {
      setIsImporting(false);
    }
  };

  const handleCheckUpdates = async () => {
    if (!userId || !apiKey) {
      alert(t('zotero.import.configureFirst'));
      return;
    }

    const citations = useBibliographyStore.getState().citations;
    if (citations.length === 0) {
      alert('No citations in bibliography. Please import first.');
      return;
    }

    setIsCheckingUpdates(true);

    try {
      const result = await window.electron.zotero.checkUpdates({
        userId,
        apiKey,
        groupId: groupId || undefined,
        localCitations: citations,
        collectionKey: selectedCollection || undefined,
      });

      if (result.success && result.diff) {
        if (result.hasChanges) {
          setSyncDiff(result.diff);
          setShowSyncModal(true);
        } else {
          alert('Your bibliography is up to date! No changes detected.');
        }
      } else {
        alert(`Failed to check updates: ${result.error}`);
      }
    } catch (error) {
      console.error('Failed to check updates:', error);
      alert(`Error checking updates: ${error}`);
    } finally {
      setIsCheckingUpdates(false);
    }
  };

  const handleApplySync = async (strategy: 'local' | 'remote' | 'manual', resolution?: any) => {
    if (!syncDiff) return;

    setShowSyncModal(false);

    try {
      const currentCitations = useBibliographyStore.getState().citations;

      const result = await window.electron.zotero.applyUpdates({
        userId,
        apiKey,
        groupId: groupId || undefined,
        currentCitations,
        diff: syncDiff,
        strategy,
        resolution,
      });

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
            console.log('💾 Bibliography metadata saved after sync');
          } catch (metaError) {
            console.error('⚠️ Failed to save bibliography metadata:', metaError);
          }
        }

        // Show summary
        alert(
          `Sync complete!\n\n` +
          `Added: ${result.addedCount}\n` +
          `Modified: ${result.modifiedCount}\n` +
          `Deleted: ${result.deletedCount}\n` +
          (result.skippedCount ? `Skipped: ${result.skippedCount}\n` : '')
        );

        // Clear sync diff
        setSyncDiff(null);
      } else {
        alert(`Failed to apply updates: ${result.error}`);
      }
    } catch (error) {
      console.error('Failed to apply sync:', error);
      alert(`Error applying sync: ${error}`);
    }
  };

  return (
    <div className="zotero-import">
      <div className="zotero-import-header">
        <h4>{t('zotero.import.title')}</h4>
        {(!userId || !apiKey) && (
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
        <div className="zotero-collection-selector">
          <select
            value={selectedCollection}
            onChange={(e) => setSelectedCollection(e.target.value)}
            disabled={!userId || !apiKey || collections.length === 0}
            className="zotero-select"
          >
            <option value="">
              {collections.length === 0 ? t('zotero.import.loadCollections') : t('zotero.import.allCollections')}
            </option>
            {collections.map((col) => {
              const depth = getCollectionDepth(col.key);
              const indent = '\u00A0\u00A0\u00A0'.repeat(depth); // Non-breaking spaces for indentation
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
            disabled={!userId || !apiKey || isLoadingCollections}
            title={t('zotero.import.loadCollectionsButton')}
          >
            <RefreshCw size={16} className={isLoadingCollections ? 'spinning' : ''} />
          </button>
        </div>

        <button
          className="zotero-import-btn"
          onClick={handleImport}
          disabled={!userId || !apiKey || isImporting}
        >
          <Download size={16} />
          {isImporting ? t('zotero.import.importing') : t('zotero.import.importButton')}
        </button>

        <button
          className="zotero-update-btn"
          onClick={handleCheckUpdates}
          disabled={!userId || !apiKey || isCheckingUpdates}
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
