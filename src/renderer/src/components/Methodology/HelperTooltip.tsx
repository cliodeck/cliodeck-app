import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, HelpCircle } from 'lucide-react';
import './HelperTooltip.css';

interface Props {
  content: string;
  onLearnMore?: () => void; // Callback pour ouvrir le modal sur la feature spécifique
}

export const HelperTooltip: React.FC<Props> = ({ content, onLearnMore }) => {
  const { t } = useTranslation('common');
  const [isVisible, setIsVisible] = useState(false);

  return (
    <div
      className="helper-tooltip"
      onMouseEnter={() => setIsVisible(true)}
      onMouseLeave={() => setIsVisible(false)}
    >
      <HelpCircle size={14} className="help-icon" />
      {isVisible && (
        <div className="tooltip-content">
          <p>{content}</p>
          {onLearnMore && (
            <button className="learn-more-btn" onClick={onLearnMore}>
              {t('methodology.learnMore')} <ArrowRight size={12} />
            </button>
          )}
        </div>
      )}
    </div>
  );
};
