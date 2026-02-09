import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Languages, Play, AlertCircle } from 'lucide-react';
import { usePrimarySourcesStore } from '../../stores/primarySourcesStore';
import './OCRSettingsModal.css';

interface OCRSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const OCRSettingsModal: React.FC<OCRSettingsModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation('common');
  const {
    availableOCRLanguages,
    syncTPY,
    isSyncing,
    syncProgress,
    loadOCRLanguages,
  } = usePrimarySourcesStore();

  const [selectedLanguage, setSelectedLanguage] = useState('fra');
  const [performOCROnSync, setPerformOCROnSync] = useState(false);

  useEffect(() => {
    if (isOpen && availableOCRLanguages.length === 0) {
      loadOCRLanguages();
    }
  }, [isOpen, availableOCRLanguages.length, loadOCRLanguages]);

  if (!isOpen) return null;

  const handleSyncWithOCR = async () => {
    await syncTPY({
      performOCR: true,
      ocrLanguage: selectedLanguage,
      forceReindex: performOCROnSync,
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content ocr-settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>
            <Languages size={20} strokeWidth={1} />
            {t('primarySources.ocrSettings', 'OCR Settings')}
          </h3>
          <button className="close-button" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="modal-body">
          <p className="modal-description">
            {t(
              'primarySources.ocrDescription',
              'Configure OCR (Optical Character Recognition) for extracting text from archival photos. Tesseract.js will analyze images and convert them to searchable text.'
            )}
          </p>

          {/* Language Selection */}
          <div className="form-group">
            <label htmlFor="ocr-language">
              {t('primarySources.ocrLanguage', 'Document Language')}
            </label>
            <select
              id="ocr-language"
              value={selectedLanguage}
              onChange={(e) => setSelectedLanguage(e.target.value)}
            >
              {availableOCRLanguages.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.name}
                </option>
              ))}
            </select>
            <span className="form-hint">
              {t(
                'primarySources.languageHint',
                'Select the primary language of your archival documents for better accuracy.'
              )}
            </span>
          </div>

          {/* OCR Options */}
          <div className="form-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={performOCROnSync}
                onChange={(e) => setPerformOCROnSync(e.target.checked)}
              />
              <span>
                {t('primarySources.forceOCR', 'Re-run OCR on all sources (ignore existing transcriptions)')}
              </span>
            </label>
          </div>

          {/* Warning */}
          <div className="ocr-warning">
            <AlertCircle size={16} strokeWidth={1} />
            <span>
              {t(
                'primarySources.ocrWarning',
                'OCR can take several minutes for large collections. The process runs locally on your computer.'
              )}
            </span>
          </div>

          {/* Progress */}
          {isSyncing && syncProgress && (
            <div className="ocr-progress">
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${(syncProgress.current / syncProgress.total) * 100}%` }}
                />
              </div>
              <span className="progress-text">
                {syncProgress.phase === 'processing' &&
                  `${t('primarySources.processingOCR', 'Processing')} ${syncProgress.current}/${syncProgress.total}`}
                {syncProgress.currentItem && ` - ${syncProgress.currentItem}`}
              </span>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-cancel" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            className="btn-primary"
            onClick={handleSyncWithOCR}
            disabled={isSyncing}
          >
            <Play size={16} strokeWidth={1} />
            {isSyncing
              ? t('primarySources.processing', 'Processing...')
              : t('primarySources.runOCR', 'Run OCR')}
          </button>
        </div>
      </div>
    </div>
  );
};
