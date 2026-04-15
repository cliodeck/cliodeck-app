import React, { useEffect, useMemo, useRef, useState } from 'react';

export interface CitationCandidate {
  id: string;
  title: string;
  author: string;
  year: string;
}

export interface CitationAutocompleteProps {
  /** Current filter query (what was typed after `@`). */
  query: string;
  /** Full list of candidates to filter. */
  candidates: CitationCandidate[];
  /** Popup position, typically near the caret. */
  position: { top: number; left: number };
  /** Called when the user picks a citation (Enter / click). */
  onSelect: (id: string) => void;
  /** Called when the user escapes or clicks outside. */
  onClose: () => void;
  /** Max results shown. Defaults to 8. */
  maxResults?: number;
  /** Optional empty-state text. */
  emptyLabel?: string;
}

/**
 * Generic @key autocomplete popup shared by the Markdown editors.
 *
 * Filtering is prefix-preferred: items whose id starts with `query` (case
 * insensitive) come first, then substring matches on id / author / title /
 * year. Selection emits only the id — callers decide how to splice the
 * token (`[@id]`, `@id`, …) into their buffer.
 */
export const CitationAutocomplete: React.FC<CitationAutocompleteProps> = ({
  query,
  candidates,
  position,
  onSelect,
  onClose,
  maxResults = 8,
  emptyLabel = 'Aucune citation',
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return candidates.slice(0, maxResults);

    const starts: CitationCandidate[] = [];
    const contains: CitationCandidate[] = [];
    for (const c of candidates) {
      const id = c.id.toLowerCase();
      if (id.startsWith(q)) {
        starts.push(c);
      } else if (
        id.includes(q) ||
        c.author.toLowerCase().includes(q) ||
        c.title.toLowerCase().includes(q) ||
        c.year.includes(q)
      ) {
        contains.push(c);
      }
    }
    return [...starts, ...contains].slice(0, maxResults);
  }, [query, candidates, maxResults]);

  // Reset selection when the filtered set shrinks / changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [query, candidates]);

  // Click-outside + keyboard nav at the window level so the popup works
  // over editors that swallow their own keydown events.
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (filtered.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % filtered.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const pick = filtered[activeIndex];
        if (pick) onSelect(pick.id);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKey, true);
    };
  }, [filtered, activeIndex, onSelect, onClose]);

  if (filtered.length === 0) {
    return (
      <div
        ref={menuRef}
        className="citation-autocomplete-menu"
        role="listbox"
        style={{ top: position.top, left: position.left }}
      >
        <div className="citation-autocomplete-empty">{emptyLabel}</div>
      </div>
    );
  }

  return (
    <div
      ref={menuRef}
      className="citation-autocomplete-menu"
      role="listbox"
      aria-label="Citations"
      style={{ top: position.top, left: position.left }}
    >
      {filtered.map((c, idx) => (
        <button
          key={c.id}
          type="button"
          role="option"
          aria-selected={idx === activeIndex}
          className={
            'citation-autocomplete-item' +
            (idx === activeIndex ? ' citation-autocomplete-item--active' : '')
          }
          onMouseEnter={() => setActiveIndex(idx)}
          onClick={() => onSelect(c.id)}
          data-testid={`citation-option-${c.id}`}
        >
          <span className="citation-key">@{c.id}</span>
          <span className="citation-info">
            {c.author} ({c.year})
          </span>
          <span className="citation-title">{c.title}</span>
        </button>
      ))}
    </div>
  );
};

export default CitationAutocomplete;
