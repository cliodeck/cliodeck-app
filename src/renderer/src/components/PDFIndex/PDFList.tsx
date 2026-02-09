import React, { memo } from 'react';
import { PDFCard } from './PDFCard';
import './PDFList.css';

interface PDFDocument {
  id: string;
  title: string;
  author?: string;
  year?: string;
  pageCount: number;
  chunkCount?: number;
  indexedAt: Date;
}

interface PDFListProps {
  documents: PDFDocument[];
  onDelete: (id: string) => void;
}

export const PDFList: React.FC<PDFListProps> = memo(({ documents, onDelete }) => {
  return (
    <div className="pdf-list">
      {documents.map((doc) => (
        <PDFCard key={doc.id} document={doc} onDelete={onDelete} />
      ))}
    </div>
  );
});
