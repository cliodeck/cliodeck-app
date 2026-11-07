import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Plus, RefreshCw, X } from 'lucide-react';
import type { BibliographyProblem } from '../../stores/bibliography/types';
import './BibImportModeModal.css';

import { useFocusTrap } from '../../hooks/useFocusTrap';
import { backdropClose } from '../../utils/backdropClose';
interface BibImportModeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onReplace: () => void;
  onMerge: () => void;
  currentCitationCount: number;
  /** Le `.bib` du projet ne s'est pas lu, ou pas en entier : l'import le remplacerait. */
  projectFileProblem?: BibliographyProblem | null;
}

/**
 * Ce que l'import ferait au `.bib` du projet qui ne se lit pas. Le fichier importé est copié dans
 * le projet sous son nom : de même nom, il écrase ce que ClioDeck n'a pas pu lire. Des métadonnées
 * seules illisibles ne changent rien : le `.bib` s'est lu en entier.
 */
function importWarningKey(problem: BibliographyProblem | null | undefined): string | null {
  if (!problem) return null;
  if (problem.kind === 'missing') return 'bibImport.projectFileMissing';
  if (problem.kind === 'unreadable' || problem.unreadKeys.length > 0) return 'bibImport.projectFileUnread';
  return null;
}

export const BibImportModeModal: React.FC<BibImportModeModalProps> = ({
  isOpen,
  onClose,
  onReplace,
  onMerge,
  currentCitationCount,
  projectFileProblem,
}) => {
  const { t } = useTranslation('common');
  // Échap ferme la modale (le piège de focus s'active quand la ref
  // est attachée au conteneur).
  const trapRef = useFocusTrap({ active: isOpen, onEscape: onClose });
  if (!isOpen) return null;

  const hasCitations = currentCitationCount > 0;
  const warningKey = importWarningKey(projectFileProblem);

  return (
    <div ref={trapRef} className="modal-overlay" {...backdropClose(onClose)}>
      <div className="modal-content bib-import-mode-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{t('bibImport.title')}</h3>
          <button className="close-button" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="modal-body">
          {warningKey && projectFileProblem && (
            <p className="bib-import-warning">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>{t(warningKey, { file: projectFileProblem.file })}</span>
            </p>
          )}
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
                  <div className="option-icon"><RefreshCw size={32} strokeWidth={1.5} /></div>
                  <div className="option-content">
                    <h4>{t('bibImport.replace')}</h4>
                    <p>{t('bibImport.replaceHint')}</p>
                  </div>
                </button>

                <button className="import-option-btn merge-btn" onClick={onMerge}>
                  <div className="option-icon"><Plus size={32} strokeWidth={1.5} /></div>
                  <div className="option-content">
                    <h4>{t('bibImport.merge')}</h4>
                    <p>Add new citations to the existing ones (duplicates will be detected)</p>
                  </div>
                </button>
              </div>
            </>
          ) : (
            <div className="first-import">
              {/* Une bibliographie qui ne se lit pas n'est pas vide : remplacer se demande. */}
              {!warningKey && <p>{t('bibImport.empty')}</p>}
              <div className="modal-actions">
                <button className="btn-cancel" onClick={onClose}>
                  {t('bibImport.cancel')}
                </button>
                <button className="btn-primary" onClick={onReplace}>
                  {warningKey ? t('bibImport.replace') : t('bibImport.import')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
