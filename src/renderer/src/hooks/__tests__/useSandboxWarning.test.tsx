// @vitest-environment jsdom
/**
 * Une AppImage lancée sans le bac à sable de Chromium doit le dire (#151) :
 * le lanceur l'ajoute de lui-même, l'utilisateur n'a rien demandé.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { useSandboxWarning } from '../useSandboxWarning';
import { useNotificationStore } from '../../stores/notificationStore';

type Status = { success: boolean; disabled?: boolean; appImage?: boolean };

function installBridge(status: Status) {
  let calls = 0;
  (window as unknown as { electron: unknown }).electron = {
    system: {
      getSandboxStatus: () => {
        calls += 1;
        return Promise.resolve(status);
      },
    },
  };
  return { calls: () => calls };
}

const notifications = () => useNotificationStore.getState().notifications;

afterEach(() => {
  cleanup();
  useNotificationStore.getState().dismissAll();
});

describe('useSandboxWarning', () => {
  it('avertit, sans disparaître seul, et renvoie au paquet .deb pour une AppImage', async () => {
    installBridge({ success: true, disabled: true, appImage: true });
    renderHook(() => useSandboxWarning());

    await waitFor(() => expect(notifications()).toHaveLength(1));
    const [notification] = notifications();
    expect(notification.level).toBe('warning');
    expect(notification.title).toBe('sandboxDisabled.title');
    expect(notification.message).toBe('sandboxDisabled.messageAppImage');
    expect(notification.details).toBe('sandboxDisabled.detailsAppImage');
    expect(notification.duration).toBe(0);
  });

  it('hors AppImage, ne parle pas du paquet .deb', async () => {
    installBridge({ success: true, disabled: true, appImage: false });
    renderHook(() => useSandboxWarning());

    await waitFor(() => expect(notifications()).toHaveLength(1));
    expect(notifications()[0].message).toBe('sandboxDisabled.message');
    expect(notifications()[0].details).toBeUndefined();
  });

  it('ne dit rien quand le bac à sable est actif', async () => {
    const bridge = installBridge({ success: true, disabled: false, appImage: false });
    renderHook(() => useSandboxWarning());

    await waitFor(() => expect(bridge.calls()).toBe(1));
    await Promise.resolve();
    expect(notifications()).toHaveLength(0);
  });

  it('n’empile pas les avertissements au fil des rendus', async () => {
    installBridge({ success: true, disabled: true, appImage: true });
    const { rerender } = renderHook(() => useSandboxWarning());

    await waitFor(() => expect(notifications()).toHaveLength(1));
    rerender();
    rerender();
    expect(notifications()).toHaveLength(1);
  });

  it('une fois fermé, ne revient pas', async () => {
    installBridge({ success: true, disabled: true, appImage: true });
    const { rerender } = renderHook(() => useSandboxWarning());

    await waitFor(() => expect(notifications()).toHaveLength(1));
    useNotificationStore.getState().dismissAll();
    rerender();
    expect(notifications()).toHaveLength(0);
  });
});
