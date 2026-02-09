import React from 'react';
import { X, CheckCircle } from 'lucide-react';
import './BibImportSummaryModal.css';

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
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content bib-import-summary-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Import Complete</h3>
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
                  Bibliography replaced successfully!
                </p>
                <div className="summary-stats">
                  <div className="stat-item">
                    <span className="stat-value">{totalCitations}</span>
                    <span className="stat-label">Total citations</span>
                  </div>
                </div>
              </>
            ) : (
              <>
                <p className="summary-main">
                  Bibliography merged successfully!
                </p>
                <div className="summary-stats">
                  <div className="stat-item success">
                    <span className="stat-value">{newCitations}</span>
                    <span className="stat-label">New citations added</span>
                  </div>
                  <div className="stat-item">
                    <span className="stat-value">{totalCitations}</span>
                    <span className="stat-label">Total citations</span>
                  </div>
                  {duplicates > 0 && (
                    <div className="stat-item warning">
                      <span className="stat-value">{duplicates}</span>
                      <span className="stat-label">Duplicates ignored</span>
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
