import React, { useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import './CollapsibleSection.css';

interface CollapsibleSectionProps {
  title: string;
  children: React.ReactNode;
  defaultExpanded?: boolean;
  onToggle?: (expanded: boolean) => void;
}

export const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  title,
  children,
  defaultExpanded = true,
  onToggle,
}) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const handleToggle = () => {
    const newExpanded = !isExpanded;
    setIsExpanded(newExpanded);
    onToggle?.(newExpanded);
  };

  return (
    <div className="collapsible-section">
      <button className="collapsible-header" onClick={handleToggle}>
        <span className="collapsible-icon">
          {isExpanded ? (
            <ChevronDown size={20} strokeWidth={1} />
          ) : (
            <ChevronRight size={20} strokeWidth={1} />
          )}
        </span>
        <span className="collapsible-title">{title}</span>
      </button>
      {isExpanded && <div className="collapsible-content">{children}</div>}
    </div>
  );
};
