import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Languages, Play, AlertCircle, CheckCircle2 } from 'lucide-react';
import { usePrimarySourcesStore, type SyncOutcome } from '../../stores/primarySourcesStore';
import './OCRSettingsModal.css';

import { useFocusTrap } from '../../hooks/useFocusTrap';
interface OCRSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const OCRSettingsModal: React.FC<OCRSettingsModalProps> = ({ isOpen, onClose }) => {
  // Échap ferme la modale (le piège de focus s'active quand la ref
  // est attachée au conteneur).
  const trapRef = useFocusTrap({ active: isOpen, onEscape: onClose });
  const { t } = useTranslation('common');
  const {
    availableOCRLanguages,
    syncTPY,
    isSyncing,
    syncProgress,
    loadOCRLanguages,
  } = usePrimarySourcesStore();

  // Langue OCR : dans le store (et plus en état local) pour que l'OCR
  // manuel par source (#23) utilise le même réglage que la synchro.
  const { ocrLanguage: selectedLanguage, setOCRLanguage: setSelectedLanguage } =
    usePrimarySourcesStore();
  // `forceReindex` côté synchro : relance la reconnaissance sur les sources
  // DÉJÀ transcrites. Décochée, seules les sources sans transcription sont
  // traitées.
  const [forceOCR, setForceOCR] = useState(false);
  const [outcome, setOutcome] = useState<SyncOutcome | null>(null);

  useEffect(() => {
    if (isOpen && availableOCRLanguages.length === 0) {
      loadOCRLanguages();
    }
  }, [isOpen, availableOCRLanguages.length, loadOCRLanguages]);

  // Un bilan de la passe précédente ne doit pas accueillir la suivante.
  useEffect(() => {
    if (isOpen) setOutcome(null);
  }, [isOpen]);

  if (!isOpen) return null;

  // La modale se refermait ici même : après des heures d'OCR, l'utilisateur
  // n'apprenait ni combien de transcriptions avaient été écrites, ni qu'il
  // n'y en avait aucune. On garde la fenêtre ouverte sur le bilan.
  const handleSyncWithOCR = async () => {
    setOutcome(null);
    const result = await syncTPY({
      performOCR: true,
      ocrLanguage: selectedLanguage,
      forceReindex: forceOCR,
    });
    setOutcome(result);
  };

  return (
    <div ref={trapRef} className="modal-overlay" onClick={onClose}>
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
                checked={forceOCR}
                onChange={(e) => setForceOCR(e.target.checked)}
              />
              <span>
                {t('primarySources.forceOCR', 'Re-run OCR on all sources (ignore existing transcriptions)')}
              </span>
            </label>
            <span className="form-hint">
              {t(
                'primarySources.forceOCRHint',
                'When unchecked, recognition only processes sources that have no transcription yet — transcriptions already obtained are kept.'
              )}
            </span>
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

          {/* Bilan de la passe */}
          {!isSyncing && outcome && (
            <div className={`ocr-summary ${outcome.success ? '' : 'ocr-summary--failed'}`}>
              <div className="ocr-summary__header">
                {outcome.success ? (
                  <CheckCircle2 size={16} strokeWidth={1} />
                ) : (
                  <AlertCircle size={16} strokeWidth={1} />
                )}
                <strong>{t('primarySources.ocrSummaryTitle', 'Run summary')}</strong>
              </div>
              {!outcome.success ? (
                <p>{t('primarySources.ocrSummaryFailed', 'Synchronisation failed.')}</p>
              ) : (outcome.transcriptionsWritten ?? 0) > 0 ? (
                <ul>
                  <li>
                    {t('primarySources.ocrSummaryWritten', {
                      count: outcome.transcriptionsWritten ?? 0,
                      defaultValue: '{{count}} transcription(s) saved',
                    })}
                  </li>
                  <li>
                    {t('primarySources.ocrSummaryPages', {
                      count: outcome.ocrPerformed ?? 0,
                      defaultValue: '{{count}} page(s) sent through recognition',
                    })}
                  </li>
                </ul>
              ) : (
                <p>
                  {t(
                    'primarySources.ocrSummaryNothing',
                    'No new transcription. The sources already had one, or recognition produced nothing usable.'
                  )}
                </p>
              )}
              {(outcome.errors?.length ?? 0) > 0 && (
                <p className="ocr-summary__errors">
                  {t('primarySources.ocrSummaryErrors', {
                    count: outcome.errors?.length ?? 0,
                    defaultValue: '{{count}} error(s) — see console',
                  })}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-cancel" onClick={onClose}>
            {outcome && !isSyncing
              ? t('primarySources.close', 'Close')
              : t('common.cancel', 'Cancel')}
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
