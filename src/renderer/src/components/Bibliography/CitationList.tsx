import React from 'react';
import { Citation } from '../../stores/bibliographyStore';
import { CitationCard } from './CitationCard';
import './CitationList.css';

interface CitationListProps {
  citations: Citation[];
}

export const CitationList: React.FC<CitationListProps> = ({ citations }) => {
  return (
    <div className="citation-list">
      {citations.map((citation) => (
        <CitationCard key={citation.id} citation={citation} />
      ))}
    </div>
  );
};
