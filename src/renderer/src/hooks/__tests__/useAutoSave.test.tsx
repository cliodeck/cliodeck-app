// @vitest-environment jsdom
/**
 * L'autosave ne s'arrête pas tant qu'il reste du texte à écrire.
 *
 * Le minuteur ne se réarmait qu'au passage de `isDirty` de faux à vrai, et la frappe ne
 * le repose que s'il est faux : `isDirty` resté vrai, après une frappe pendant l'écriture
 * ou après un échec, coupait l'autosave jusqu'au prochain clic sur Enregistrer. Une fois
 * la place revenue sur le disque, le texte ne partait plus tout seul (rejeu de #182).
 *
 * Vrais hook et store, minuteurs simulés ; le disque est simulé derrière l'IPC.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import type { EditorFacade } from '@/editor/facade';

import { useAutoSave } from '../useAutoSave';
import { useEditorStore } from '../../stores/editorStore';
import { useNotificationStore } from '../../stores/notificationStore';
import i18n from '../../i18n';

const A = '/p/a.md';
const B = '/p/b.md';
const DELAY = 3000;

let writes: Array<[string, string]>;
let live: string;
/** Ce que fait le disque à chaque écriture : réponse immédiate par défaut. */
let onWrite: () => Promise<{ success: boolean; error?: string }>;

const store = () => useEditorStore.getState();
const toasts = () => useNotificationStore.getState().notifications;
const facade = () => ({ getValue: () => live }) as unknown as EditorFacade;

/** Une frappe : la vue change tout de suite, `isDirty` n'est posé que s'il était faux. */
function type(text: string): void {
  live += text;
  if (!store().isDirty) useEditorStore.setState({ isDirty: true });
}

const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** Seconde par seconde : un essai réarme le suivant dans un effet, que `act` doit laisser passer. */
async function runFor(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 1000) await wait(1000);
}

function hold(): { wait: () => Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait: () => held, release };
}

const diskFull = async () => ({ success: false, error: 'ENOSPC: no space left on device' });
const healthy = async () => ({ success: true });

