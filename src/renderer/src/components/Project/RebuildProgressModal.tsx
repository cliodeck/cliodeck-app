import { useEffect, useRef } from 'react';
import { useRebuildStore } from '../../stores/rebuildStore';
import { useDialogStore } from '../../stores/dialogStore';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useTranslation } from 'react-i18next';
import './RebuildProgressModal.css';

export function RebuildProgressModal() {
  const { t } = useTranslation('common');
  const { isRebuilding, progress, failure, resetProgress } = useRebuildStore();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Un dialogue de la file s'affiche par-dessus le message et passe d'abord : les
  // pièges écoutent tous `document`, Échap fermerait les deux d'un coup, et le message
  // partirait sans avoir été lu.
  const dialogAbove = useDialogStore((s) => s.alertOpen || s.confirmOpen);
  const awaitingAnswer = failure !== null && !dialogAbove;

  // Pendant la reconstruction, rien de tout cela : le voile n'est pas fermable et le
  // focus reste où il était. Le piège n'existe que pour le message d'échec.
  const dialogRef = useFocusTrap({ active: awaitingAnswer, onEscape: resetProgress });

  useEffect(() => {
    if (awaitingAnswer) closeButtonRef.current?.focus();
  }, [awaitingAnswer]);

  if (failure !== null) {
    return (
      <div className="rebuild-modal-overlay">
        <div
          ref={dialogRef}
          className="rebuild-modal"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="rebuild-modal-title"
          aria-describedby="rebuild-modal-description"
        >
          <div className="rebuild-modal-header">
            <h2 id="rebuild-modal-title">{t('rebuild.failedTitle')}</h2>
            <p id="rebuild-modal-description" className="rebuild-modal-subtitle">
              {t('rebuild.failedMessage')}
            </p>
          </div>

          <div className="rebuild-modal-body">
            <p className="rebuild-failure-cause">{failure}</p>
            <div className="rebuild-modal-footer">
              <button
                ref={closeButtonRef}
                className="rebuild-modal-close"
                onClick={resetProgress}
              >
                {t('actions.close')}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

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
