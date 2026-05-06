/**
 * StatusToast — non-blocking notification toasts (A18).
 *
 * Renders a stack of toast notifications at the bottom-right. Each toast
 * can be dismissed manually, and critical ones (with `details`) show an
 * expandable "Details" drawer inline.
 */

import React from 'react';
import { X, ChevronDown, ChevronRight, Info, CheckCircle, AlertTriangle, XCircle } from 'lucide-react';
import { useNotificationStore, type NotificationLevel } from '../../stores/notificationStore';
import './StatusToast.css';

const ICONS: Record<NotificationLevel, React.ReactNode> = {
  info: <Info size={16} />,
  success: <CheckCircle size={16} />,
  warning: <AlertTriangle size={16} />,
  error: <XCircle size={16} />,
};

export const StatusToast: React.FC = () => {
  const notifications = useNotificationStore((s) => s.notifications);
  const expandedId = useNotificationStore((s) => s.expandedId);
  const dismiss = useNotificationStore((s) => s.dismiss);
  const toggleExpanded = useNotificationStore((s) => s.toggleExpanded);

  if (notifications.length === 0) return null;

  return (
    <div className="status-toast-container" aria-live="polite">
      {notifications.map((notif) => (
        <div
          key={notif.id}
          className={`status-toast status-toast--${notif.level}`}
          role="alert"
        >
          <div className="status-toast__header">
            <span className="status-toast__icon">{ICONS[notif.level]}</span>
            <div className="status-toast__text">
              <span className="status-toast__title">{notif.title}</span>
              {notif.message && (
                <span className="status-toast__message">{notif.message}</span>
              )}
            </div>
            <div className="status-toast__actions">
              {notif.details && (
                <button
                  className="status-toast__details-btn"
                  onClick={() => toggleExpanded(notif.id)}
                  aria-expanded={expandedId === notif.id}
                >
                  {expandedId === notif.id ? (
                    <ChevronDown size={14} />
                  ) : (
                    <ChevronRight size={14} />
                  )}
                </button>
              )}
              <button
                className="status-toast__dismiss"
                onClick={() => dismiss(notif.id)}
                aria-label="Dismiss"
              >
                <X size={14} />
              </button>
            </div>
          </div>
          {notif.details && expandedId === notif.id && (
            <pre className="status-toast__details">{notif.details}</pre>
          )}
        </div>
      ))}
    </div>
  );
};
