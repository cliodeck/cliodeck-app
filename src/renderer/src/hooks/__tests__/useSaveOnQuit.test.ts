// @vitest-environment jsdom
/**
 * Régression : `Cmd+Q` dans les secondes suivant une frappe perdait le
 * texte. `before-quit` arrêtait les services mais pas l'éditeur, et aucun
 * `beforeunload` n'existait côté renderer.
 *
 * On teste d'abord la DÉCISION (faut-il écrire ?), parce que c'est là qu'est le
 * piège : `isDirty` est mis à jour par une synchronisation debouncée, donc il est
 * encore faux au moment précis où l'auteur risque de perdre son texte. Puis le
 * rapport rendu au main, que le dialogue de sortie lit : vrai store, et le disque
 * simulé derrière l'IPC. La vraie fenêtre est dans `e2e/journey-window-close.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import type { EditorFacade } from '@/editor/facade';
import type { FlushReport } from '../../../../../backend/types/flush-report';
import { flushOpenDocument, needsFlush, useSaveOnQuit } from '../useSaveOnQuit';
import { useEditorStore } from '../../stores/editorStore';

describe('needsFlush', () => {
  it('écrit quand l’éditeur est marqué modifié', () => {
    expect(
      needsFlush({ filePath: '/p/document.md', isDirty: true, live: 'a', mirror: 'a' })
    ).toBe(true);
  });

  it('écrit quand le texte vivant a devancé le miroir du store', () => {
    // LE cas du bug : l'auteur vient de taper, la synchro debouncée n'a pas
    // encore couru, `isDirty` est donc encore faux.
    expect(
      needsFlush({
        filePath: '/p/document.md',
        isDirty: false,
        live: 'texte fraîchement tapé',
        mirror: 'texte',
      })
    ).toBe(true);
  });

  it('n’écrit pas quand rien n’a changé', () => {
    // Sinon on toucherait la date de tous les fichiers seulement ouverts.
    expect(
      needsFlush({ filePath: '/p/document.md', isDirty: false, live: 'a', mirror: 'a' })
    ).toBe(false);
  });

  it('n’écrit pas sans fichier de destination', () => {
    // Document jamais enregistré : il faudrait un « Enregistrer sous »,
    // qu'on ne peut pas demander pendant une fermeture.
    expect(needsFlush({ filePath: null, isDirty: true, live: 'a', mirror: '' })).toBe(false);
    expect(needsFlush({ filePath: '', isDirty: true, live: 'a', mirror: '' })).toBe(false);
  });
});

const FILE = '/p/document.md';

let writes: Array<[string, string]>;
let live: string;
let onWrite: () => Promise<{ success: boolean; error?: string }>;

const facade = () => ({ getValue: () => live }) as unknown as EditorFacade;

function openDocument(text: string, typed = ''): void {
  live = text + typed;
  useEditorStore.setState({ filePath: FILE, content: text, editorFacade: facade() });
}

beforeEach(() => {
  writes = [];
  onWrite = async () => ({ success: true });
  live = '';
  (window as unknown as { electron: unknown }).electron = {
    editor: {
      saveFile: async (path: string, content: string) => {
        writes.push([path, content]);
        return onWrite();
      },
    },
  };
  useEditorStore.setState({
    content: '',
    filePath: null,
    isDirty: false,
    lastSavedAt: null,
    editorFacade: null,
    bufferDetached: false,
    switchLock: null,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('flushOpenDocument', () => {
  it('document propre : rien à écrire', async () => {
    openDocument('Texte.');
    await expect(flushOpenDocument()).resolves.toEqual({ outcome: 'clean' });
    expect(writes).toEqual([]);
  });

  it('frappe que la synchro n’a pas vue : le texte VIVANT est écrit', async () => {
    openDocument('Texte.', ' Frappe.');
    await expect(flushOpenDocument()).resolves.toEqual({ outcome: 'saved' });
    expect(writes).toEqual([[FILE, 'Texte. Frappe.']]);
  });

  it('écriture refusée : `failed` et sa cause, et le texte reste à écrire', async () => {
    openDocument('Texte.', ' Frappe.');
    onWrite = async () => ({ success: false, error: 'EACCES: permission denied' });
    await expect(flushOpenDocument()).resolves.toEqual({ outcome: 'failed', error: 'EACCES: permission denied' });
    expect(useEditorStore.getState().content).toBe('Texte.');
    expect(useEditorStore.getState().getLiveContent()).toBe('Texte. Frappe.');
  });

  it('écriture qui rejette : `failed`, jamais un rejet', async () => {
    openDocument('Texte.', ' Frappe.');
    onWrite = () => Promise.reject(new Error('disque parti'));
    await expect(flushOpenDocument()).resolves.toEqual({ outcome: 'failed', error: 'disque parti' });
  });

  it('une lecture du texte qui lève : `failed`, jamais un rejet', async () => {
    useEditorStore.setState({
      filePath: FILE,
      editorFacade: {
        getValue: () => {
          throw new Error('vue morte');
        },
      } as unknown as EditorFacade,
    });
    await expect(flushOpenDocument()).resolves.toEqual({ outcome: 'failed', error: 'vue morte' });
  });

  it('frappe pendant l’écriture : la passe suivante l’écrit aussi', async () => {
    openDocument('Texte.', ' Un.');
    onWrite = async () => {
      if (writes.length === 1) live += ' Deux.';
      return { success: true };
    };
    await expect(flushOpenDocument()).resolves.toEqual({ outcome: 'saved' });
    expect(writes.map(([, text]) => text)).toEqual(['Texte. Un.', 'Texte. Un. Deux.']);
  });

  it('écriture ratée, mais une autre a tout écrit entre-temps : plus rien à signaler', async () => {
    openDocument('Texte.', ' Frappe.');
    onWrite = async () => {
      useEditorStore.setState({ content: live, isDirty: false, lastSavedAt: 123 });
      return { success: false, error: 'en retard' };
    };
    await expect(flushOpenDocument()).resolves.toEqual({ outcome: 'clean' });
  });

  it('tampon sans titre non vide : `untitled`, sans écriture', async () => {
    live = 'Une idée.';
    useEditorStore.setState({ editorFacade: facade() });
    await expect(flushOpenDocument()).resolves.toEqual({ outcome: 'untitled' });
    expect(writes).toEqual([]);
  });

  it('tampon sans titre vide : rien à perdre, rien à demander', async () => {
    useEditorStore.setState({ editorFacade: facade() });
    await expect(flushOpenDocument()).resolves.toEqual({ outcome: 'clean' });
  });

  it('vue détruite par un plantage : le dernier texte purgé dans le miroir fait foi', async () => {
    useEditorStore.setState({ filePath: FILE, content: 'Purgé au démontage.', isDirty: true, editorFacade: null });
    await expect(flushOpenDocument()).resolves.toEqual({ outcome: 'saved' });
    expect(writes).toEqual([[FILE, 'Purgé au démontage.']]);
  });

  it('vue détruite sur un tampon sans titre : le miroir porte encore le texte', async () => {
    useEditorStore.setState({ content: 'Une idée.', isDirty: true, editorFacade: null });
    await expect(flushOpenDocument()).resolves.toEqual({ outcome: 'untitled' });
  });

  it('tampon détaché : le sortant est écrit ou abandonné avec accord, ni écriture ni question', async () => {
    useEditorStore.setState({ bufferDetached: true, content: 'Inséré pendant la bascule.', isDirty: true });
    await expect(flushOpenDocument()).resolves.toEqual({ outcome: 'clean' });
    expect(writes).toEqual([]);
  });

  it('sous le verrou de renumérotation : attend la fin, puis écrit ce qui reste', async () => {
    vi.useFakeTimers();
    openDocument('Texte.', ' Frappe.');
    useEditorStore.setState({ switchLock: 'book.renumberInProgress' });

    let report: FlushReport | null = null;
    void flushOpenDocument().then((r) => {
      report = r;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(report).toBeNull();
    expect(writes).toEqual([]);

    useEditorStore.setState({ switchLock: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toEqual({ outcome: 'saved' });
    expect(writes).toEqual([[FILE, 'Texte. Frappe.']]);
  });

  it('un verrou qui dure n’emporte pas le tampon : écrit avant que le main renonce à attendre', async () => {
    vi.useFakeTimers();
    openDocument('Texte.', ' Frappe.');
    useEditorStore.setState({ switchLock: 'book.renumberInProgress' });

    let report: FlushReport | null = null;
    void flushOpenDocument().then((r) => {
      report = r;
    });
    // Le main attend 4 s : il doit rester de quoi écrire.
    await vi.advanceTimersByTimeAsync(3000);
    expect(report).toEqual({ outcome: 'saved' });
    expect(writes).toEqual([[FILE, 'Texte. Frappe.']]);
  });
});

describe('useSaveOnQuit', () => {
  function mountWithLifecycle() {
    let ask: () => void = () => undefined;
    const flushDone = vi.fn();
    const unsubscribe = vi.fn(() => {
      ask = () => undefined;
    });
    (window as unknown as { electron: Record<string, unknown> }).electron.lifecycle = {
      onFlushBeforeQuit: (callback: () => void) => {
        ask = callback;
        return unsubscribe;
      },
      flushDone,
    };
    const view = renderHook(() => useSaveOnQuit());
    return { ask: () => ask(), flushDone, unsubscribe, view };
  }

  it.each<[string, () => void, FlushReport]>([
    ['document propre', () => openDocument('Texte.'), { outcome: 'clean' }],
    ['document modifié', () => openDocument('Texte.', ' Frappe.'), { outcome: 'saved' }],
    [
      'écriture refusée',
      () => {
        openDocument('Texte.', ' Frappe.');
        onWrite = async () => ({ success: false, error: 'EACCES' });
      },
      { outcome: 'failed', error: 'EACCES' },
    ],
    [
      'tampon sans titre',
      () => {
        live = 'Une idée.';
        useEditorStore.setState({ editorFacade: facade() });
      },
      { outcome: 'untitled' },
    ],
  ])('l’accusé part avec le rapport : %s', async (_name, arrange, report) => {
    arrange();
    const { ask, flushDone } = mountWithLifecycle();
    ask();
    await vi.waitFor(() => expect(flushDone).toHaveBeenCalledTimes(1));
    expect(flushDone).toHaveBeenCalledWith(report);
  });

  it('démonté, il se désabonne : un remontage ne fait pas deux accusés', () => {
    const { unsubscribe, view } = mountWithLifecycle();
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
