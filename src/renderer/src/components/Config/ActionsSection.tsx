import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CollapsibleSection } from '../common/CollapsibleSection';
import './ConfigPanel.css';

export const ActionsSection: React.FC = () => {
  const { t } = useTranslation('common');
  const [stats, setStats] = useState({ totalDocuments: 0, totalChunks: 0, databasePath: '' });
  const [primaryStats, setPrimaryStats] = useState({ sourceCount: 0, chunkCount: 0, databasePath: '' });
  const [isPurging, setIsPurging] = useState(false);
  const [isPurgingPrimary, setIsPurgingPrimary] = useState(false);

  useEffect(() => {
    loadStats();
    loadPrimaryStats();
  }, []);

  const loadStats = async () => {
    try {
      const result = await window.electron.pdf.getStatistics();
      if (result.success && result.statistics) {
        setStats({
          totalDocuments: result.statistics.totalDocuments || 0,
          totalChunks: result.statistics.totalChunks || 0,
          databasePath: result.statistics.databasePath || '',
        });
      }
    } catch (error) {
      console.error('Failed to load stats:', error);
    }
  };

  const loadPrimaryStats = async () => {
    try {
      const result = await window.electron.tropy.getStatistics();
      if (result.success && result.statistics) {
        setPrimaryStats({
          sourceCount: result.statistics.sourceCount || 0,
          chunkCount: result.statistics.chunkCount || 0,
          databasePath: result.databasePath || '',
        });
      }
    } catch (error) {
      console.error('Failed to load primary sources stats:', error);
    }
  };

  const handlePurgeDatabase = async () => {
    const confirmMessage = t('actions.purgeDatabase.confirmMessage', {
      totalDocuments: stats.totalDocuments,
      totalChunks: stats.totalChunks
    });

    if (!window.confirm(confirmMessage)) {
      return;
    }

    // Double confirmation
    if (!window.confirm(t('actions.purgeDatabase.finalConfirm'))) {
      return;
    }

    setIsPurging(true);
    try {
      // Purge the vector database
      const result = await window.electron.pdf.purge();

      if (result.success) {
        console.log('✅ Database purged successfully');
        alert(t('actions.purgeDatabase.success'));
      } else {
        console.error('❌ Failed to purge database:', result.error);
        alert(t('actions.purgeDatabase.error', { error: result.error }));
      }

      // Reload statistics to show empty database
      await loadStats();
    } catch (error) {
      console.error('Failed to purge database:', error);
      alert(t('actions.purgeDatabase.error', { error: String(error) }));
    } finally {
      setIsPurging(false);
    }
  };

  const handlePurgePrimaryDatabase = async () => {
    const confirmMessage = t('actions.purgePrimaryDatabase.confirmMessage', {
      sourceCount: primaryStats.sourceCount,
      chunkCount: primaryStats.chunkCount
    });

    if (!window.confirm(confirmMessage)) {
      return;
    }

    // Double confirmation
    if (!window.confirm(t('actions.purgePrimaryDatabase.finalConfirm'))) {
      return;
    }

    setIsPurgingPrimary(true);
    try {
      const result = await window.electron.tropy.purge();

      if (result.success) {
        console.log('✅ Primary sources database purged successfully');
        alert(t('actions.purgePrimaryDatabase.success'));
      } else {
        console.error('❌ Failed to purge primary sources database:', result.error);
        alert(t('actions.purgePrimaryDatabase.error', { error: result.error }));
      }

      // Reload statistics to show empty database
      await loadPrimaryStats();
    } catch (error) {
      console.error('Failed to purge primary sources database:', error);
      alert(t('actions.purgePrimaryDatabase.error', { error: String(error) }));
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

  const handleCopyDatabasePath = () => {
    if (stats.databasePath) {
      navigator.clipboard.writeText(stats.databasePath);
      alert(t('actions.copyPath.success'));
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
            <label className="config-label" style={{ color: '#f48771' }}>
              {t('actions.dangerZone')}
            </label>

            {/* Purge Secondary Sources Database */}
            <div className="config-description" style={{ marginTop: '12px' }}>
              <strong>{t('actions.purgeDatabase.title')}</strong>
              <br />
              <small>
                {t('actions.purgeDatabase.description')}
                <br />
                {t('actions.purgeDatabase.warning')}
              </small>
            </div>
            <button
              className="config-btn-small"
              onClick={handlePurgeDatabase}
              disabled={isPurging || stats.totalDocuments === 0}
              style={{
                marginTop: '8px',
                background: '#c72e0f',
                color: '#ffffff',
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
                {t('actions.purgePrimaryDatabase.warning', 'You will need to re-sync your Tropy project.')}
              </small>
            </div>
            <button
              className="config-btn-small"
              onClick={handlePurgePrimaryDatabase}
              disabled={isPurgingPrimary || primaryStats.sourceCount === 0}
              style={{
                marginTop: '8px',
                background: '#c72e0f',
                color: '#ffffff',
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
