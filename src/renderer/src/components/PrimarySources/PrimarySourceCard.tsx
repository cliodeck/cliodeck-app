import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, FileText, Calendar, User, Building, ScanText, Loader2 } from 'lucide-react';
import { PrimarySource, usePrimarySourcesStore } from '../../stores/primarySourcesStore';
import { useDialogStore } from '../../stores/dialogStore';
import './PrimarySourceCard.css';

interface PrimarySourceCardProps {
  source: PrimarySource;
}

export const PrimarySourceCard: React.FC<PrimarySourceCardProps> = React.memo(({ source }) => {
  const { t } = useTranslation('common');
  const { selectedSourceId, selectSource, isPerformingOCR, performManualOCR } =
    usePrimarySourcesStore();
  const isSelected = selectedSourceId === source.id;
  // OCR en cours pour CETTE carte (isPerformingOCR est global au store).
  const [isOcrHere, setIsOcrHere] = useState(false);

  const handleClick = () => {
    selectSource(isSelected ? null : source.id);
  };

  // OCR manuel par source (#23) : re-lance la reconnaissance sur les images
  // de cette source, remplace la transcription (statut 'manual'). Une
  // transcription existante est écrasée — confirmation d'abord.
  const handleManualOCR = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isPerformingOCR) return;
    if (
      source.transcription &&
      !(await useDialogStore
        .getState()
        .showConfirm(
          t(
            'primarySources.ocrOverwriteConfirm',
            'Re-run OCR? The existing transcription of this source will be replaced.'
          )
        ))
    ) {
      return;
    }

    setIsOcrHere(true);
    try {
      const result = await performManualOCR(source.id);
      if (!result.success) {
        await useDialogStore
          .getState()
          .showAlert(
            result.error === 'no-photos'
              ? t(
                  'primarySources.ocrNoPhotos',
                  'No image found for this source (files moved or missing).'
                )
              : t('primarySources.ocrFailed', 'OCR failed for this source.')
          );
      }
    } finally {
      setIsOcrHere(false);
    }
  };

  return (
    <div
      className={`primary-source-card ${isSelected ? 'selected' : ''} ${
        source.transcription ? 'has-transcription' : ''
      }`}
      onClick={handleClick}
    >
      <div className="source-icon">
        <Archive size={20} strokeWidth={1} />
      </div>

      <div className="source-content">
        <div className="source-title">{source.title}</div>

        <div className="source-meta">
          {source.creator && (
            <span className="meta-item">
              <User size={12} strokeWidth={1} />
              {source.creator}
            </span>
          )}
          {source.date && (
            <span className="meta-item">
              <Calendar size={12} strokeWidth={1} />
              {source.date}
            </span>
          )}
          {source.archive && (
            <span className="meta-item">
              <Building size={12} strokeWidth={1} />
              {source.archive}
            </span>
          )}
        </div>

        {source.collection && (
          <div className="source-collection">{source.collection}</div>
        )}
      </div>

      <div className="source-status">
        <button
          className="status-badge ocr-rerun"
          onClick={(e) => void handleManualOCR(e)}
          disabled={isPerformingOCR}
          title={t('primarySources.ocrRerun', 'Run OCR on this source')}
          aria-label={t('primarySources.ocrRerun', 'Run OCR on this source')}
        >
          {isOcrHere ? (
            <Loader2 size={14} strokeWidth={1} className="spinning" />
          ) : (
            <ScanText size={14} strokeWidth={1} />
          )}
        </button>
        {source.transcription ? (
          <span className="status-badge transcribed" title="Has transcription">
            <FileText size={14} strokeWidth={1} />
          </span>
        ) : (
          <span className="status-badge no-transcription" title="No transcription">
            <FileText size={14} strokeWidth={1} />
          </span>
        )}
      </div>
    </div>
  );
});
