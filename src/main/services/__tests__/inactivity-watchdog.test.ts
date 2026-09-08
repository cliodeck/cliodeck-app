import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInactivityWatchdog } from '../inactivity-watchdog.js';

describe('createInactivityWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('déclenche après le délai sans activité', () => {
    const onTimeout = vi.fn();
    const w = createInactivityWatchdog({ timeoutMs: 1000, onTimeout });
    w.touch();
    vi.advanceTimersByTime(999);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(w.timedOut).toBe(false);
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(w.timedOut).toBe(true);
  });

  it('une réponse qui continue d’arriver n’est jamais coupée', () => {
    const onTimeout = vi.fn();
    const w = createInactivityWatchdog({ timeoutMs: 1000, onTimeout });
    w.touch();
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(800);
      w.touch();
    }
    // 8 s écoulées, jamais plus de 800 ms sans activité.
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('disarm arrête le compteur ; touch après le délai ne réarme pas', () => {
    const onTimeout = vi.fn();
    const w = createInactivityWatchdog({ timeoutMs: 1000, onTimeout });
    w.touch();
    w.disarm();
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();

    w.touch();
    vi.advanceTimersByTime(1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    w.touch();
    vi.advanceTimersByTime(5000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('sans délai (absent, 0, non fini), ne déclenche jamais', () => {
    for (const timeoutMs of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const onTimeout = vi.fn();
      const w = createInactivityWatchdog({ timeoutMs, onTimeout });
      w.touch();
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(onTimeout).not.toHaveBeenCalled();
      expect(w.timedOut).toBe(false);
    }
  });
});
