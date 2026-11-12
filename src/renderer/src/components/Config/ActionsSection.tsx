import React, { useState, useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CollapsibleSection } from '../common/CollapsibleSection';
import { useBibliographyStore } from '../../stores/bibliographyStore';
import { useDialogStore } from '../../stores/dialogStore';
import { usePrimarySourcesStore } from '../../stores/primarySourcesStore';
import { usePdfIndexStore } from '../../stores/pdfIndexStore';
import './ConfigPanel.css';

interface PdfStats {
  totalDocuments: number;
  totalChunks: number;
  databasePath: string;
}

interface PrimaryStats {
  sourceCount: number;
  chunkCount: number;
  databasePath: string;
}

export const ActionsSection: React.FC = () => {
  const { t } = useTranslation('common');
  const [stats, setStats] = useState<PdfStats>({ totalDocuments: 0, totalChunks: 0, databasePath: '' });
  const [primaryStats, setPrimaryStats] = useState<PrimaryStats>({ sourceCount: 0, chunkCount: 0, databasePath: '' });
  const [isPurging, setIsPurging] = useState(false);
  const [isPurgingPrimary, setIsPurgingPrimary] = useState(false);
  // Pas seulement au montage (S17-1-8) : relues quand des PDF s'indexent, ou que les sources
  // primaires changent. Un autre projet remonte la section (clé posée par ProjectPanel).
  const indexedPdfCount = useBibliographyStore((s) => s.indexedFilePaths.size);
  const primarySourceCount = usePrimarySourcesStore((s) => s.sources.length);

  useEffect(() => {
    loadStats();
  }, [indexedPdfCount]);

  useEffect(() => {
    loadPrimaryStats();
  }, [primarySourceCount]);

  /** Rend ce que le main a répondu, aussi affiché ; null s'il n'a rien pu dire. */
  const loadStats = async (): Promise<PdfStats | null> => {
    try {
      const result = await window.electron.pdf.getStatistics();
      if (result.success && result.statistics) {
        const read: PdfStats = {
          totalDocuments: result.statistics.totalDocuments || 0,
          totalChunks: result.statistics.totalChunks || 0,
          databasePath: result.statistics.databasePath || '',
        };
        setStats(read);
        return read;
      }
    } catch (error) {
      console.error('Failed to load stats:', error);
    }
    return null;
  };

  /** Rend ce que le main a répondu, aussi affiché ; null s'il n'a rien pu dire. */
  const loadPrimaryStats = async (): Promise<PrimaryStats | null> => {
    try {
      const result = await window.electron.tropy.getStatistics();
      if (result.success && result.statistics) {
        const read: PrimaryStats = {
          sourceCount: result.statistics.sourceCount || 0,
          chunkCount: result.statistics.chunkCount || 0,
          databasePath: result.databasePath || '',
        };
        setPrimaryStats(read);
        return read;
      }
    } catch (error) {
      console.error('Failed to load primary sources stats:', error);
    }
    return null;
  };

  const handlePurgeDatabase = async () => {
    // Relues juste avant : la confirmation cite ce que la base contient, pas ce qui était affiché.
    const current = (await loadStats()) ?? stats;
    const confirmMessage = t('actions.purgeDatabase.confirmMessage', {
      totalDocuments: current.totalDocuments,
      totalChunks: current.totalChunks
    });

    if (!await useDialogStore.getState().showConfirm(confirmMessage, undefined, { danger: true })) {
      return;
    }

    // Double confirmation
    if (!await useDialogStore.getState().showConfirm(t('actions.purgeDatabase.finalConfirm'), undefined, { danger: true })) {
      return;
    }

    setIsPurging(true);
    try {
      // Purge the vector database
      const result = await window.electron.pdf.purge();

      if (result.success) {
        console.log('✅ Database purged successfully');
        await useDialogStore.getState().showAlert(t('actions.purgeDatabase.success'));
      } else {
        console.error('❌ Failed to purge database:', result.error);
        await useDialogStore.getState().showAlert(t('actions.purgeDatabase.error', { error: result.error }));
      }

      // Reload statistics to show empty database
      await loadStats();
      // Purgée, la base emporte l'index des PDF : la reconstruction proposée à la réouverture
      // (bandeau Bibliographie, barre d'état) n'a plus d'objet. L'état du main fait foi (J8).
      await usePdfIndexStore.getState().refresh();
    } catch (error) {
      console.error('Failed to purge database:', error);
      await useDialogStore.getState().showAlert(t('actions.purgeDatabase.error', { error: String(error) }));
    } finally {
      setIsPurging(false);
    }
  };

  const handlePurgePrimaryDatabase = async () => {
    const current = (await loadPrimaryStats()) ?? primaryStats;
    const confirmMessage = t('actions.purgePrimaryDatabase.confirmMessage', {
      sourceCount: current.sourceCount,
      chunkCount: current.chunkCount
    });

    if (!await useDialogStore.getState().showConfirm(confirmMessage, undefined, { danger: true })) {
      return;
    }

    // Double confirmation
    if (!await useDialogStore.getState().showConfirm(t('actions.purgePrimaryDatabase.finalConfirm'), undefined, { danger: true })) {
      return;
    }

    setIsPurgingPrimary(true);
    try {
      const result = await window.electron.tropy.purge();

      if (result.success) {
        console.log('✅ Primary sources database purged successfully');
        // Le panneau Sources primaires ne garde ni le projet Tropy ni ses
        // sources, qui n'existent plus en base (S08-2-9).
        usePrimarySourcesStore.getState().reset();
        await useDialogStore.getState().showAlert(t('actions.purgePrimaryDatabase.success'));
      } else {
        console.error('❌ Failed to purge primary sources database:', result.error);
        await useDialogStore.getState().showAlert(t('actions.purgePrimaryDatabase.error', { error: result.error }));
      }

      // Reload statistics to show empty database
      await loadPrimaryStats();
    } catch (error) {
      console.error('Failed to purge primary sources database:', error);
      await useDialogStore.getState().showAlert(t('actions.purgePrimaryDatabase.error', { error: String(error) }));
    } finally {
      setIsPurgingPrimary(false);
    }
  };

  const handleOpenDatabaseFolder = () => {
    if (stats.databasePath) {
      // Extract directory from full path
      const directory = stats.databasePath.split('/').slice(0, -1).join('/');
      window.electron.shell?.openPath(directory);
    }
  };

  const handleCopyDatabasePath = async () => {
    if (stats.databasePath) {
      navigator.clipboard.writeText(stats.databasePath);
      await useDialogStore.getState().showAlert(t('actions.copyPath.success'));
    }
  };

  return (
    <CollapsibleSection title={t('actions.title')} defaultExpanded={false}>
      <div className="config-section">
        <div className="config-section-content">
          {/* Secondary Sources (PDFs) Database Info */}
          <div className="config-field">
            <label className="config-label">
              {t('actions.databaseInfo.title')}
            </label>
            <div className="config-description" style={{ marginTop: '8px' }}>
              <strong>{t('actions.databaseInfo.documentsIndexed')}:</strong> {stats.totalDocuments}
              <br />
              <strong>{t('actions.databaseInfo.chunksStored')}:</strong> {stats.totalChunks}
              <br />
              <strong>{t('actions.databaseInfo.path')}:</strong>
              <div className="database-path-display">
                {stats.databasePath || t('actions.databaseInfo.loading')}
              </div>
              <div style={{ marginTop: '8px', display: 'flex', gap: '8px' }}>
                <button
                  className="config-btn-small"
                  onClick={handleCopyDatabasePath}
                  disabled={!stats.databasePath}
                >
                  {t('actions.copyPath.button')}
                </button>
                <button
                  className="config-btn-small"
                  onClick={handleOpenDatabaseFolder}
                  disabled={!stats.databasePath}
                >
                  {t('actions.openFolder.button')}
                </button>
              </div>
            </div>
          </div>

          {/* Primary Sources (Tropy) Database Info */}
          <div className="config-field" style={{ marginTop: '24px' }}>
            <label className="config-label">
              {t('actions.primaryDatabaseInfo.title', 'Primary Sources Database (Tropy)')}
            </label>
            <div className="config-description" style={{ marginTop: '8px' }}>
              <strong>{t('actions.primaryDatabaseInfo.sourcesIndexed', 'Sources indexed')}:</strong> {primaryStats.sourceCount}
              <br />
              <strong>{t('actions.primaryDatabaseInfo.chunksStored', 'Chunks stored')}:</strong> {primaryStats.chunkCount}
              <br />
              <strong>{t('actions.databaseInfo.path')}:</strong>
              <div className="database-path-display">
                {primaryStats.databasePath || t('actions.databaseInfo.loading')}
              </div>
            </div>
          </div>

          {/* Danger Zone */}
          <div className="config-field" style={{ marginTop: '24px' }}>
            <label className="config-label" style={{ color: 'var(--color-warning)' }}>
              {t('actions.dangerZone')}
            </label>

            {/* Purge Secondary Sources Database */}
            <div className="config-description" style={{ marginTop: '12px' }}>
              <strong>{t('actions.purgeDatabase.title')}</strong>
              <br />
              <small>
                {t('actions.purgeDatabase.description')}
                <br />
                <AlertTriangle size={12} /> {t('actions.purgeDatabase.warning')}
              </small>
            </div>
            <button
              className="config-btn-small"
              onClick={handlePurgeDatabase}
              disabled={isPurging || stats.totalDocuments === 0}
              style={{
                marginTop: '8px',
                background: 'var(--color-danger)',
                color: 'var(--text-primary)',
                border: 'none',
              }}
            >
              {isPurging ? t('actions.purgeDatabase.inProgress') : t('actions.purgeDatabase.button')}
            </button>

            {/* Purge Primary Sources Database */}
            <div className="config-description" style={{ marginTop: '16px' }}>
              <strong>{t('actions.purgePrimaryDatabase.title', 'Purge Primary Sources Database')}</strong>
              <br />
              <small>
                {t('actions.purgePrimaryDatabase.description', 'This will delete all indexed Tropy sources and their embeddings.')}
                <br />
                <AlertTriangle size={12} /> {t('actions.purgePrimaryDatabase.warning', 'You will need to re-sync your Tropy project.')}
              </small>
            </div>
            <button
              className="config-btn-small"
              onClick={handlePurgePrimaryDatabase}
              disabled={isPurgingPrimary || primaryStats.sourceCount === 0}
              style={{
                marginTop: '8px',
                background: 'var(--color-danger)',
                color: 'var(--text-primary)',
                border: 'none',
              }}
            >
              {isPurgingPrimary
                ? t('actions.purgePrimaryDatabase.inProgress', 'Purging...')
                : t('actions.purgePrimaryDatabase.button', 'Purge Primary Sources')}
            </button>
          </div>
        </div>
      </div>
    </CollapsibleSection>
  );
};
