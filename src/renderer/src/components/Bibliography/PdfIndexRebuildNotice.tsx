import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { usePdfIndexRebuildDue } from '../../stores/pdfIndexStore';

/**
 * L'index de recherche des PDF à reconstruire, proposé à la réouverture du projet (J8). Une session
 * précédente s'est fermée avant de le refaire : il garde des extraits de PDF retirés, qui prennent des
 * places dans les réponses. « Reconstruire » le refait depuis les vecteurs déjà calculés ; fermé, le
 * bandeau revient à la prochaine ouverture tant que l'index n'a pas été reconstruit.
 */
export const PdfIndexRebuildNotice: React.FC = () => {
  const { t } = useTranslation('common');
  const { due, rebuild, dismiss } = usePdfIndexRebuildDue();
  if (!due) return null;

  return (
    <div className="pdf-index-rebuild-notice" role="status">
      <AlertTriangle size={16} aria-hidden="true" />
      <div className="pdf-index-rebuild-notice-text">
        <p className="pdf-index-rebuild-notice-title">{t('pdfIndexRebuild.title')}</p>
        <p>{t('pdfIndexRebuild.message')}</p>
        <div className="pdf-index-rebuild-notice-actions">
          <button type="button" className="pdf-index-rebuild-notice-button" onClick={() => void rebuild()}>
            <RefreshCw size={14} aria-hidden="true" />
            {t('pdfIndexRebuild.rebuild')}
          </button>
        </div>
      </div>
      <button
        type="button"
        className="pdf-index-rebuild-notice-close"
        onClick={dismiss}
        title={t('pdfIndexRebuild.later')}
        aria-label={t('pdfIndexRebuild.later')}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
};
