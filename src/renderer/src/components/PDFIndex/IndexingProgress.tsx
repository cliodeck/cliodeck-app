import React from 'react';
import './IndexingProgress.css';

interface IndexingProgressProps {
  fileName: string;
  progress: number;
  stage: string;
}

export const IndexingProgress: React.FC<IndexingProgressProps> = ({
  fileName,
  progress,
  stage,
}) => {
  const getFileName = (path: string) => {
    return path.split('/').pop() || path;
  };

  return (
    <div className="indexing-progress">
      <div className="progress-header">
        <span className="progress-icon">⚙️</span>
        <div className="progress-info">
          <div className="progress-file">{getFileName(fileName)}</div>
          <div className="progress-stage">{stage}</div>
        </div>
        <div className="progress-percentage">{Math.round(progress)}%</div>
      </div>
      <div className="progress-bar">
        <div
          className="progress-fill"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
};
