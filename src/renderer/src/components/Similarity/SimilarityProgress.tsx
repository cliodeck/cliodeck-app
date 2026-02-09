/**
 * Similarity Progress
 *
 * Shows progress bar during document analysis.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { useSimilarityStore } from '../../stores/similarityStore';
import './SimilarityProgress.css';

export const SimilarityProgress: React.FC = () => {
  const { t } = useTranslation('common');
  const { progress, cancelAnalysis } = useSimilarityStore();

  return (
    <div className="similarity-progress">
      <div className="similarity-progress-header">
        <span className="similarity-progress-icon">⚙️</span>
        <div className="similarity-progress-info">
          <div className="similarity-progress-status">{progress.status}</div>
          {progress.currentSegment && (
            <div className="similarity-progress-segment">
              {progress.currentSegment}
            </div>
          )}
        </div>
        <div className="similarity-progress-percentage">{progress.percentage}%</div>
      </div>

      <div className="similarity-progress-bar">
        <div
          className="similarity-progress-fill"
          style={{ width: `${progress.percentage}%` }}
        />
      </div>

      <div className="similarity-progress-footer">
        <span className="similarity-progress-count">
          {progress.current} / {progress.total} {t('similarity.segments')}
        </span>
        <button
          className="similarity-cancel-btn"
          onClick={cancelAnalysis}
          title={t('common.cancel')}
        >
          <X size={14} />
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
};
