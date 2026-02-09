import React from 'react';
import { Archive, FileText, Calendar, User, Building } from 'lucide-react';
import { PrimarySource, usePrimarySourcesStore } from '../../stores/primarySourcesStore';
import './PrimarySourceCard.css';

interface PrimarySourceCardProps {
  source: PrimarySource;
}

export const PrimarySourceCard: React.FC<PrimarySourceCardProps> = ({ source }) => {
  const { selectedSourceId, selectSource } = usePrimarySourcesStore();
  const isSelected = selectedSourceId === source.id;

  const handleClick = () => {
    selectSource(isSelected ? null : source.id);
  };

  return (
    <div
      className={`primary-source-card ${isSelected ? 'selected' : ''} ${
        source.transcription ? 'has-transcription' : ''
      }`}
      onClick={handleClick}
    >
      <div className="source-icon">
        <Archive size={20} strokeWidth={1} />
      </div>

      <div className="source-content">
        <div className="source-title">{source.title}</div>

        <div className="source-meta">
          {source.creator && (
            <span className="meta-item">
              <User size={12} strokeWidth={1} />
              {source.creator}
            </span>
          )}
          {source.date && (
            <span className="meta-item">
              <Calendar size={12} strokeWidth={1} />
              {source.date}
            </span>
          )}
          {source.archive && (
            <span className="meta-item">
              <Building size={12} strokeWidth={1} />
              {source.archive}
            </span>
          )}
        </div>

        {source.collection && (
          <div className="source-collection">{source.collection}</div>
        )}
      </div>

      <div className="source-status">
        {source.transcription ? (
          <span className="status-badge transcribed" title="Has transcription">
            <FileText size={14} strokeWidth={1} />
          </span>
        ) : (
          <span className="status-badge no-transcription" title="No transcription">
            <FileText size={14} strokeWidth={1} />
          </span>
        )}
      </div>
    </div>
  );
};
