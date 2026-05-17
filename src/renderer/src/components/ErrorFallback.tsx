/**
 * Error Fallback Component
 * Displayed when a React component crashes.
 *
 * Fusion 3.1 + 3.2 — moved from inline-style + bootstrap colour
 * parachute to theme tokens via `ErrorFallback.css`. The fallback
 * now respects the active theme (dark/light) instead of forcing a
 * white card on a grey backdrop.
 */
import React from 'react';
import { FallbackProps } from 'react-error-boundary';
import './ErrorFallback.css';

export const ErrorFallback: React.FC<FallbackProps> = ({
  error,
  resetErrorBoundary,
}) => {
  const err = error instanceof Error ? error : new Error(String(error));
  return (
    <div role="alert" className="error-fallback">
      <div className="error-fallback__card">
        <h1 className="error-fallback__title">Oops! Something went wrong</h1>
        <p className="error-fallback__lede">
          The application encountered an unexpected error. Please try reloading
          or contact support if the problem persists.
        </p>
        <details className="error-fallback__details">
          <summary>Error details</summary>
          <pre className="error-fallback__stack">
            {err.message}
            {err.stack && '\n\n' + err.stack}
          </pre>
        </details>
        <button
          type="button"
          onClick={resetErrorBoundary}
          className="error-fallback__retry"
        >
          Try again
        </button>
      </div>
    </div>
  );
};
