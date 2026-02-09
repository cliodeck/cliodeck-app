import React, { useState, useRef, useEffect } from 'react';
import type { AvailableCollection } from '../../stores/ragQueryStore';
import './CollectionMultiSelect.css';

interface Props {
  collections: AvailableCollection[];
  selectedKeys: string[];
  onChange: (keys: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}

export const CollectionMultiSelect: React.FC<Props> = ({
  collections,
  selectedKeys,
  onChange,
  placeholder = 'All collections',
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleCollection = (key: string) => {
    if (selectedKeys.includes(key)) {
      onChange(selectedKeys.filter((k) => k !== key));
    } else {
      onChange([...selectedKeys, key]);
    }
  };

  const clearAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange([]);
  };

  const selectedNames = collections
    .filter((c) => selectedKeys.includes(c.key))
    .map((c) => c.name);

  return (
    <div className={`collection-multiselect ${disabled ? 'disabled' : ''}`} ref={containerRef}>
      <div
        className="multiselect-trigger"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setIsOpen(!isOpen);
          }
        }}
      >
        <span className="selected-text">
          {selectedKeys.length === 0
            ? placeholder
            : selectedKeys.length === 1
              ? selectedNames[0]
              : `${selectedKeys.length} collection(s)`}
        </span>
        {selectedKeys.length > 0 && !disabled && (
          <button
            className="clear-btn"
            onClick={clearAll}
            title="Clear selection"
            type="button"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
        <svg
          className={`chevron ${isOpen ? 'rotated' : ''}`}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      {isOpen && !disabled && (
        <div className="multiselect-dropdown">
          {collections.length === 0 ? (
            <div className="no-collections">No collections found</div>
          ) : (
            collections.map((collection) => (
              <div
                key={collection.key}
                className={`collection-option ${selectedKeys.includes(collection.key) ? 'selected' : ''}`}
                style={{ paddingLeft: `${12 + (collection.level || 0) * 16}px` }}
                onClick={() => toggleCollection(collection.key)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleCollection(collection.key);
                  }
                }}
                tabIndex={0}
                role="option"
                aria-selected={selectedKeys.includes(collection.key)}
              >
                <span className="collection-name">{collection.name}</span>
                {selectedKeys.includes(collection.key) && (
                  <svg
                    className="check-icon"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};
