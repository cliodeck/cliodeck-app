import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useNotificationStore } from '../notificationStore';

beforeEach(() => {
  useNotificationStore.setState({ notifications: [], expandedId: null });
  vi.useFakeTimers();
  // Les minuteurs laissés par le test précédent ne doivent pas compter dans celui-ci.
  vi.clearAllTimers();
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

  describe('une notification dépliée', () => {
    const notifications = () => useNotificationStore.getState().notifications;
    const store = () => useNotificationStore.getState();

    it('reste à son échéance, tant qu’on lit ses détails', () => {
      const id = store().notify({ level: 'warning', title: 'PDF sans texte', details: '3 pages', duration: 12000 });
      store().toggleExpanded(id);

      vi.advanceTimersByTime(12001);
      expect(notifications()).toHaveLength(1);
      expect(store().expandedId).toBe(id);

      vi.advanceTimersByTime(60000);
      expect(notifications()).toHaveLength(1);
    });

    it('repliée, elle part à l’échéance suivante, pas avant', () => {
      const id = store().notify({ level: 'warning', title: 'PDF sans texte', details: '3 pages', duration: 12000 });
      store().toggleExpanded(id);
      vi.advanceTimersByTime(12001);

      store().toggleExpanded(id);
      expect(notifications()).toHaveLength(1);

      vi.advanceTimersByTime(11998);
      expect(notifications()).toHaveLength(1);

      vi.advanceTimersByTime(2);
      expect(notifications()).toHaveLength(0);
    });

    it('déplier une autre notification replie la première, qui part à son échéance', () => {
      const a = store().notify({ level: 'info', title: 'A', details: 'a', duration: 1000 });
      const b = store().notify({ level: 'info', title: 'B', details: 'b', duration: 5000 });
      store().toggleExpanded(a);
      vi.advanceTimersByTime(1001);
      expect(notifications().map((n) => n.id)).toEqual([a, b]);

      store().toggleExpanded(b);
      vi.advanceTimersByTime(1000);
      expect(notifications().map((n) => n.id)).toEqual([b]);
      expect(store().expandedId).toBe(b);
    });

    it('fermée à la main, rien ne la fait revenir et aucun minuteur ne reste', () => {
      const id = store().notify({ level: 'info', title: 'A', details: 'a', duration: 1000 });
      store().toggleExpanded(id);
      vi.advanceTimersByTime(1001);

      store().dismiss(id);
      expect(notifications()).toHaveLength(0);

      vi.advanceTimersByTime(1000);
      expect(notifications()).toHaveLength(0);
      expect(store().expandedId).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('dismissAll fait de même, et une nouvelle dépliée ne hérite de rien', () => {
      const id = store().notify({ level: 'info', title: 'A', details: 'a', duration: 1000 });
      store().toggleExpanded(id);
      vi.advanceTimersByTime(1001);

      store().dismissAll();
      const next = store().notify({ level: 'info', title: 'B', details: 'b', duration: 5000 });
      store().toggleExpanded(next);

      vi.advanceTimersByTime(1000);
      expect(notifications().map((n) => n.id)).toEqual([next]);
      expect(store().expandedId).toBe(next);
      expect(vi.getTimerCount()).toBe(1);
    });

    it('le réarmement n’accumule pas de minuteurs', () => {
      const id = store().notify({ level: 'info', title: 'A', details: 'a', duration: 1000 });
      store().toggleExpanded(id);

      for (let i = 0; i < 50; i += 1) {
        vi.advanceTimersByTime(1000);
        expect(vi.getTimerCount()).toBe(1);
      }
    });

    it('sans échéance (duration 0), elle ne s’arme jamais, dépliée ou non', () => {
      const id = store().notify({ level: 'error', title: 'Fatal', details: 'x', duration: 0 });
      expect(vi.getTimerCount()).toBe(0);

      store().toggleExpanded(id);
      vi.advanceTimersByTime(60000);
      store().toggleExpanded(id);
      vi.advanceTimersByTime(60000);

      expect(vi.getTimerCount()).toBe(0);
      expect(notifications()).toHaveLength(1);
    });
  });
});
