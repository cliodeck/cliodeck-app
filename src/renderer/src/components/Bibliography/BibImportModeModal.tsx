import React from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import './BibImportModeModal.css';

import { useFocusTrap } from '../../hooks/useFocusTrap';
interface BibImportModeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onReplace: () => void;
  onMerge: () => void;
  currentCitationCount: number;
}

export const BibImportModeModal: React.FC<BibImportModeModalProps> = ({
  isOpen,
  onClose,
  onReplace,
  onMerge,
  currentCitationCount,
}) => {
  const { t } = useTranslation('common');
  // Échap ferme la modale (le piège de focus s'active quand la ref
  // est attachée au conteneur).
  useFocusTrap({ active: isOpen, onEscape: onClose });
  if (!isOpen) return null;

  const hasCitations = currentCitationCount > 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content bib-import-mode-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{t('bibImport.title')}</h3>
          <button className="close-button" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="modal-body">
          {hasCitations ? (
            <>
              <p className="modal-info">
                {t('bibImport.youHaveBefore')} <strong>{currentCitationCount} citation{currentCitationCount !== 1 ? 's' : ''}</strong> {t('bibImport.youHaveAfter')}
              </p>
              <p className="modal-question">
                {t('bibImport.question')}
              </p>

              <div className="import-options">
                <button className="import-option-btn replace-btn" onClick={onReplace}>
                  <div className="option-icon">🔄</div>
                  <div className="option-content">
                    <h4>{t('bibImport.replace')}</h4>
                    <p>{t('bibImport.replaceHint')}</p>
                  </div>
                </button>

                <button className="import-option-btn merge-btn" onClick={onMerge}>
                  <div className="option-icon">➕</div>
                  <div className="option-content">
                    <h4>{t('bibImport.merge')}</h4>
                    <p>Add new citations to the existing ones (duplicates will be detected)</p>
                  </div>
                </button>
              </div>
            </>
          ) : (
            <div className="first-import">
              <p>{t('bibImport.empty')}</p>
              <div className="modal-actions">
                <button className="btn-cancel" onClick={onClose}>
                  {t('bibImport.cancel')}
                </button>
                <button className="btn-primary" onClick={onReplace}>
                  {t('bibImport.import')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
