import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useNotificationStore } from '../notificationStore';

beforeEach(() => {
  useNotificationStore.setState({ notifications: [], expandedId: null });
  vi.useFakeTimers();
});

describe('notificationStore (A18)', () => {
  it('notify adds a notification', () => {
    useNotificationStore.getState().notify({
      level: 'success',
      title: 'Indexed',
      message: '42 pages indexed',
    });
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
    expect(useNotificationStore.getState().notifications[0].title).toBe('Indexed');
  });

  it('auto-dismisses after duration', () => {
    useNotificationStore.getState().notify({
      level: 'info',
      title: 'Test',
      duration: 1000,
    });
    expect(useNotificationStore.getState().notifications).toHaveLength(1);

    vi.advanceTimersByTime(1001);
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it('sticky notifications (duration=0) do not auto-dismiss', () => {
    useNotificationStore.getState().notify({
      level: 'error',
      title: 'Critical',
      duration: 0,
    });
    vi.advanceTimersByTime(60000);
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
  });

  it('dismiss removes by id', () => {
    const id = useNotificationStore.getState().notify({
      level: 'warning',
      title: 'Warn',
      duration: 0,
    });
    useNotificationStore.getState().dismiss(id);
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it('toggleExpanded opens/closes details', () => {
    const id = useNotificationStore.getState().notify({
      level: 'error',
      title: 'Oops',
      details: 'Stack trace here',
      duration: 0,
    });
    expect(useNotificationStore.getState().expandedId).toBeNull();

    useNotificationStore.getState().toggleExpanded(id);
    expect(useNotificationStore.getState().expandedId).toBe(id);

    useNotificationStore.getState().toggleExpanded(id);
    expect(useNotificationStore.getState().expandedId).toBeNull();
  });

  it('dismissAll clears everything', () => {
    useNotificationStore.getState().notify({ level: 'info', title: 'A', duration: 0 });
    useNotificationStore.getState().notify({ level: 'info', title: 'B', duration: 0 });
    useNotificationStore.getState().dismissAll();
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });
});
