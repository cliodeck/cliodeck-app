// @vitest-environment jsdom
/**
 * Un PDF indexé sans texte exploitable doit produire un avertissement visible,
 * quel que soit le bouton qui a lancé l'indexation (#132) : le processus
 * principal émet `pdf:low-text`, ce hook le transforme en notification.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { usePdfLowTextWarnings } from '../usePdfLowTextWarnings';
import { useNotificationStore } from '../../stores/notificationStore';

type LowTextInfo = { title: string; fileName: string; pageCount: number; charsPerPage: number };

function installBridge() {
  let emit: ((info: LowTextInfo) => void) | null = null;
  let unsubscribed = false;
  (window as unknown as { electron: unknown }).electron = {
    pdf: {
      onLowText: (cb: (info: LowTextInfo) => void) => {
        emit = cb;
        return () => {
          unsubscribed = true;
        };
      },
    },
  };
  return { emit: (info: LowTextInfo) => emit?.(info), wasUnsubscribed: () => unsubscribed };
}

afterEach(() => {
  cleanup();
  useNotificationStore.getState().dismissAll();
});

describe('usePdfLowTextWarnings', () => {
  it('affiche un avertissement qui nomme le PDF', () => {
    const bridge = installBridge();
    renderHook(() => usePdfLowTextWarnings());

    act(() => bridge.emit({ title: 'The Remaking of Memory', fileName: 'Wang_2025.pdf', pageCount: 13, charsPerPage: 0 }));

    const [notification] = useNotificationStore.getState().notifications;
    expect(notification.level).toBe('warning');
    expect(notification.title).toBe('pdfLowText.title');
  });

  it('se désabonne au démontage', () => {
    const bridge = installBridge();
    const { unmount } = renderHook(() => usePdfLowTextWarnings());
    unmount();
    expect(bridge.wasUnsubscribed()).toBe(true);
  });
});
