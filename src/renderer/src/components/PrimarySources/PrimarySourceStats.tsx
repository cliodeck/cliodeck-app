import React from 'react';
import { Archive, FileText, Image, Tag, Building2, FolderOpen } from 'lucide-react';
import { PrimarySourcesStatistics } from '../../stores/primarySourcesStore';
import './PrimarySourceStats.css';
import './PrimarySourceStats.css';

interface PrimarySourceStatsProps {
  statistics: PrimarySourcesStatistics;
}

export const PrimarySourceStats: React.FC<PrimarySourceStatsProps> = ({ statistics }) => {
  const transcriptionRate =
    statistics.sourceCount > 0
      ? Math.round((statistics.withTranscription / statistics.sourceCount) * 100)
      : 0;

  const topArchives = Object.entries(statistics.byArchive)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const topCollections = Object.entries(statistics.byCollection)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return (
    <div className="primary-source-stats">
      {/* Overview */}
      <div className="stats-overview">
        <div className="stat-item">
          <Archive size={18} strokeWidth={1} />
          <div className="stat-value">{statistics.sourceCount}</div>
          <div className="stat-label">Sources</div>
        </div>
        <div className="stat-item">
          <Image size={18} strokeWidth={1} />
          <div className="stat-value">{statistics.photoCount}</div>
          <div className="stat-label">Photos</div>
        </div>
        <div className="stat-item">
          <FileText size={18} strokeWidth={1} />
          <div className="stat-value">{statistics.chunkCount}</div>
          <div className="stat-label">Chunks</div>
        </div>
      </div>

      {/* Transcription Progress */}
      <div className="stats-section">
        <h5>Transcription Progress</h5>
        <div className="transcription-progress">
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${transcriptionRate}%` }}
            />
          </div>
          <div className="progress-stats">
            <span className="with-transcription">
              {statistics.withTranscription} transcribed
            </span>
            <span className="rate">{transcriptionRate}%</span>
            <span className="without-transcription">
              {statistics.withoutTranscription} remaining
            </span>
          </div>
        </div>
      </div>

      {/* Archives */}
      {topArchives.length > 0 && (
        <div className="stats-section">
          <h5>
            <Building2 size={14} strokeWidth={1} />
            Top Archives
          </h5>
          <ul className="stat-list">
            {topArchives.map(([archive, count]) => (
              <li key={archive}>
                <span className="stat-name">{archive}</span>
                <span className="stat-count">{count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Collections */}
      {topCollections.length > 0 && (
        <div className="stats-section">
          <h5>
            <FolderOpen size={14} strokeWidth={1} />
            Top Collections
          </h5>
          <ul className="stat-list">
            {topCollections.map(([collection, count]) => (
              <li key={collection}>
                <span className="stat-name">{collection}</span>
                <span className="stat-count">{count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Tags */}
      {statistics.tags.length > 0 && (
        <div className="stats-section">
          <h5>
            <Tag size={14} strokeWidth={1} />
            Tags ({statistics.tags.length})
          </h5>
          <div className="tags-cloud">
            {statistics.tags.slice(0, 15).map((tag) => (
              <span key={tag} className="tag">
                {tag}
              </span>
            ))}
            {statistics.tags.length > 15 && (
              <span className="more-tags">+{statistics.tags.length - 15}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
