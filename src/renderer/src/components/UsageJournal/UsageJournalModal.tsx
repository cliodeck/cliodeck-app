import React from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { UsageJournalPanel } from './UsageJournalPanel';
import './UsageJournalModal.css';

import { useFocusTrap } from '../../hooks/useFocusTrap';
interface UsageJournalModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Modale du journal d'usage IA, ouverte depuis le menu Affichage (Cmd/Ctrl+J).
 * Même idiome que SettingsModal (overlay in-renderer, pas une fenêtre OS).
 */
export const UsageJournalModal: React.FC<UsageJournalModalProps> = ({ isOpen, onClose }) => {
  // Échap ferme la modale (le piège de focus s'active quand la ref
  // est attachée au conteneur).
  useFocusTrap({ active: isOpen, onEscape: onClose });
  const { t } = useTranslation('common');
  if (!isOpen) return null;

  return (
    <div className="usage-modal" onClick={onClose}>
      <div
        className="usage-modal__content"
        role="dialog"
        aria-modal="true"
        aria-labelledby="usage-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="usage-modal__header">
          <h3 id="usage-modal-title">{t('usageJournal.title')}</h3>
          <button
            className="usage-modal__close"
            onClick={onClose}
            aria-label={t('usageJournal.close')}
          >
            <X size={20} />
          </button>
        </div>
        <div className="usage-modal__body">
          <UsageJournalPanel />
        </div>
      </div>
    </div>
  );
};
