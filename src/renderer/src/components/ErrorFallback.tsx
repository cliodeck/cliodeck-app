/**
 * Error Fallback Component
 * Displayed when a React component crashes
 */
import React from 'react';
import { FallbackProps } from 'react-error-boundary';

export const ErrorFallback: React.FC<FallbackProps> = ({ error, resetErrorBoundary }) => {
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        padding: '2rem',
        backgroundColor: '#f8f9fa',
      }}
    >
      <div
        style={{
          maxWidth: '600px',
          padding: '2rem',
          backgroundColor: 'white',
          borderRadius: '8px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
        }}
      >
        <h1 style={{ color: '#dc3545', marginBottom: '1rem' }}>
          Oops! Something went wrong
        </h1>
        <p style={{ marginBottom: '1rem', color: '#6c757d' }}>
          The application encountered an unexpected error. Please try reloading or contact support if the problem persists.
        </p>
        <details style={{ marginBottom: '1.5rem' }}>
          <summary
            style={{
              cursor: 'pointer',
              color: '#007bff',
              marginBottom: '0.5rem',
            }}
          >
            Error details
          </summary>
          <pre
            style={{
              padding: '1rem',
              backgroundColor: '#f8f9fa',
              borderRadius: '4px',
              overflow: 'auto',
              fontSize: '0.875rem',
              color: '#dc3545',
            }}
          >
            {error.message}
            {error.stack && '\n\n' + error.stack}
          </pre>
        </details>
        <button
          onClick={resetErrorBoundary}
          style={{
            padding: '0.5rem 1.5rem',
            backgroundColor: '#007bff',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '1rem',
          }}
          onMouseOver={(e) => (e.currentTarget.style.backgroundColor = '#0056b3')}
          onMouseOut={(e) => (e.currentTarget.style.backgroundColor = '#007bff')}
        >
          Try again
        </button>
      </div>
    </div>
  );
};
