import React from 'react';
import { useTranslation } from 'react-i18next';
import { X, CheckCircle } from 'lucide-react';
import './BibImportSummaryModal.css';

import { useFocusTrap } from '../../hooks/useFocusTrap';
interface BibImportSummaryModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode: 'replace' | 'merge';
  totalCitations: number;
  newCitations: number;
  duplicates: number;
}

export const BibImportSummaryModal: React.FC<BibImportSummaryModalProps> = ({
  isOpen,
  onClose,
  mode,
  totalCitations,
  newCitations,
  duplicates,
}) => {
  const { t } = useTranslation('common');
  // Échap ferme la modale (le piège de focus s'active quand la ref
  // est attachée au conteneur).
  useFocusTrap({ active: isOpen, onEscape: onClose });
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content bib-import-summary-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{t('bibImportSummary.title')}</h3>
          <button className="close-button" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="modal-body">
          <div className="success-icon">
            <CheckCircle size={48} color="var(--success-color)" />
          </div>

          <div className="summary-content">
            {mode === 'replace' ? (
              <>
                <p className="summary-main">
                  {t('bibImportSummary.replaced')}
                </p>
                <div className="summary-stats">
                  <div className="stat-item">
                    <span className="stat-value">{totalCitations}</span>
                    <span className="stat-label">{t('bibImportSummary.total')}</span>
                  </div>
                </div>
              </>
            ) : (
              <>
                <p className="summary-main">
                  {t('bibImportSummary.merged')}
                </p>
                <div className="summary-stats">
                  <div className="stat-item success">
                    <span className="stat-value">{newCitations}</span>
                    <span className="stat-label">{t('bibImportSummary.newAdded')}</span>
                  </div>
                  <div className="stat-item">
                    <span className="stat-value">{totalCitations}</span>
                    <span className="stat-label">{t('bibImportSummary.total')}</span>
                  </div>
                  {duplicates > 0 && (
                    <div className="stat-item warning">
                      <span className="stat-value">{duplicates}</span>
                      <span className="stat-label">{t('bibImportSummary.duplicates')}</span>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="modal-actions">
            <button className="btn-primary" onClick={onClose}>
              OK
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
