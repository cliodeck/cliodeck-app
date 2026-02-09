import React, { useState } from 'react';
import { HelpCircle } from 'lucide-react';
import './HelperTooltip.css';

interface Props {
  content: string;
  onLearnMore?: () => void; // Callback pour ouvrir le modal sur la feature spécifique
}

export const HelperTooltip: React.FC<Props> = ({ content, onLearnMore }) => {
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
              En savoir plus →
            </button>
          )}
        </div>
      )}
    </div>
  );
};
