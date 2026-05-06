import React from 'react';
import { PrimarySource, usePrimarySourcesStore } from '../../stores/primarySourcesStore';
import { PrimarySourceCard } from './PrimarySourceCard';
import { OCRSourceReport } from './OCRSourceReport';
import './PrimarySourceList.css';

interface PrimarySourceListProps {
  sources: PrimarySource[];
}

export const PrimarySourceList: React.FC<PrimarySourceListProps> = ({ sources }) => {
  const selectedSourceId = usePrimarySourcesStore((s) => s.selectedSourceId);

  if (sources.length === 0) {
    return null;
  }

  return (
    <div className="primary-source-list">
      {sources.map((source) => (
        <React.Fragment key={source.id}>
          <PrimarySourceCard source={source} />
          {selectedSourceId === source.id && (
            <OCRSourceReport sourceId={source.id} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
};
