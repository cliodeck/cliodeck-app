import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, RefreshCw, X } from 'lucide-react';
import './PDFModificationNotification.css';

interface ModifiedPDF {
  citationId: string;
  citationTitle: string;
  filePath: string;
  reason: string; // 'md5-changed' | 'file-modified'
}

interface PDFModificationNotificationProps {
  modifiedPDFs: ModifiedPDF[];
  onReindexAll: () => void;
  onReindexSingle: (citationId: string) => void;
  onDismiss: () => void;
}

export const PDFModificationNotification: React.FC<PDFModificationNotificationProps> = ({
  modifiedPDFs,
  onReindexAll,
  onReindexSingle,
  onDismiss,
}) => {
  const { t } = useTranslation('common');
  const [expanded, setExpanded] = useState(false);

  if (modifiedPDFs.length === 0) return null;

  return (
    <div className="pdf-modification-notification">
      <div className="notification-header">
        <div className="notification-icon">
          <AlertCircle size={20} />
        </div>
        <div className="notification-content">
          <div className="notification-title">
            {t('bibliography.modifiedPDFsDetected', { count: modifiedPDFs.length })}
          </div>
          <div className="notification-message">
            {t('bibliography.modifiedPDFsMessage')}
          </div>
        </div>
        <div className="notification-actions">
          <button
            className="notification-btn notification-btn-primary"
            onClick={onReindexAll}
            title={t('bibliography.reindexAll')}
          >
            <RefreshCw size={16} />
            {t('bibliography.reindexAll')}
          </button>
          {modifiedPDFs.length > 1 && (
            <button
              className="notification-btn notification-btn-secondary"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? t('common.showLess') : t('common.showMore')}
            </button>
          )}
          <button
            className="notification-btn notification-btn-close"
            onClick={onDismiss}
            title={t('common.dismiss')}
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="notification-details">
          <ul className="modified-pdfs-list">
            {modifiedPDFs.map((pdf) => (
              <li key={pdf.citationId} className="modified-pdf-item">
                <div className="modified-pdf-info">
                  <div className="modified-pdf-title">{pdf.citationTitle}</div>
                  <div className="modified-pdf-path">{pdf.filePath}</div>
                </div>
                <button
                  className="notification-btn notification-btn-small"
                  onClick={() => onReindexSingle(pdf.citationId)}
                >
                  <RefreshCw size={14} />
                  {t('bibliography.reindex')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

/**
 * Hook to detect modified PDFs and show notification
 */
export const usePDFModificationDetection = (
  citations: any[],
  projectPath: string | undefined
): {
  modifiedPDFs: ModifiedPDF[];
  checkForModifications: () => Promise<void>;
  dismissNotification: () => void;
} => {
  const [modifiedPDFs, setModifiedPDFs] = useState<ModifiedPDF[]>([]);

  const checkForModifications = async () => {
    if (!projectPath || citations.length === 0) return;

    try {
      // Call backend to check MD5 hashes
      const result = await window.electron.pdf.checkModifiedPDFs({
        citations,
        projectPath,
      });

      if (result.success && result.data?.modifiedPDFs && result.data.modifiedPDFs.length > 0) {
        setModifiedPDFs(result.data.modifiedPDFs);
      }
    } catch (error) {
      console.error('Failed to check for modified PDFs:', error);
    }
  };

  const dismissNotification = () => {
    setModifiedPDFs([]);
  };

  // Check on mount and periodically
  useEffect(() => {
    checkForModifications();

    // Check every 5 minutes
    const interval = setInterval(() => {
      checkForModifications();
    }, 5 * 60 * 1000);

    return () => clearInterval(interval);
  }, [citations, projectPath]);

  return {
    modifiedPDFs,
    checkForModifications,
    dismissNotification,
  };
};
