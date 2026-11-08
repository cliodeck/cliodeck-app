import React from 'react';
import { useTranslation } from 'react-i18next';
import { X, CheckCircle, AlertTriangle } from 'lucide-react';
import './BibImportSummaryModal.css';

import { useFocusTrap } from '../../hooks/useFocusTrap';
import { backdropClose } from '../../utils/backdropClose';
interface BibImportSummaryModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode: 'replace' | 'merge';
  totalCitations: number;
  newCitations: number;
  duplicates: number;
  /** Les entrées du fichier importé que le parseur n'a pas rendues. */
  unreadKeys?: string[];
  /** Le nom du fichier importé. */
  file?: string;
  /** Importé dans un projet ouvert, et non dans le seul panneau : le texte parle alors du fichier du projet. */
  inProject: boolean;
}

/** Clés montrées avant « … et N autre(s) », comme dans le bandeau du panneau. */
const SHOWN_KEYS = 8;

/** Dans un projet, ce que sont devenues les entrées non lues ; sans projet, il n'y a pas de fichier du projet. */
function unreadSummaryKey(mode: 'replace' | 'merge', inProject: boolean): string {
  if (!inProject) return 'bibImportSummary.unreadNoProject';
  return mode === 'merge' ? 'bibImportSummary.unreadMerged' : 'bibImportSummary.unreadReplaced';
}

export const BibImportSummaryModal: React.FC<BibImportSummaryModalProps> = ({
  isOpen,
  onClose,
  mode,
  totalCitations,
  newCitations,
  duplicates,
  unreadKeys = [],
  file = '',
  inProject,
}) => {
  const { t } = useTranslation('common');
  // Échap ferme la modale (le piège de focus s'active quand la ref
  // est attachée au conteneur).
  const trapRef = useFocusTrap({ active: isOpen, onEscape: onClose });
  if (!isOpen) return null;

  return (
    <div ref={trapRef} className="modal-overlay" {...backdropClose(onClose)}>
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
            {/* Ce que le fichier importé contenait et qui n'est pas entré : nommé, pas seulement compté. */}
            {unreadKeys.length > 0 && (
              <div className="bib-import-summary-unread">
                <AlertTriangle size={16} aria-hidden="true" />
                <div>
                  <p>
                    {t(unreadSummaryKey(mode, inProject), { count: unreadKeys.length, file })}
                  </p>
                  <p className="bib-import-summary-keys">
                    {unreadKeys.slice(0, SHOWN_KEYS).map((key) => `@${key}`).join(', ')}
                    {unreadKeys.length > SHOWN_KEYS && ` ${t('zotero.sync.more', { count: unreadKeys.length - SHOWN_KEYS })}`}
                  </p>
                </div>
              </div>
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
