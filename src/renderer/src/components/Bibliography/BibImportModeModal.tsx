import React from 'react';
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
  // Échap ferme la modale (le piège de focus s'active quand la ref
  // est attachée au conteneur).
  useFocusTrap({ active: isOpen, onEscape: onClose });
  if (!isOpen) return null;

  const hasCitations = currentCitationCount > 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content bib-import-mode-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Import Bibliography</h3>
          <button className="close-button" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="modal-body">
          {hasCitations ? (
            <>
              <p className="modal-info">
                You currently have <strong>{currentCitationCount} citation{currentCitationCount !== 1 ? 's' : ''}</strong> in your bibliography.
              </p>
              <p className="modal-question">
                How would you like to import the new file?
              </p>

              <div className="import-options">
                <button className="import-option-btn replace-btn" onClick={onReplace}>
                  <div className="option-icon">🔄</div>
                  <div className="option-content">
                    <h4>Replace</h4>
                    <p>Remove all current citations and replace with the new file</p>
                  </div>
                </button>

                <button className="import-option-btn merge-btn" onClick={onMerge}>
                  <div className="option-icon">➕</div>
                  <div className="option-content">
                    <h4>Merge</h4>
                    <p>Add new citations to the existing ones (duplicates will be detected)</p>
                  </div>
                </button>
              </div>
            </>
          ) : (
            <div className="first-import">
              <p>You don't have any citations yet. The file will be loaded into your bibliography.</p>
              <div className="modal-actions">
                <button className="btn-cancel" onClick={onClose}>
                  Cancel
                </button>
                <button className="btn-primary" onClick={onReplace}>
                  Import
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
