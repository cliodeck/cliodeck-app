import { useRebuildStore } from '../../stores/rebuildStore';
import { useTranslation } from 'react-i18next';
import './RebuildProgressModal.css';

export function RebuildProgressModal() {
  const { t } = useTranslation('common');
  const { isRebuilding, progress } = useRebuildStore();

  if (!isRebuilding) {
    return null;
  }

  return (
    <div className="rebuild-modal-overlay">
      <div
        className="rebuild-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="rebuild-modal-title"
        aria-describedby="rebuild-modal-description"
      >
        <div className="rebuild-modal-header">
          <h2 id="rebuild-modal-title">{t('rebuild.title')}</h2>
          <p id="rebuild-modal-description" className="rebuild-modal-subtitle">
            {t('rebuild.subtitle')}
          </p>
        </div>

        <div className="rebuild-modal-body">
          <div className="rebuild-progress-bar-container">
            <div
              className="rebuild-progress-bar"
              role="progressbar"
              aria-valuenow={progress.percentage}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={t('rebuild.progressAria')}
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
