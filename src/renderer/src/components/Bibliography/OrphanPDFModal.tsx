import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, Archive, FolderOpen, AlertTriangle, X, RefreshCw } from 'lucide-react';
import './OrphanPDFModal.css';

interface OrphanPDFInfo {
  filePath: string;
  fileName: string;
  size: number;
  lastModified: Date;
}

interface OrphanPDFScanResult {
  orphans: OrphanPDFInfo[];
  totalOrphans: number;
  totalSize: number;
  scannedFiles: number;
  linkedFiles: number;
}

interface OrphanPDFModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectPath: string;
  citations: any[];
}

export const OrphanPDFModal: React.FC<OrphanPDFModalProps> = ({
  isOpen,
  onClose,
  projectPath,
  citations,
}) => {
  const { t } = useTranslation('common');

  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<OrphanPDFScanResult | null>(null);
  const [selectedOrphans, setSelectedOrphans] = useState<Set<string>>(new Set());
  const [actionInProgress, setActionInProgress] = useState(false);
  const [actionType, setActionType] = useState<'delete' | 'archive' | null>(null);

  // Scan for orphan PDFs when modal opens
  useEffect(() => {
    if (isOpen) {
      scanForOrphans();
    } else {
      // Reset state when modal closes
      setScanResult(null);
      setSelectedOrphans(new Set());
      setActionInProgress(false);
      setActionType(null);
    }
  }, [isOpen]);

  const scanForOrphans = async () => {
    setScanning(true);
    try {
      const result = await window.electron.bibliography.detectOrphanPDFs({
        projectPath,
        citations,
        includeSubdirectories: true,
      });

      if (result.success && result.data) {
        setScanResult(result.data);
        // Select all by default
        const allPaths = new Set(result.data.orphans?.map((o: OrphanPDFInfo) => o.filePath) || []);
        setSelectedOrphans(allPaths);
      } else {
        console.error('Failed to scan for orphan PDFs:', result.error);
        alert(`${t('bibliography.orphanPDFScanError')}: ${result.error}`);
      }
    } catch (error) {
      console.error('Error scanning for orphan PDFs:', error);
      alert(`${t('bibliography.orphanPDFScanError')}: ${error}`);
    } finally {
      setScanning(false);
    }
  };

  const toggleOrphan = (filePath: string) => {
    const newSelected = new Set(selectedOrphans);
    if (newSelected.has(filePath)) {
      newSelected.delete(filePath);
    } else {
      newSelected.add(filePath);
    }
    setSelectedOrphans(newSelected);
  };

  const toggleAll = () => {
    if (!scanResult) return;

    if (selectedOrphans.size === scanResult.orphans.length) {
      // Deselect all
      setSelectedOrphans(new Set());
    } else {
      // Select all
      const allPaths = new Set(scanResult.orphans.map((o) => o.filePath));
      setSelectedOrphans(allPaths);
    }
  };

  const handleDeleteOrphans = async () => {
    if (selectedOrphans.size === 0) {
      alert(t('bibliography.noOrphansSelected'));
      return;
    }

    const confirmed = window.confirm(
      t('bibliography.confirmDeleteOrphans', { count: selectedOrphans.size })
    );
    if (!confirmed) return;

    setActionInProgress(true);
    setActionType('delete');

    try {
      const result = await window.electron.bibliography.deleteOrphanPDFs(
        Array.from(selectedOrphans)
      );

      if (result.success) {
        alert(
          t('bibliography.orphanPDFsDeleted', {
            deleted: result.data.deleted,
            failed: result.data.failed.length,
          })
        );

        // Rescan after deletion
        await scanForOrphans();
      } else {
        alert(`${t('bibliography.orphanPDFDeleteError')}: ${result.error}`);
      }
    } catch (error) {
      console.error('Error deleting orphan PDFs:', error);
      alert(`${t('bibliography.orphanPDFDeleteError')}: ${error}`);
    } finally {
      setActionInProgress(false);
      setActionType(null);
    }
  };

  const handleArchiveOrphans = async () => {
    if (selectedOrphans.size === 0) {
      alert(t('bibliography.noOrphansSelected'));
      return;
    }

    const confirmed = window.confirm(
      t('bibliography.confirmArchiveOrphans', { count: selectedOrphans.size })
    );
    if (!confirmed) return;

    setActionInProgress(true);
    setActionType('archive');

    try {
      const result = await window.electron.bibliography.archiveOrphanPDFs({
        filePaths: Array.from(selectedOrphans),
        projectPath,
        archiveSubdir: 'orphan_pdfs',
      });

      if (result.success) {
        alert(
          t('bibliography.orphanPDFsArchived', {
            archived: result.data.archived,
            failed: result.data.failed.length,
            path: result.data.archivePath,
          })
        );

        // Rescan after archiving
        await scanForOrphans();
      } else {
        alert(`${t('bibliography.orphanPDFArchiveError')}: ${result.error}`);
      }
    } catch (error) {
      console.error('Error archiving orphan PDFs:', error);
      alert(`${t('bibliography.orphanPDFArchiveError')}: ${error}`);
    } finally {
      setActionInProgress(false);
      setActionType(null);
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${units[i]}`;
  };

  const formatDate = (date: Date): string => {
    return new Date(date).toLocaleString();
  };

  const selectedSize = scanResult
    ? scanResult.orphans
        .filter((o) => selectedOrphans.has(o.filePath))
        .reduce((sum, o) => sum + o.size, 0)
    : 0;

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content orphan-pdf-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{t('bibliography.orphanPDFCleanup')}</h3>
          <button className="close-button" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="modal-body">
        {/* Header with summary */}
        {!scanning && scanResult && (
          <div className="orphan-summary">
            <div className="summary-stat">
              <span className="stat-label">{t('bibliography.scannedFiles')}:</span>
              <span className="stat-value">{scanResult.scannedFiles}</span>
            </div>
            <div className="summary-stat">
              <span className="stat-label">{t('bibliography.linkedFiles')}:</span>
              <span className="stat-value">{scanResult.linkedFiles}</span>
            </div>
            <div className="summary-stat highlight">
              <span className="stat-label">{t('bibliography.orphanFiles')}:</span>
              <span className="stat-value">{scanResult.totalOrphans}</span>
            </div>
            <div className="summary-stat">
              <span className="stat-label">{t('bibliography.totalSize')}:</span>
              <span className="stat-value">{formatFileSize(scanResult.totalSize)}</span>
            </div>
          </div>
        )}

        {/* Scanning state */}
        {scanning && (
          <div className="scanning-state">
            <RefreshCw className="spinning" size={32} />
            <p>{t('bibliography.scanningForOrphans')}</p>
          </div>
        )}

        {/* No orphans found */}
        {!scanning && scanResult && scanResult.totalOrphans === 0 && (
          <div className="no-orphans-state">
            <FolderOpen size={48} strokeWidth={1} />
            <h3>{t('bibliography.noOrphansFound')}</h3>
            <p>{t('bibliography.noOrphansFoundDesc')}</p>
          </div>
        )}

        {/* Orphan list */}
        {!scanning && scanResult && scanResult.totalOrphans > 0 && (
          <>
            <div className="orphan-actions">
              <button
                className="btn-secondary btn-small"
                onClick={toggleAll}
                disabled={actionInProgress}
              >
                {selectedOrphans.size === scanResult.orphans.length
                  ? t('bibliography.deselectAll')
                  : t('bibliography.selectAll')}
              </button>

              <div className="selection-info">
                {t('bibliography.selectedOrphans', { count: selectedOrphans.size })}
                {selectedOrphans.size > 0 && ` (${formatFileSize(selectedSize)})`}
              </div>

              <button
                className="btn-secondary btn-small"
                onClick={scanForOrphans}
                disabled={actionInProgress}
              >
                <RefreshCw size={16} />
                {t('bibliography.rescan')}
              </button>
            </div>

            <div className="orphan-list">
              {scanResult.orphans.map((orphan) => (
                <div
                  key={orphan.filePath}
                  className={`orphan-item ${selectedOrphans.has(orphan.filePath) ? 'selected' : ''}`}
                  onClick={() => toggleOrphan(orphan.filePath)}
                >
                  <div className="orphan-checkbox">
                    <input
                      type="checkbox"
                      checked={selectedOrphans.has(orphan.filePath)}
                      onChange={() => toggleOrphan(orphan.filePath)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                  <div className="orphan-info">
                    <div className="orphan-filename">{orphan.fileName}</div>
                    <div className="orphan-meta">
                      <span className="orphan-size">{formatFileSize(orphan.size)}</span>
                      <span className="orphan-separator">•</span>
                      <span className="orphan-date">{formatDate(orphan.lastModified)}</span>
                    </div>
                    <div className="orphan-path">{orphan.filePath}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Warning message */}
            <div className="orphan-warning">
              <AlertTriangle size={20} />
              <div className="warning-text">
                <strong>{t('bibliography.orphanWarningTitle')}:</strong>{' '}
                {t('bibliography.orphanWarningMessage')}
              </div>
            </div>
          </>
        )}

        {/* Footer actions */}
        <div className="modal-footer orphan-footer">
          <button className="btn-secondary" onClick={onClose} disabled={actionInProgress}>
            <X size={20} />
            {t('common.close')}
          </button>

          {scanResult && scanResult.totalOrphans > 0 && (
            <>
              <button
                className="btn-warning"
                onClick={handleArchiveOrphans}
                disabled={actionInProgress || selectedOrphans.size === 0}
              >
                <Archive size={20} />
                {actionInProgress && actionType === 'archive'
                  ? t('bibliography.archiving')
                  : t('bibliography.archiveSelected')}
              </button>

              <button
                className="btn-danger"
                onClick={handleDeleteOrphans}
                disabled={actionInProgress || selectedOrphans.size === 0}
              >
                <Trash2 size={20} />
                {actionInProgress && actionType === 'delete'
                  ? t('bibliography.deleting')
                  : t('bibliography.deleteSelected')}
              </button>
            </>
          )}
        </div>
        </div>
      </div>
    </div>
  );
};
