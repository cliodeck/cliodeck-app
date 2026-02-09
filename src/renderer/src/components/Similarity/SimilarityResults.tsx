/**
 * Similarity Results
 *
 * Displays the list of analyzed segments with their recommendations.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, FileText } from 'lucide-react';
import { useSimilarityStore, useAllSegments, type SimilarityResult } from '../../stores/similarityStore';
import { SimilarityCard } from './SimilarityCard';
import './SimilarityResults.css';

export const SimilarityResults: React.FC = () => {
  const { selectedSegmentId, selectSegment } = useSimilarityStore();
  const segments = useAllSegments();

  return (
    <div className="similarity-results">
      {segments.map((result) => (
        <SegmentItem
          key={result.segmentId}
          result={result}
          isSelected={selectedSegmentId === result.segmentId}
          onSelect={() => selectSegment(
            selectedSegmentId === result.segmentId ? null : result.segmentId
          )}
        />
      ))}
    </div>
  );
};

interface SegmentItemProps {
  result: SimilarityResult;
  isSelected: boolean;
  onSelect: () => void;
}

const SegmentItem: React.FC<SegmentItemProps> = ({ result, isSelected, onSelect }) => {
  const { t } = useTranslation('common');
  const { segment, recommendations } = result;

  // Get segment title or preview
  const getSegmentTitle = () => {
    if (segment.title) {
      return segment.title;
    }
    // Use first 60 characters as preview
    const preview = segment.content.substring(0, 60).replace(/\n/g, ' ');
    return preview + (segment.content.length > 60 ? '...' : '');
  };

  // Get recommendation count badge color
  const getBadgeClass = () => {
    if (recommendations.length === 0) return 'badge-empty';
    if (recommendations.length >= 3) return 'badge-good';
    return 'badge-partial';
  };

  return (
    <div className={`similarity-segment ${isSelected ? 'selected' : ''}`}>
      {/* Segment header */}
      <div className="similarity-segment-header" onClick={onSelect}>
        <div className="similarity-segment-chevron">
          {isSelected ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </div>

        <div className="similarity-segment-icon">
          <FileText size={14} />
        </div>

        <div className="similarity-segment-info">
          <div className="similarity-segment-title">{getSegmentTitle()}</div>
          <div className="similarity-segment-meta">
            {t(`similarity.type.${segment.type}`)} • {t('similarity.lines', {
              start: segment.startLine + 1,
              end: segment.endLine + 1,
            })}
          </div>
        </div>

        <div className={`similarity-segment-badge ${getBadgeClass()}`}>
          {recommendations.length}
        </div>
      </div>

      {/* Recommendations (expanded) */}
      {isSelected && (
        <div className="similarity-segment-content">
          {recommendations.length > 0 ? (
            <div className="similarity-recommendations">
              {recommendations.map((rec, index) => (
                <SimilarityCard key={`${rec.pdfId}-${index}`} recommendation={rec} />
              ))}
            </div>
          ) : (
            <div className="similarity-no-recommendations">
              <span className="similarity-no-recommendations-icon">📭</span>
              <span className="similarity-no-recommendations-text">
                {t('similarity.noRecommendations')}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
