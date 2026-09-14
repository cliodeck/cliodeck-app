import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, RefreshCw } from 'lucide-react';
import { useBibliographyStore } from '../../stores/bibliographyStore';
import { useProjectStore } from '../../stores/projectStore';
import { useDialogStore } from '../../stores/dialogStore';

interface ZoteroCollection {
  key: string;
  name: string;
  parentCollection?: string;
}

/** Rapport de synchronisation renvoyé par le processus principal. */
interface SyncEntry {
  id: string;
  title: string;
}

interface SyncReport {
  collectionChange: { from: string; to: string } | null;
  added: SyncEntry[];
  modified: Array<SyncEntry & { fields: string[] }>;
  deleted: SyncEntry[];
  unchangedCount: number;
  localOnlyCount: number;
  renamedKeys: Array<{ from: string; to: string; title: string }>;
  duplicates: Array<{ title: string; keys: string[] }>;
  warnings: Array<{ kind: string; expected: number; written: number }>;
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
  const [isSyncing, setIsSyncing] = useState(false);

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic options bag passed to typed IPC
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
        } else if (projectConfig?.bibliographySource?.zoteroCollection) {
          // Projets dont l'association n'a été écrite que par l'import
          // (champ historique) : sans ce repli, la collection choisie au
          // dropdown n'était jamais re-proposée (#9) et la resync
          // suivante l'écrasait par undefined (#20).
          setSelectedCollection(projectConfig.bibliographySource.zoteroCollection);
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

  /**
   * Un écart entre la collection et le fichier écrit est une référence
   * perdue : l'import ne peut pas se contenter d'annoncer un succès.
   */
  const describeSyncWarnings = (
    warnings?: Array<{ kind: string; expected: number; written: number }>
  ): string => {
    if (!warnings || warnings.length === 0) return '';
    return warnings
      .filter((w) => w.kind === 'count-mismatch')
      .map((w) => `\n\n⚠️ ${t('zotero.import.countMismatch', { expected: w.expected, written: w.written })}`)
      .join('');
  };

  /**
   * Les doublons sont signalés, jamais fusionnés : la correction se fait
   * dans Zotero, et deux notices proches peuvent être deux éditions.
   */
  const describeDuplicates = (
    duplicates?: Array<{ title: string; keys: string[] }>
  ): string => {
    if (!duplicates || duplicates.length === 0) return '';
    const SHOWN = 5;
    const lines = duplicates
      .slice(0, SHOWN)
      .map((d) => `• ${d.title} (×${d.keys.length})`);
    if (duplicates.length > SHOWN) {
      lines.push(t('zotero.import.duplicatesMore', { count: duplicates.length - SHOWN }));
    }
    return `\n\n${t('zotero.import.duplicatesFound', { count: duplicates.length })}\n${lines.join('\n')}`;
  };

  /** Nom lisible d'une collection, sa clé à défaut (liste non chargée). */
  const collectionName = (key: string): string =>
    collections.find((c) => c.key === key)?.name ?? key;

  /** Quelques lignes d'une liste, puis « … et N autres ». */
  const listSome = (lines: string[], shown = 8): string => {
    const head = lines.slice(0, shown);
    if (lines.length > shown) {
      head.push(t('zotero.sync.more', { count: lines.length - shown }));
    }
    return head.join('\n');
  };

  /** Ce qui sera détruit, formulé avant d'agir. */
  const describeConfirmation = (report: SyncReport): string => {
    const parts: string[] = [];
    if (report.collectionChange) {
      parts.push(
        t('zotero.sync.confirmCollectionChange', {
          from: collectionName(report.collectionChange.from),
          to: collectionName(report.collectionChange.to),
        })
      );
    }
    if (report.deleted.length > 0) {
      parts.push(
        `${t('zotero.sync.confirmDeletions', { count: report.deleted.length })}\n` +
          listSome(report.deleted.map((d) => `• ${d.title} — @${d.id}`))
      );
    }
    if (report.added.length > 0) {
      parts.push(t('zotero.sync.confirmAdditions', { count: report.added.length }));
    }
    return parts.join('\n\n');
  };

  /** Compte rendu après écriture. */
  const describeOutcome = (report: SyncReport): string => {
    const changed =
      report.added.length + report.modified.length + report.deleted.length + report.renamedKeys.length > 0 ||
      report.collectionChange !== null;
    const parts: string[] = [
      changed
        ? t('zotero.sync.summary', {
            added: report.added.length,
            modified: report.modified.length,
            deleted: report.deleted.length,
          })
        : t('zotero.sync.upToDate'),
    ];
    if (report.renamedKeys.length > 0) {
      // Une clé refaite peut toucher le texte : l'auteur doit savoir laquelle.
      parts.push(
        `${t('zotero.sync.renamedKeys', { count: report.renamedKeys.length })}\n` +
          listSome(report.renamedKeys.map((r) => `• @${r.from} → @${r.to}`))
      );
    }
    if (report.localOnlyCount > 0) {
      parts.push(t('zotero.sync.localKept', { count: report.localOnlyCount }));
    }
    return parts.join('\n\n') + describeSyncWarnings(report.warnings) + describeDuplicates(report.duplicates);
  };

  /**
   * Le seul geste Zotero : premier import, mise à jour ou changement de
   * collection, selon l'état du projet — c'est le processus principal qui
   * en décide, en lisant le fichier du projet. Rien de destructeur sans
   * accord : s'il faut retirer des références ou changer de collection, on
   * demande d'abord.
   */
  const handleSynchronize = async () => {
    if (!isConfigured) {
      await useDialogStore.getState().showAlert(t('zotero.import.configureFirst'));
      return;
    }
    if (!currentProject?.path) {
      await useDialogStore.getState().showAlert(t('zotero.import.projectInfo'));
      return;
    }
    if (!selectedCollection) {
      await useDialogStore.getState().showAlert(t('zotero.sync.chooseCollection'));
      return;
    }

    setIsSyncing(true);
    try {
      let result = await window.electron.zotero.synchronize(
        buildOptions({ collectionKey: selectedCollection })
      );

      if (result.success && result.status === 'needs-confirmation' && result.report) {
        const confirmed = await useDialogStore
          .getState()
          .showConfirm(describeConfirmation(result.report as SyncReport), t('zotero.sync.confirmTitle'));
        if (!confirmed) return;
        result = await window.electron.zotero.synchronize(
          buildOptions({ collectionKey: selectedCollection, confirmed: true })
        );
      }

      if (!result.success || result.status !== 'applied' || !result.report) {
        await useDialogStore
          .getState()
          .showAlert(t('zotero.sync.error', { error: result.error ?? 'unknown' }));
        return;
      }

      // Le panneau relit le fichier : c'est lui qui fait foi.
      if (result.bibtexPath) {
        await useBibliographyStore
          .getState()
          .loadBibliographyWithMetadata(result.bibtexPath, currentProject.path);
      }

      await useDialogStore.getState().showAlert(describeOutcome(result.report as SyncReport));
    } catch (error) {
      console.error('Zotero synchronization failed:', error);
      await useDialogStore.getState().showAlert(t('zotero.import.genericError'));
    } finally {
      setIsSyncing(false);
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
            {/* Pas d'option « toute la bibliothèque » : un projet suit une
                collection, sous-collections comprises. */}
            <option value="" disabled>
              {collections.length === 0 ? t('zotero.import.loadCollections') : t('zotero.sync.chooseCollection')}
            </option>
            {/* Collection mémorisée du projet, avant chargement de la liste :
                sans cette option le select affichait « vide » alors que la
                synchro utiliserait bien la collection sauvegardée (#9). */}
            {selectedCollection &&
              !collections.some((col) => col.key === selectedCollection) && (
                <option value={selectedCollection}>
                  {t('zotero.import.savedCollection', { key: selectedCollection })}
                </option>
              )}
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
          onClick={handleSynchronize}
          disabled={!isConfigured || isSyncing || !selectedCollection || !currentProject}
          title={t('zotero.sync.buttonHint')}
        >
          <Download size={16} />
          {isSyncing ? t('zotero.sync.running') : t('zotero.sync.button')}
        </button>
      </div>
    </div>
  );
};
