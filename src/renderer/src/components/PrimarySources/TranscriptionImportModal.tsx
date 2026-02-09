import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, FileText, Upload, FolderOpen, CheckCircle, AlertCircle } from 'lucide-react';
import { usePrimarySourcesStore } from '../../stores/primarySourcesStore';
import './TranscriptionImportModal.css';

interface TranscriptionImportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type ImportMode = 'single' | 'directory';
type TranscriptionFormat = 'transkribus' | 'alto' | 'page-xml' | 'plain-text' | 'auto';

export const TranscriptionImportModal: React.FC<TranscriptionImportModalProps> = ({
  isOpen,
  onClose,
}) => {
  const { t } = useTranslation('common');
  const { selectedSourceId, importTranscription, syncTPY } = usePrimarySourcesStore();

  const [importMode, setImportMode] = useState<ImportMode>('single');
  const [selectedFormat, setSelectedFormat] = useState<TranscriptionFormat>('auto');
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ success: boolean; message: string } | null>(
    null
  );

  if (!isOpen) return null;

  const handleSingleFileImport = async () => {
    if (!selectedSourceId) {
      setImportResult({
        success: false,
        message: t('primarySources.selectSourceFirst', 'Please select a source first'),
      });
      return;
    }

    try {
      const result = await window.electron.dialog.openFile({
        filters: [
          { name: 'Transcription Files', extensions: ['xml', 'txt'] },
          { name: 'XML Files', extensions: ['xml'] },
          { name: 'Text Files', extensions: ['txt'] },
        ],
      });

      if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
        setIsImporting(true);
        const importResult = await importTranscription(selectedSourceId, result.filePaths[0]);

        if (importResult.success) {
          setImportResult({
            success: true,
            message: t('primarySources.importSuccess', 'Transcription imported successfully'),
          });
        } else {
          setImportResult({
            success: false,
            message: importResult.error || t('primarySources.importFailed', 'Import failed'),
          });
        }
        setIsImporting(false);
      }
    } catch (error: any) {
      setImportResult({
        success: false,
        message: error.message || t('primarySources.importFailed', 'Import failed'),
      });
      setIsImporting(false);
    }
  };

  const handleDirectoryImport = async () => {
    try {
      const result = await window.electron.dialog.openDirectory();

      if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
        setIsImporting(true);
        const transcriptionDirectory = result.filePaths[0];

        // Sync with transcription directory
        const syncResult = await syncTPY({
          performOCR: false,
          ocrLanguage: 'fra',
          transcriptionDirectory,
          forceReindex: true,
        });

        if (syncResult.success) {
          setImportResult({
            success: true,
            message: t(
              'primarySources.batchImportSuccess',
              `Imported transcriptions for ${syncResult.newItems || 0} sources`
            ),
          });
        } else {
          setImportResult({
            success: false,
            message: syncResult.errors?.join(', ') || t('primarySources.importFailed', 'Import failed'),
          });
        }
        setIsImporting(false);
      }
    } catch (error: any) {
      setImportResult({
        success: false,
        message: error.message || t('primarySources.importFailed', 'Import failed'),
      });
      setIsImporting(false);
    }
  };

  const handleImport = async () => {
    setImportResult(null);
    if (importMode === 'single') {
      await handleSingleFileImport();
    } else {
      await handleDirectoryImport();
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content transcription-import-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>
            <FileText size={20} strokeWidth={1} />
            {t('primarySources.importTranscription', 'Import Transcription')}
          </h3>
          <button className="close-button" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="modal-body">
          <p className="modal-description">
            {t(
              'primarySources.importDescription',
              'Import transcriptions from external tools like Transkribus. Supports ALTO XML, PAGE XML, and plain text formats.'
            )}
          </p>

          {/* Import Mode Selection */}
          <div className="import-mode-selector">
            <button
              className={`mode-option ${importMode === 'single' ? 'active' : ''}`}
              onClick={() => setImportMode('single')}
            >
              <FileText size={24} strokeWidth={1} />
              <div className="mode-content">
                <h4>{t('primarySources.singleFile', 'Single File')}</h4>
                <p>{t('primarySources.singleFileDesc', 'Import one transcription for the selected source')}</p>
              </div>
            </button>

            <button
              className={`mode-option ${importMode === 'directory' ? 'active' : ''}`}
              onClick={() => setImportMode('directory')}
            >
              <FolderOpen size={24} strokeWidth={1} />
              <div className="mode-content">
                <h4>{t('primarySources.batchImport', 'Batch Import')}</h4>
                <p>{t('primarySources.batchImportDesc', 'Import all transcriptions from a folder')}</p>
              </div>
            </button>
          </div>

          {/* Format Selection */}
          <div className="form-group">
            <label htmlFor="transcription-format">
              {t('primarySources.format', 'File Format')}
            </label>
            <select
              id="transcription-format"
              value={selectedFormat}
              onChange={(e) => setSelectedFormat(e.target.value as TranscriptionFormat)}
            >
              <option value="auto">
                {t('primarySources.autoDetect', 'Auto-detect')}
              </option>
              <option value="transkribus">Transkribus Export</option>
              <option value="alto">ALTO XML</option>
              <option value="page-xml">PAGE XML</option>
              <option value="plain-text">{t('primarySources.plainText', 'Plain Text')}</option>
            </select>
          </div>

          {/* Single File Mode Warning */}
          {importMode === 'single' && !selectedSourceId && (
            <div className="import-warning">
              <AlertCircle size={16} strokeWidth={1} />
              <span>
                {t(
                  'primarySources.selectSourceWarning',
                  'Select a source in the list before importing a single file.'
                )}
              </span>
            </div>
          )}

          {/* Result Message */}
          {importResult && (
            <div className={`import-result ${importResult.success ? 'success' : 'error'}`}>
              {importResult.success ? (
                <CheckCircle size={16} strokeWidth={1} />
              ) : (
                <AlertCircle size={16} strokeWidth={1} />
              )}
              <span>{importResult.message}</span>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-cancel" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            className="btn-primary"
            onClick={handleImport}
            disabled={isImporting || (importMode === 'single' && !selectedSourceId)}
          >
            <Upload size={16} strokeWidth={1} />
            {isImporting
              ? t('primarySources.importing', 'Importing...')
              : t('primarySources.import', 'Import')}
          </button>
        </div>
      </div>
    </div>
  );
};
