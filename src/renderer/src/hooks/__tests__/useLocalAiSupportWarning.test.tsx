// @vitest-environment jsdom
/**
 * Sous macOS 12 ou 13, Ollama ne s'installe pas : l'app doit le dire, une
 * fois, plutôt que de laisser chercher pourquoi rien ne s'indexe.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup, act } from '@testing-library/react';
import { useLocalAiSupportWarning } from '../useLocalAiSupportWarning';
import { useNotificationStore } from '../../stores/notificationStore';

type Support = { success: boolean; limited?: boolean; macosVersion?: string; noticeDismissed?: boolean };

function installBridge(support: Support) {
  const saved: Array<[string, unknown]> = [];
  let calls = 0;
  (window as unknown as { electron: unknown }).electron = {
    system: {
      getLocalAiSupport: () => {
        calls += 1;
        return Promise.resolve(support);
      },
    },
    config: {
      set: (key: string, value: unknown) => {
        saved.push([key, value]);
        return Promise.resolve({ success: true });
      },
    },
  };
  return { saved, calls: () => calls };
}

const notifications = () => useNotificationStore.getState().notifications;

afterEach(() => {
  cleanup();
  useNotificationStore.getState().dismissAll();
});

describe('useLocalAiSupportWarning', () => {
  it('avertit sous un macOS trop ancien pour Ollama, sans disparaître seul', async () => {
    const bridge = installBridge({ success: true, limited: true, macosVersion: '12.7.6', noticeDismissed: false });
    renderHook(() => useLocalAiSupportWarning());

    await waitFor(() => expect(notifications()).toHaveLength(1));
    const [notification] = notifications();
    expect(notification.level).toBe('warning');
    expect(notification.title).toBe('localAiLimited.title');
    expect(notification.duration).toBe(0);
    // Afficher n'est pas fermer : rien n'est retenu tant que l'utilisateur n'a rien fait.
    expect(bridge.saved).toEqual([]);
  });

  it('une fois fermé, s’en souvient pour les lancements suivants', async () => {
    const bridge = installBridge({ success: true, limited: true, macosVersion: '13.6', noticeDismissed: false });
    renderHook(() => useLocalAiSupportWarning());
    await waitFor(() => expect(notifications()).toHaveLength(1));

    act(() => useNotificationStore.getState().dismiss(notifications()[0].id));

    expect(bridge.saved).toEqual([['localAiNoticeDismissed', true]]);
    expect(notifications()).toHaveLength(0);
  });

  it('ne revient pas quand il a déjà été fermé lors d’un lancement précédent', async () => {
    const bridge = installBridge({ success: true, limited: true, macosVersion: '12.7.6', noticeDismissed: true });
    renderHook(() => useLocalAiSupportWarning());

    await waitFor(() => expect(bridge.calls()).toBe(1));
    await Promise.resolve();
    expect(notifications()).toHaveLength(0);
  });

  it('ne dit rien à partir de macOS 14 ni hors de macOS', async () => {
    const bridge = installBridge({ success: true, limited: false, macosVersion: '14.5', noticeDismissed: false });
    renderHook(() => useLocalAiSupportWarning());

    await waitFor(() => expect(bridge.calls()).toBe(1));
    await Promise.resolve();
    expect(notifications()).toHaveLength(0);
  });

  it('un nouveau rendu ne compte pas pour une fermeture', async () => {
    const bridge = installBridge({ success: true, limited: true, macosVersion: '12.7.6', noticeDismissed: false });
    const { rerender } = renderHook(() => useLocalAiSupportWarning());
    await waitFor(() => expect(notifications()).toHaveLength(1));

    rerender();
    rerender();

    expect(notifications()).toHaveLength(1);
    expect(bridge.saved).toEqual([]);
  });
});
