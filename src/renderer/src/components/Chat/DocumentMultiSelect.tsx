/**
 * Issue #16: Document multi-select component for RAG filtering
 * Allows users to filter RAG searches by specific documents
 */
import React, { useState, useRef, useEffect } from 'react';
import type { AvailableDocument } from '../../stores/ragQueryStore';
import './CollectionMultiSelect.css'; // Reuse same styles

interface Props {
  documents: AvailableDocument[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}

export const DocumentMultiSelect: React.FC<Props> = ({
  documents,
  selectedIds,
  onChange,
  placeholder = 'All documents',
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearchTerm('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  const toggleDocument = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((i) => i !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  const clearAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange([]);
  };

  const selectedDocs = documents.filter((d) => selectedIds.includes(d.id));

  // Filter documents by search term
  const filteredDocuments = documents.filter((doc) => {
    if (!searchTerm) return true;
    const searchLower = searchTerm.toLowerCase();
    return (
      doc.title.toLowerCase().includes(searchLower) ||
      (doc.author && doc.author.toLowerCase().includes(searchLower)) ||
      (doc.year && doc.year.includes(searchTerm))
    );
  });

  // Format document display name
  const formatDocName = (doc: AvailableDocument): string => {
    if (doc.author && doc.year) {
      return `${doc.author} (${doc.year})`;
    }
    if (doc.author) {
      return doc.author;
    }
    // Truncate long titles
    return doc.title.length > 40 ? doc.title.substring(0, 37) + '...' : doc.title;
  };

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
          {selectedIds.length === 0
            ? placeholder
            : selectedIds.length === 1
              ? formatDocName(selectedDocs[0])
              : `${selectedIds.length} document(s)`}
        </span>
        {selectedIds.length > 0 && !disabled && (
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
        <div className="multiselect-dropdown" style={{ maxHeight: '300px' }}>
          {/* Search input */}
          <div style={{ padding: '8px', borderBottom: '1px solid var(--border-color)' }}>
            <input
              ref={searchInputRef}
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search documents..."
              onClick={(e) => e.stopPropagation()}
              style={{
                width: '100%',
                padding: '6px 8px',
                fontSize: '12px',
                border: '1px solid var(--border-color)',
                borderRadius: '4px',
                background: 'var(--surface-variant)',
                color: 'var(--text-color)',
              }}
            />
          </div>

          <div style={{ maxHeight: '240px', overflowY: 'auto' }}>
            {filteredDocuments.length === 0 ? (
              <div className="no-collections">
                {documents.length === 0 ? 'No documents found' : 'No matching documents'}
              </div>
            ) : (
              filteredDocuments.map((doc) => (
                <div
                  key={doc.id}
                  className={`collection-option ${selectedIds.includes(doc.id) ? 'selected' : ''}`}
                  style={{ paddingLeft: '12px' }}
                  onClick={() => toggleDocument(doc.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleDocument(doc.id);
                    }
                  }}
                  tabIndex={0}
                  role="option"
                  aria-selected={selectedIds.includes(doc.id)}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                    <span className="collection-name" style={{
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}>
                      {doc.title}
                    </span>
                    {(doc.author || doc.year) && (
                      <span style={{
                        fontSize: '10px',
                        color: 'var(--text-muted)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}>
                        {doc.author}{doc.author && doc.year && ' - '}{doc.year}
                      </span>
                    )}
                  </div>
                  {selectedIds.includes(doc.id) && (
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
        </div>
      )}
    </div>
  );
};
