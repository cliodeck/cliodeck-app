import React, { useState, useRef } from 'react';
import { X, Plus, Tag } from 'lucide-react';
import './TagManager.css';

interface TagManagerProps {
  tags: string[];
  onTagsChange: (tags: string[]) => void;
  allTags?: string[]; // All tags in the bibliography for autocomplete
  readOnly?: boolean;
}

export const TagManager: React.FC<TagManagerProps> = ({
  tags = [],
  onTagsChange,
  allTags = [],
  readOnly = false,
}) => {
  const [inputValue, setInputValue] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Filter suggestions based on input
  const suggestions = inputValue.trim()
    ? allTags.filter(
        (tag) =>
          tag.toLowerCase().includes(inputValue.toLowerCase()) &&
          !tags.includes(tag)
      )
    : [];

  const addTag = (tag: string) => {
    const trimmedTag = tag.trim();
    if (trimmedTag && !tags.includes(trimmedTag)) {
      onTagsChange([...tags, trimmedTag]);
      setInputValue('');
      setShowSuggestions(false);
    }
  };

  const removeTag = (tagToRemove: string) => {
    onTagsChange(tags.filter((tag) => tag !== tagToRemove));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (suggestions.length > 0) {
        addTag(suggestions[0]);
      } else {
        addTag(inputValue);
      }
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
      setInputValue('');
    } else if (e.key === 'Backspace' && inputValue === '' && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
    setShowSuggestions(true);
  };

  const handleInputFocus = () => {
    if (inputValue) {
      setShowSuggestions(true);
    }
  };

  const handleInputBlur = () => {
    // Delay to allow click on suggestion
    setTimeout(() => {
      setShowSuggestions(false);
    }, 200);
  };

  if (readOnly) {
    return (
      <div className="tag-manager read-only">
        {tags.length === 0 ? (
          <span className="no-tags">No tags</span>
        ) : (
          <div className="tag-list">
            {tags.map((tag) => (
              <span key={tag} className="tag">
                <Tag size={12} />
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="tag-manager">
      <div className="tag-input-container">
        <div className="tag-list">
          {tags.map((tag) => (
            <span key={tag} className="tag">
              <Tag size={12} />
              {tag}
              <button
                className="remove-tag"
                onClick={() => removeTag(tag)}
                title="Remove tag"
              >
                <X size={12} />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            type="text"
            className="tag-input"
            placeholder={tags.length === 0 ? 'Add tags...' : ''}
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onFocus={handleInputFocus}
            onBlur={handleInputBlur}
          />
        </div>
        {inputValue && (
          <button
            className="add-tag-button"
            onClick={() => addTag(inputValue)}
            title="Add tag"
          >
            <Plus size={16} />
          </button>
        )}
      </div>

      {showSuggestions && suggestions.length > 0 && (
        <div className="tag-suggestions">
          {suggestions.slice(0, 5).map((suggestion) => (
            <button
              key={suggestion}
              className="tag-suggestion"
              onClick={() => addTag(suggestion)}
            >
              <Tag size={12} />
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

interface TagFilterProps {
  selectedTags: string[];
  allTags: string[];
  onTagsChange: (tags: string[]) => void;
  onClear: () => void;
}

export const TagFilter: React.FC<TagFilterProps> = ({
  selectedTags,
  allTags,
  onTagsChange,
  onClear,
}) => {
  const toggleTag = (tag: string) => {
    if (selectedTags.includes(tag)) {
      onTagsChange(selectedTags.filter((t) => t !== tag));
    } else {
      onTagsChange([...selectedTags, tag]);
    }
  };

  const tagCounts = allTags.reduce((acc, tag) => {
    acc[tag] = (acc[tag] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const uniqueTags = Object.keys(tagCounts).sort();

  if (uniqueTags.length === 0) {
    return (
      <div className="tag-filter-empty">
        <p>No tags available</p>
      </div>
    );
  }

  return (
    <div className="tag-filter">
      <div className="tag-filter-header">
        <span className="tag-filter-title">
          <Tag size={16} />
          Filter by tags
        </span>
        {selectedTags.length > 0 && (
          <button className="clear-tags" onClick={onClear}>
            Clear ({selectedTags.length})
          </button>
        )}
      </div>
      <div className="tag-filter-list">
        {uniqueTags.map((tag) => (
          <button
            key={tag}
            className={`tag-filter-item ${selectedTags.includes(tag) ? 'selected' : ''}`}
            onClick={() => toggleTag(tag)}
          >
            <Tag size={12} />
            <span className="tag-name">{tag}</span>
            <span className="tag-count">{tagCounts[tag]}</span>
          </button>
        ))}
      </div>
    </div>
  );
};
