import React from 'react';
import { PrimarySource } from '../../stores/primarySourcesStore';
import { PrimarySourceCard } from './PrimarySourceCard';
import './PrimarySourceList.css';

interface PrimarySourceListProps {
  sources: PrimarySource[];
}

export const PrimarySourceList: React.FC<PrimarySourceListProps> = ({ sources }) => {
  if (sources.length === 0) {
    return null;
  }

  return (
    <div className="primary-source-list">
      {sources.map((source) => (
        <PrimarySourceCard key={source.id} source={source} />
      ))}
    </div>
  );
};