function open(path: string, text: string): void {
  live = text;
  useEditorStore.setState((s) => ({
    filePath: path,
    content: text,
    isDirty: false,
    lastSavedAt: null,
    documentVersion: s.documentVersion + 1,
    editorFacade: facade(),
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  writes = [];
  onWrite = healthy;
  (window as unknown as { electron: unknown }).electron = {
    editor: {
      saveFile: async (path: string, content: string) => {
        writes.push([path, content]);
        return onWrite();
      },
    },
  };
  useNotificationStore.getState().dismissAll();
  useEditorStore.setState((s) => ({
    bufferDetached: false,
    switchLock: null,
    settings: { ...s.settings, autoSave: true, autoSaveDelay: DELAY },
  }));
  open(A, 'v0');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useEditorStore.setState({ filePath: null, content: '', isDirty: false, editorFacade: null });
  useNotificationStore.getState().dismissAll();
});

describe('useAutoSave : une écriture réussie, et du texte tapé pendant', () => {
  it('le minuteur repart, et la frappe de pendant l’écriture part toute seule', async () => {
    const gate = hold();
    onWrite = async () => {
      await gate.wait();
      return { success: true };
    };
    renderHook(() => useAutoSave());

    type(' un');
    await wait(DELAY);
    expect(writes).toEqual([[A, 'v0 un']]);

    type(' deux');
    onWrite = healthy;
    gate.release();
    await wait(0);
    expect(store().isDirty).toBe(true);

    await wait(DELAY);

    expect(writes).toEqual([
      [A, 'v0 un'],
      [A, 'v0 un deux'],
    ]);
    expect(store().isDirty).toBe(false);
    expect(store().content).toBe('v0 un deux');
  });

  it('rien de neuf : une seule écriture, puis plus rien', async () => {
    renderHook(() => useAutoSave());

    type(' un');
    await wait(DELAY * 10);

    expect(writes).toEqual([[A, 'v0 un']]);
    expect(store().isDirty).toBe(false);
  });

  it('Cmd+S avec frappe pendant l’écriture : l’autosave prend la suite', async () => {
    renderHook(() => useAutoSave());
    const gate = hold();
    onWrite = async () => {
      await gate.wait();
      return { success: true };
    };

    type(' un');
    const manual = store().saveFile();
    type(' deux');
    await act(async () => {
      gate.release();
      await manual;
    });
    onWrite = healthy;

    await wait(DELAY);

    expect(writes.at(-1)).toEqual([A, 'v0 un deux']);
    expect(store().isDirty).toBe(false);
  });
});

describe('useAutoSave : une écriture en échec', () => {
  it('une fois la place revenue, le texte part sans clic', async () => {
    onWrite = diskFull;
    renderHook(() => useAutoSave());

    type(' un');
    await wait(DELAY);
    expect(writes).toHaveLength(1);
    expect(store().isDirty).toBe(true);

    onWrite = healthy;
    await wait(DELAY * 2);

    expect(writes).toEqual([
      [A, 'v0 un'],
      [A, 'v0 un'],
    ]);
    expect(store().isDirty).toBe(false);
    expect(store().lastSavedAt).not.toBeNull();
  });

  it('pas de rafale sur un disque plein : le délai double, jusqu’à une fois par minute', async () => {
    onWrite = diskFull;
    renderHook(() => useAutoSave());

    type(' un');
    const attempts: number[] = [];
    for (let second = 1; second <= 360; second += 1) {
      const before = writes.length;
      await wait(1000);
      if (writes.length > before) attempts.push(second);
    }

    expect(attempts.slice(0, 6)).toEqual([3, 9, 21, 45, 93, 153]);
    const gaps = attempts.slice(1).map((second, index) => second - attempts[index]);
    expect(Math.max(...gaps)).toBe(60);
    expect(attempts.length).toBeLessThanOrEqual(10);
  });

  it('frapper pendant les échecs ne rapproche pas les essais', async () => {
    onWrite = diskFull;
    renderHook(() => useAutoSave());

    type(' un');
    await wait(DELAY);
    expect(writes).toHaveLength(1);

    for (let i = 0; i < 5; i += 1) {
      type('x');
      await wait(1000);
    }

    expect(writes).toHaveLength(1);
    await wait(1000);
    expect(writes).toHaveLength(2);
    expect(writes[1][1]).toBe('v0 unxxxxx');
  });

  it('l’auteur est prévenu une fois, et le message reste tant que le texte n’est pas écrit', async () => {
    onWrite = diskFull;
    renderHook(() => useAutoSave());

    type(' un');
    await wait(DELAY);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]).toMatchObject({
      level: 'error',
      title: i18n.t('editor.autoSaveFailed'),
      duration: 0,
    });
    expect(toasts()[0].details).toContain('ENOSPC');

    await runFor(300_000);

    expect(writes.length).toBeGreaterThan(4);
    expect(toasts()).toHaveLength(1);
  });

  it('le texte écrit, le message s’en va', async () => {
    onWrite = diskFull;
    renderHook(() => useAutoSave());
    type(' un');
    await wait(DELAY);
    expect(toasts()).toHaveLength(1);

    onWrite = healthy;
    await wait(DELAY * 2);

    expect(store().isDirty).toBe(false);
    expect(toasts()).toHaveLength(0);
  });

  it('fermé par l’auteur, le message ne revient pas pendant cette série', async () => {
    onWrite = diskFull;
    renderHook(() => useAutoSave());
    type(' un');
    await wait(DELAY);

    act(() => useNotificationStore.getState().dismissAll());
    await runFor(120_000);

    expect(writes.length).toBeGreaterThan(2);
    expect(toasts()).toHaveLength(0);
  });

  it('une nouvelle série après une reprise : prévenu de nouveau, et le délai repart du début', async () => {
    onWrite = diskFull;
    renderHook(() => useAutoSave());
    type(' un');
    await wait(DELAY);
    await wait(DELAY * 2);
    expect(writes).toHaveLength(2);

    onWrite = healthy;
    await wait(DELAY * 4);
    expect(store().isDirty).toBe(false);
    expect(toasts()).toHaveLength(0);

    onWrite = diskFull;
    const before = writes.length;
    type(' deux');
    await wait(DELAY);
    expect(writes).toHaveLength(before + 1);
    expect(toasts()).toHaveLength(1);
    await wait(DELAY * 2);
    expect(writes).toHaveLength(before + 2);
  });

  it('Enregistrer à la main pendant la série : le délai repart du début, et le message s’en va', async () => {
    onWrite = diskFull;
    renderHook(() => useAutoSave());
    type(' un');
    await wait(DELAY);
    await wait(DELAY * 2);
    await wait(DELAY * 4);
    expect(writes).toHaveLength(3);

    onWrite = healthy;
    await act(async () => {
      await store().saveFile();
    });
    expect(store().isDirty).toBe(false);
    expect(toasts()).toHaveLength(0);

    const before = writes.length;
    type(' deux');
    await wait(DELAY);
    expect(writes).toHaveLength(before + 1);
  });

  it('un autre document : la série ne le concerne pas', async () => {
    onWrite = diskFull;
    renderHook(() => useAutoSave());
    type(' un');
    await wait(DELAY);
    await wait(DELAY * 2);
    expect(writes).toHaveLength(2);
    expect(toasts()).toHaveLength(1);

    onWrite = healthy;
    act(() => open(B, 'b0'));
    expect(toasts()).toHaveLength(0);

    type(' suite');
    await wait(DELAY);
    expect(writes.at(-1)).toEqual([B, 'b0 suite']);
  });

  it('le document a changé pendant l’écriture qui échoue : rien à dire du nouveau', async () => {
    const gate = hold();
    onWrite = async () => {
      await gate.wait();
      return { success: false, error: 'ENOSPC' };
    };
    renderHook(() => useAutoSave());
    type(' un');
    await wait(DELAY);

    onWrite = healthy;
    act(() => open(B, 'b0'));
    await act(async () => {
      gate.release();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(toasts()).toHaveLength(0);

    type(' suite');
    await wait(DELAY);
    expect(writes.at(-1)).toEqual([B, 'b0 suite']);
  });

  it('démonté : plus de minuteur, ni de message orphelin', async () => {
    onWrite = diskFull;
    const { unmount } = renderHook(() => useAutoSave());
    type(' un');
    await wait(DELAY);
    expect(toasts()).toHaveLength(1);

    unmount();
    expect(toasts()).toHaveLength(0);

    const before = writes.length;
    await runFor(120_000);
    expect(writes).toHaveLength(before);
  });

  it('démonté pendant l’écriture qui échoue : aucun message que plus rien ne retirerait', async () => {
    const gate = hold();
    onWrite = async () => {
      await gate.wait();
      return { success: false, error: 'ENOSPC' };
    };
    const { unmount } = renderHook(() => useAutoSave());
    type(' un');
    await wait(DELAY);

    unmount();
    await act(async () => {
      gate.release();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(toasts()).toEqual([]);
  });
});

describe('useAutoSave : ce qui a déjà été retenu', () => {
  it('une écriture lente d’un document, l’autre document tapé entre-temps : il part aussi', async () => {
    // Le minuteur du nouveau document tombe pendant l'écriture de l'ancien, et se tait :
    // sans relance à la fin de cette écriture, plus rien ne l'écrirait.
    const gate = hold();
    onWrite = async () => {
      await gate.wait();
      return { success: true };
    };
    renderHook(() => useAutoSave());
    type(' un');
    await wait(DELAY);
    expect(writes).toEqual([[A, 'v0 un']]);

    act(() => open(B, 'b0'));
    type(' suite');
    await wait(DELAY);
    expect(writes).toHaveLength(1);

    onWrite = healthy;
    await act(async () => {
      gate.release();
      await vi.advanceTimersByTimeAsync(0);
    });
    await wait(DELAY);

    expect(writes.at(-1)).toEqual([B, 'b0 suite']);
    expect(store().isDirty).toBe(false);
  });

  it('autosave coupé dans les réglages : aucune écriture, rien de réarmé', async () => {
    useEditorStore.setState((s) => ({ settings: { ...s.settings, autoSave: false } }));
    renderHook(() => useAutoSave());

    type(' un');
    await wait(DELAY * 4);

    expect(writes).toEqual([]);
    expect(store().isDirty).toBe(true);
  });
});
