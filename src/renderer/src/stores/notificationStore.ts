/**
 * Notification store — non-blocking toast notifications (A18).
 *
 * All notifications are non-blocking: they appear, auto-dismiss after a
 * configurable duration, and critical ones show a "Details" button that
 * opens an expandable drawer inline.
 */

import { create } from 'zustand';

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

export interface Notification {
  id: string;
  level: NotificationLevel;
  title: string;
  message?: string;
  /** Detailed error/context shown when "Details" is expanded. */
  details?: string;
  /** Auto-dismiss duration in ms. 0 = sticky until manually dismissed. */
  duration: number;
  /** ISO timestamp of creation. */
  createdAt: string;
}

interface NotificationState {
  notifications: Notification[];
  /** Currently expanded notification id (for the details drawer). */
  expandedId: string | null;

  notify: (opts: {
    level: NotificationLevel;
    title: string;
    message?: string;
    details?: string;
    duration?: number;
  }) => string;
  dismiss: (id: string) => void;
  dismissAll: () => void;
  toggleExpanded: (id: string) => void;
}

const DEFAULT_DURATIONS: Record<NotificationLevel, number> = {
  info: 4000,
  success: 3000,
  warning: 6000,
  error: 8000,
};

function generateId(): string {
  return `notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export const useNotificationStore = create<NotificationState>()((set) => ({
  notifications: [],
  expandedId: null,

  notify: ({ level, title, message, details, duration }) => {
    const id = generateId();
    const notif: Notification = {
      id,
      level,
      title,
      message,
      details,
      duration: duration ?? DEFAULT_DURATIONS[level],
      createdAt: new Date().toISOString(),
    };

    set((state) => ({
      notifications: [...state.notifications, notif],
    }));

    // Auto-dismiss after duration (unless sticky)
    if (notif.duration > 0) {
      setTimeout(() => {
        set((state) => ({
          notifications: state.notifications.filter((n) => n.id !== id),
          expandedId: state.expandedId === id ? null : state.expandedId,
        }));
      }, notif.duration);
    }

    return id;
  },

  dismiss: (id) =>
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
      expandedId: state.expandedId === id ? null : state.expandedId,
    })),

  dismissAll: () => set({ notifications: [], expandedId: null }),

  toggleExpanded: (id) =>
    set((state) => ({
      expandedId: state.expandedId === id ? null : id,
    })),
}));
