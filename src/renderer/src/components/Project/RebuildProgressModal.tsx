import { useRebuildStore } from '../../stores/rebuildStore';
import './RebuildProgressModal.css';

export function RebuildProgressModal() {
  const { isRebuilding, progress } = useRebuildStore();

  if (!isRebuilding) {
    return null;
  }

  return (
    <div className="rebuild-modal-overlay">
      <div className="rebuild-modal">
        <div className="rebuild-modal-header">
          <h2>Building Search Indexes</h2>
          <p className="rebuild-modal-subtitle">
            Optimizing search performance for your corpus...
          </p>
        </div>

        <div className="rebuild-modal-body">
          <div className="rebuild-progress-bar-container">
            <div
              className="rebuild-progress-bar"
              style={{ width: `${progress.percentage}%` }}
            />
          </div>

          <div className="rebuild-progress-info">
            <span className="rebuild-progress-percentage">{progress.percentage}%</span>
            <span className="rebuild-progress-status">{progress.status}</span>
          </div>

          <div className="rebuild-info-box">
            <p>
              This process runs once when opening a project with existing documents.
              Future searches will be significantly faster.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
