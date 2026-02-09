import React, { useState } from 'react';
import { X, AlertCircle, Plus, Edit, Trash2, Check } from 'lucide-react';
import './SyncPreviewModal.css';

interface Citation {
  id: string;
  title: string;
  author: string;
  year: string;
  type: string;
  [key: string]: any;
}

interface CitationChange {
  local: Citation;
  remote: Citation;
  modifiedFields: string[];
}

interface SyncDiff {
  added: Citation[];
  modified: CitationChange[];
  deleted: Citation[];
  unchanged: Citation[];
}

interface SyncPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  diff: SyncDiff;
  onApplySync: (strategy: 'local' | 'remote' | 'manual', selectedChanges?: any) => void;
}

export const SyncPreviewModal: React.FC<SyncPreviewModalProps> = ({
  isOpen,
  onClose,
  diff,
  onApplySync,
}) => {
  const [strategy, setStrategy] = useState<'local' | 'remote' | 'manual'>('remote');
  const [selectedAdded, setSelectedAdded] = useState<Set<string>>(
    new Set(diff.added.map((c) => c.id))
  );
  const [selectedModified, setSelectedModified] = useState<Map<string, boolean>>(
    new Map(diff.modified.map((c) => [c.local.id, true])) // true = use remote
  );
  const [selectedDeleted, setSelectedDeleted] = useState<Set<string>>(
    new Set(diff.deleted.map((c) => c.id))
  );
  const [expandedChanges, setExpandedChanges] = useState<Set<string>>(new Set());

  if (!isOpen) return null;

  const totalChanges = diff.added.length + diff.modified.length + diff.deleted.length;

  const handleApply = () => {
    if (strategy === 'manual') {
      const resolution = {
        strategy: 'manual' as const,
        selectedChanges: {
          added: diff.added.filter((c) => selectedAdded.has(c.id)),
          modified: diff.modified.map((change) => ({
            local: change.local,
            remote: change.remote,
            useRemote: selectedModified.get(change.local.id) || false,
          })),
          deleted: diff.deleted.filter((c) => selectedDeleted.has(c.id)),
        },
      };
      onApplySync('manual', resolution);
    } else {
      onApplySync(strategy);
    }
  };

  const toggleAddedSelection = (id: string) => {
    const newSet = new Set(selectedAdded);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setSelectedAdded(newSet);
  };

  const toggleModifiedSelection = (id: string) => {
    const newMap = new Map(selectedModified);
    const current = newMap.get(id);
    newMap.set(id, !current);
    setSelectedModified(newMap);
  };

  const toggleDeletedSelection = (id: string) => {
    const newSet = new Set(selectedDeleted);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setSelectedDeleted(newSet);
  };

  const toggleExpanded = (id: string) => {
    const newSet = new Set(expandedChanges);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setExpandedChanges(newSet);
  };

  const selectAllAdded = () => {
    setSelectedAdded(new Set(diff.added.map((c) => c.id)));
  };

  const deselectAllAdded = () => {
    setSelectedAdded(new Set());
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content sync-preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Zotero Sync Preview</h3>
          <button className="close-button" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="modal-body">
          {totalChanges === 0 ? (
            <div className="no-changes">
              <Check size={48} color="var(--success-color)" />
              <p>Your bibliography is up to date!</p>
              <p className="text-muted">No changes detected from Zotero.</p>
            </div>
          ) : (
            <>
              {/* Strategy Selection */}
              <div className="strategy-section">
                <label className="section-label">Conflict Resolution Strategy:</label>
                <div className="strategy-options">
                  <label className={`strategy-option ${strategy === 'remote' ? 'selected' : ''}`}>
                    <input
                      type="radio"
                      name="strategy"
                      value="remote"
                      checked={strategy === 'remote'}
                      onChange={() => setStrategy('remote')}
                    />
                    <div className="option-content">
                      <div className="option-title">Remote Wins (Recommended)</div>
                      <div className="option-description">
                        Accept all changes from Zotero. Local PDFs will be preserved.
                      </div>
                    </div>
                  </label>

                  <label className={`strategy-option ${strategy === 'local' ? 'selected' : ''}`}>
                    <input
                      type="radio"
                      name="strategy"
                      value="local"
                      checked={strategy === 'local'}
                      onChange={() => setStrategy('local')}
                    />
                    <div className="option-content">
                      <div className="option-title">Local Wins</div>
                      <div className="option-description">
                        Only add new citations. Keep local modifications and ignore deletions.
                      </div>
                    </div>
                  </label>

                  <label className={`strategy-option ${strategy === 'manual' ? 'selected' : ''}`}>
                    <input
                      type="radio"
                      name="strategy"
                      value="manual"
                      checked={strategy === 'manual'}
                      onChange={() => setStrategy('manual')}
                    />
                    <div className="option-content">
                      <div className="option-title">Manual Selection</div>
                      <div className="option-description">
                        Choose exactly which changes to apply.
                      </div>
                    </div>
                  </label>
                </div>
              </div>

              {/* Summary Stats */}
              <div className="summary-stats">
                {diff.added.length > 0 && (
                  <div className="stat-item success">
                    <Plus size={20} />
                    <span className="stat-value">{diff.added.length}</span>
                    <span className="stat-label">Added</span>
                  </div>
                )}
                {diff.modified.length > 0 && (
                  <div className="stat-item warning">
                    <Edit size={20} />
                    <span className="stat-value">{diff.modified.length}</span>
                    <span className="stat-label">Modified</span>
                  </div>
                )}
                {diff.deleted.length > 0 && (
                  <div className="stat-item error">
                    <Trash2 size={20} />
                    <span className="stat-value">{diff.deleted.length}</span>
                    <span className="stat-label">Deleted</span>
                  </div>
                )}
                <div className="stat-item">
                  <Check size={20} />
                  <span className="stat-value">{diff.unchanged.length}</span>
                  <span className="stat-label">Unchanged</span>
                </div>
              </div>

              {/* Changes Details */}
              <div className="changes-section">
                {/* Added Citations */}
                {diff.added.length > 0 && (
                  <div className="change-group">
                    <div className="change-group-header added">
                      <Plus size={18} />
                      <h4>New Citations ({diff.added.length})</h4>
                      {strategy === 'manual' && (
                        <div className="bulk-actions">
                          <button className="link-button" onClick={selectAllAdded}>
                            Select All
                          </button>
                          <button className="link-button" onClick={deselectAllAdded}>
                            Deselect All
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="change-list">
                      {diff.added.map((citation) => (
                        <div key={citation.id} className="change-item">
                          {strategy === 'manual' && (
                            <input
                              type="checkbox"
                              checked={selectedAdded.has(citation.id)}
                              onChange={() => toggleAddedSelection(citation.id)}
                            />
                          )}
                          <div className="citation-info">
                            <div className="citation-title">{citation.title}</div>
                            <div className="citation-meta">
                              {citation.author} ({citation.year})
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Modified Citations */}
                {diff.modified.length > 0 && (
                  <div className="change-group">
                    <div className="change-group-header modified">
                      <Edit size={18} />
                      <h4>Modified Citations ({diff.modified.length})</h4>
                    </div>
                    <div className="change-list">
                      {diff.modified.map((change) => (
                        <div key={change.local.id} className="change-item expandable">
                          {strategy === 'manual' && (
                            <input
                              type="checkbox"
                              checked={selectedModified.get(change.local.id) || false}
                              onChange={() => toggleModifiedSelection(change.local.id)}
                              title={
                                selectedModified.get(change.local.id)
                                  ? 'Use remote version'
                                  : 'Keep local version'
                              }
                            />
                          )}
                          <div className="citation-info" onClick={() => toggleExpanded(change.local.id)}>
                            <div className="citation-title">{change.local.title}</div>
                            <div className="citation-meta">
                              Modified fields: {change.modifiedFields.join(', ')}
                            </div>
                          </div>
                          {expandedChanges.has(change.local.id) && (
                            <div className="change-details">
                              <div className="comparison">
                                <div className="comparison-column">
                                  <h5>Local</h5>
                                  <div className="field-list">
                                    {change.modifiedFields.map((field) => (
                                      <div key={field} className="field-item">
                                        <strong>{field}:</strong> {change.local[field] || '(empty)'}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                                <div className="comparison-column">
                                  <h5>Remote (Zotero)</h5>
                                  <div className="field-list">
                                    {change.modifiedFields.map((field) => (
                                      <div key={field} className="field-item">
                                        <strong>{field}:</strong> {change.remote[field] || '(empty)'}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Deleted Citations */}
                {diff.deleted.length > 0 && (
                  <div className="change-group">
                    <div className="change-group-header deleted">
                      <Trash2 size={18} />
                      <h4>Deleted from Zotero ({diff.deleted.length})</h4>
                      <AlertCircle size={16} className="warning-icon" />
                    </div>
                    <div className="change-list">
                      {diff.deleted.map((citation) => (
                        <div key={citation.id} className="change-item">
                          {strategy === 'manual' && (
                            <input
                              type="checkbox"
                              checked={selectedDeleted.has(citation.id)}
                              onChange={() => toggleDeletedSelection(citation.id)}
                            />
                          )}
                          <div className="citation-info">
                            <div className="citation-title">{citation.title}</div>
                            <div className="citation-meta">
                              {citation.author} ({citation.year})
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          {totalChanges > 0 && (
            <button className="btn-primary" onClick={handleApply}>
              Apply Changes
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
