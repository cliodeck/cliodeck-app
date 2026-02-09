import React, { useState, useEffect } from 'react';
import { X, Plus, Trash2, Save, FileText } from 'lucide-react';
import { TagManager } from './TagManager';
import './CitationMetadataModal.css';

interface Citation {
  id: string;
  title: string;
  author: string;
  year: string;
  tags?: string[];
  keywords?: string;
  notes?: string;
  customFields?: Record<string, string>;
  [key: string]: any;
}

interface CitationMetadataModalProps {
  isOpen: boolean;
  onClose: () => void;
  citation: Citation;
  allTags: string[];
  onSave: (updatedCitation: Citation) => void;
}

export const CitationMetadataModal: React.FC<CitationMetadataModalProps> = ({
  isOpen,
  onClose,
  citation,
  allTags,
  onSave,
}) => {
  const [editedCitation, setEditedCitation] = useState<Citation>(citation);
  const [newFieldKey, setNewFieldKey] = useState('');
  const [newFieldValue, setNewFieldValue] = useState('');

  useEffect(() => {
    setEditedCitation(citation);
  }, [citation]);

  if (!isOpen) return null;

  const handleTagsChange = (tags: string[]) => {
    setEditedCitation({ ...editedCitation, tags });
  };

  const handleNotesChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditedCitation({ ...editedCitation, notes: e.target.value });
  };

  const handleKeywordsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEditedCitation({ ...editedCitation, keywords: e.target.value });
  };

  const handleAddCustomField = () => {
    if (newFieldKey.trim() && newFieldValue.trim()) {
      const customFields = { ...editedCitation.customFields };
      customFields[newFieldKey] = newFieldValue;
      setEditedCitation({ ...editedCitation, customFields });
      setNewFieldKey('');
      setNewFieldValue('');
    }
  };

  const handleRemoveCustomField = (key: string) => {
    const customFields = { ...editedCitation.customFields };
    delete customFields[key];
    setEditedCitation({ ...editedCitation, customFields });
  };

  const handleCustomFieldChange = (key: string, value: string) => {
    const customFields = { ...editedCitation.customFields };
    customFields[key] = value;
    setEditedCitation({ ...editedCitation, customFields });
  };

  const handleSave = () => {
    onSave({
      ...editedCitation,
      dateModified: new Date().toISOString(),
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content citation-metadata-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>
            <FileText size={20} />
            Edit Citation Metadata
          </h3>
          <button className="close-button" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="modal-body">
          {/* Citation Info */}
          <div className="citation-info-section">
            <div className="citation-title">{editedCitation.title}</div>
            <div className="citation-author">
              {editedCitation.author} ({editedCitation.year})
            </div>
          </div>

          {/* Tags */}
          <div className="metadata-section">
            <label className="section-label">Tags</label>
            <TagManager
              tags={editedCitation.tags || []}
              onTagsChange={handleTagsChange}
              allTags={allTags}
            />
            <p className="section-hint">
              Tags help organize and filter your citations
            </p>
          </div>

          {/* Keywords */}
          <div className="metadata-section">
            <label className="section-label">Keywords</label>
            <input
              type="text"
              className="metadata-input"
              placeholder="Separate keywords with commas"
              value={editedCitation.keywords || ''}
              onChange={handleKeywordsChange}
            />
            <p className="section-hint">
              BibTeX keywords field (comma-separated)
            </p>
          </div>

          {/* Notes */}
          <div className="metadata-section">
            <label className="section-label">Notes</label>
            <textarea
              className="metadata-textarea"
              placeholder="Add your notes about this citation..."
              rows={4}
              value={editedCitation.notes || ''}
              onChange={handleNotesChange}
            />
            <p className="section-hint">
              Personal notes and comments about this citation
            </p>
          </div>

          {/* Custom Fields */}
          <div className="metadata-section">
            <label className="section-label">Custom Fields</label>

            {editedCitation.customFields &&
              Object.keys(editedCitation.customFields).length > 0 && (
                <div className="custom-fields-list">
                  {Object.entries(editedCitation.customFields).map(([key, value]) => (
                    <div key={key} className="custom-field-item">
                      <div className="custom-field-content">
                        <input
                          type="text"
                          className="custom-field-key"
                          value={key}
                          readOnly
                        />
                        <input
                          type="text"
                          className="custom-field-value"
                          value={value}
                          onChange={(e) =>
                            handleCustomFieldChange(key, e.target.value)
                          }
                          placeholder="Value"
                        />
                      </div>
                      <button
                        className="remove-field-button"
                        onClick={() => handleRemoveCustomField(key)}
                        title="Remove field"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

            <div className="add-custom-field">
              <input
                type="text"
                className="custom-field-key"
                placeholder="Field name"
                value={newFieldKey}
                onChange={(e) => setNewFieldKey(e.target.value)}
              />
              <input
                type="text"
                className="custom-field-value"
                placeholder="Field value"
                value={newFieldValue}
                onChange={(e) => setNewFieldValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleAddCustomField();
                  }
                }}
              />
              <button
                className="add-field-button"
                onClick={handleAddCustomField}
                disabled={!newFieldKey.trim() || !newFieldValue.trim()}
                title="Add custom field"
              >
                <Plus size={16} />
              </button>
            </div>
            <p className="section-hint">
              Add custom metadata fields for specialized information
            </p>
          </div>

          {/* Timestamps */}
          {(editedCitation.dateAdded || editedCitation.dateModified) && (
            <div className="metadata-section">
              <label className="section-label">Timestamps</label>
              <div className="timestamp-info">
                {editedCitation.dateAdded && (
                  <div className="timestamp-item">
                    <span className="timestamp-label">Added:</span>
                    <span className="timestamp-value">
                      {new Date(editedCitation.dateAdded).toLocaleString()}
                    </span>
                  </div>
                )}
                {editedCitation.dateModified && (
                  <div className="timestamp-item">
                    <span className="timestamp-label">Modified:</span>
                    <span className="timestamp-value">
                      {new Date(editedCitation.dateModified).toLocaleString()}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={handleSave}>
            <Save size={16} />
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
};
