import React, { useEffect } from 'react';
import { X, HelpCircle } from 'lucide-react';
import './HelpModal.css';

interface HelpModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

/**
 * Generic help modal — renders arbitrary JSX inside a dimmed overlay,
 * with backdrop-click and Esc-key to dismiss. Used for in-app help
 * pages reachable from the (?) icon next to a config control.
 *
 * Visually parented to MethodologyModal for theme parity, but kept
 * separate because the methodology one is feature-rich (tabs, search)
 * and we want the help to stay light and skimmable.
 */
export const HelpModal: React.FC<HelpModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
}) => {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="help-modal-overlay" onClick={onClose}>
      <div
        className="help-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="help-modal-header">
          <div className="help-modal-title">
            <HelpCircle size={20} />
            <h2 id="help-modal-title">{title}</h2>
          </div>
          <button
            className="help-modal-close"
            onClick={onClose}
            aria-label="Fermer"
          >
            <X size={20} />
          </button>
        </div>
        <div className="help-modal-content">{children}</div>
      </div>
    </div>
  );
};
