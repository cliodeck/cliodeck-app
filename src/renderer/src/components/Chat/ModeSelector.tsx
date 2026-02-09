import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  AlertTriangle,
  MessageSquare,
  BookOpen,
  FileSearch,
  Eye,
  PenTool,
  Compass,
  Sparkles,
} from 'lucide-react';
import { useModeStore } from '../../stores/modeStore';
import { useRAGQueryStore } from '../../stores/ragQueryStore';
import type { ModeCategory } from '../../../../../backend/types/mode';
import './ModeSelector.css';

const ICON_MAP: Record<string, React.FC<{ size?: number }>> = {
  MessageSquare,
  BookOpen,
  FileSearch,
  Eye,
  PenTool,
  Compass,
  Sparkles,
};

const CATEGORIES: Array<ModeCategory | 'all'> = [
  'all',
  'general',
  'research',
  'writing',
  'review',
  'analysis',
  'methodology',
];

export const ModeSelector: React.FC = () => {
  const { t, i18n } = useTranslation('common');
  const lang = (i18n.language?.substring(0, 2) as 'fr' | 'en') || 'fr';
  const {
    modes,
    activeMode,
    activeModeId,
    isLoadingModes,
    loadModes,
    setActiveMode,
    categoryFilter,
    setCategoryFilter,
    getFilteredModes,
    checkModelCompatibility,
  } = useModeStore();
  const { params } = useRAGQueryStore();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadModes();
  }, [loadModes]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const compatibility = checkModelCompatibility(params.model);
  const filteredModes = getFilteredModes();

  const getIcon = (iconName: string, size = 14) => {
    const IconComponent = ICON_MAP[iconName];
    if (IconComponent) return <IconComponent size={size} />;
    return <MessageSquare size={size} />;
  };

  const getCategoryLabel = (cat: ModeCategory | 'all'): string => {
    const labels: Record<string, Record<string, string>> = {
      all: { fr: 'Tous', en: 'All' },
      general: { fr: 'Général', en: 'General' },
      research: { fr: 'Recherche', en: 'Research' },
      writing: { fr: 'Écriture', en: 'Writing' },
      review: { fr: 'Relecture', en: 'Review' },
      analysis: { fr: 'Analyse', en: 'Analysis' },
      methodology: { fr: 'Méthodo', en: 'Method.' },
    };
    return labels[cat]?.[lang] || cat;
  };

  const getSourceBadge = (source: string) => {
    if (source === 'builtin') return null;
    return (
      <span className={`mode-source-badge mode-source-${source}`}>
        {source === 'global' ? 'G' : 'P'}
      </span>
    );
  };

  const handleModeSelect = async (modeId: string) => {
    await setActiveMode(modeId);
    setIsOpen(false);
  };

  if (isLoadingModes && modes.length === 0) {
    return null;
  }

  return (
    <div className="mode-selector" ref={dropdownRef}>
      <button
        className="mode-selector-trigger"
        onClick={() => setIsOpen(!isOpen)}
        title={lang === 'fr' ? 'Changer de mode' : 'Change mode'}
      >
        {activeMode && getIcon(activeMode.metadata.icon)}
        <span className="mode-selector-name">
          {activeMode?.metadata.name[lang] || 'Default'}
        </span>
        <ChevronDown size={12} className={`mode-chevron ${isOpen ? 'open' : ''}`} />
      </button>

      {!compatibility.compatible && (
        <div className="mode-compatibility-warning">
          <AlertTriangle size={12} />
          <span>{compatibility.warning}</span>
        </div>
      )}

      {isOpen && (
        <div className="mode-dropdown">
          <div className="mode-categories">
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                className={`mode-category-tab ${categoryFilter === cat ? 'active' : ''}`}
                onClick={() => setCategoryFilter(cat)}
              >
                {getCategoryLabel(cat)}
              </button>
            ))}
          </div>

          <div className="mode-list">
            {filteredModes.map((mode) => (
              <button
                key={mode.metadata.id}
                className={`mode-item ${mode.metadata.id === activeModeId ? 'active' : ''}`}
                onClick={() => handleModeSelect(mode.metadata.id)}
              >
                <span className="mode-item-icon">
                  {getIcon(mode.metadata.icon, 16)}
                </span>
                <div className="mode-item-text">
                  <div className="mode-item-name">{mode.metadata.name[lang]}</div>
                  <div className="mode-item-description">
                    {mode.metadata.description[lang]}
                  </div>
                </div>
                {getSourceBadge(mode.source)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
