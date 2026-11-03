/**
 * Error Fallback Component
 * Displayed when a React component crashes.
 *
 * Fusion 3.1 + 3.2 — moved from inline-style + bootstrap colour
 * parachute to theme tokens via `ErrorFallback.css`. The fallback
 * now respects the active theme (dark/light) instead of forcing a
 * white card on a grey backdrop.
 *
 * « Réessayer » recharge la page : le document s'écrit d'abord. Le plantage a démonté
 * l'éditeur et son autosave, mais le texte est encore dans le store.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FallbackProps } from 'react-error-boundary';
import { flushOpenDocument } from '../hooks/useSaveOnQuit';
import './ErrorFallback.css';

export const ErrorFallback: React.FC<FallbackProps> = ({
  error,
  resetErrorBoundary,
}) => {
  const { t } = useTranslation('common');
  const err = error instanceof Error ? error : new Error(String(error));
  const [retrying, setRetrying] = useState(false);
  const [unsaved, setUnsaved] = useState<'failed' | 'untitled' | null>(null);

  const handleRetry = async (): Promise<void> => {
    setRetrying(true);
    const { outcome } = await flushOpenDocument();
    setRetrying(false);
    if (outcome === 'failed' || outcome === 'untitled') {
      setUnsaved(outcome);
      return;
    }
    resetErrorBoundary();
  };

  return (
    <div role="alert" className="error-fallback">
      <div className="error-fallback__card">
        <h1 className="error-fallback__title">{t('errorFallback.title')}</h1>
        <p className="error-fallback__lede">
          The application encountered an unexpected error. Please try reloading
          or contact support if the problem persists.
        </p>
        <details className="error-fallback__details">
          <summary>{t('errorFallback.details')}</summary>
          <pre className="error-fallback__stack">
            {err.message}
            {err.stack && '\n\n' + err.stack}
          </pre>
        </details>
        {unsaved && (
          <p className="error-fallback__blocked">
            {t(unsaved === 'failed' ? 'errorFallback.saveFailed' : 'errorFallback.untitledUnsaved')}
          </p>
        )}
        <div className="error-fallback__actions">
          <button
            type="button"
            onClick={handleRetry}
            disabled={retrying}
            className="error-fallback__retry"
          >
            {t('errorFallback.retry')}
          </button>
          {unsaved && (
            <button
              type="button"
              onClick={resetErrorBoundary}
              className="error-fallback__reload-anyway"
            >
              {t('errorFallback.reloadAnyway')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
