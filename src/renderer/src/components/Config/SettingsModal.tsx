import React from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { ConfigPanel } from './ConfigPanel';
import './SettingsModal.css';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation('common');

  if (!isOpen) return null;

  return (
    <div className="settings-modal" onClick={onClose}>
      <div
        className="settings-content"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-header">
          <h3 id="settings-modal-title">{t('settings.title')}</h3>
          <button className="close-btn" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="settings-body">
          <ConfigPanel />
        </div>
      </div>
    </div>
  );
};
