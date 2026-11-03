// @vitest-environment jsdom
/**
 * Fichier › Enregistrer (Cmd+S) quand l'écriture échoue.
 *
 * `saveCurrentFile()` n'était pas attendu : l'échec finissait en rejet non géré, et le
 * « Enregistrer sous » du menu n'allait pas plus loin qu'un `console.error`. L'auteur ne
 * voyait rien d'autre que la pastille « Non enregistré », comme pendant toute frappe, alors
 * que le bouton de la barre d'outils alertait.
 *
 * Vrais hooks et stores, minuteurs simulés ; le disque est simulé derrière l'IPC, et le
 * menu natif réduit à ses gestionnaires capturés.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import type { EditorFacade } from '@/editor/facade';
import { useAutoSave } from '../useAutoSave';
import { useMenuShortcuts } from '../useMenuShortcuts';
import { useEditorStore } from '../../stores/editorStore';
import { useDialogStore } from '../../stores/dialogStore';
import { useNotificationStore } from '../../stores/notificationStore';
import i18n from '../../i18n';

const DOCUMENT = '/p/projet/document.md';
const CHAPTER = '/p/projet/chapitre.md';
const NOTE = '/ailleurs/note.md';
const ORIGINAL = '# Article\n';
const DELAY = 3000;

type WriteVerdict = { success: boolean; error?: string };

let handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
let disk: Record<string, string>;
let writes: Array<[string, string]>;
/** Ce que fait le disque à chaque écriture : réponse immédiate par défaut. */
let onWrite: () => Promise<WriteVerdict>;
let saveDialog: ReturnType<typeof vi.fn>;
let live: string;
let rejections: unknown[];

const refused = async (): Promise<WriteVerdict> => ({ success: false, error: 'EACCES: permission denied' });
const healthy = async (): Promise<WriteVerdict> => ({ success: true });

const store = () => useEditorStore.getState();
const dialogs = () => useDialogStore.getState();
const toasts = () => useNotificationStore.getState().notifications;
const facade = () => ({ getValue: () => live, setValue: () => undefined }) as unknown as EditorFacade;
const onRejection = (reason: unknown): void => {
  rejections.push(reason);
};

/** Une frappe : la vue change tout de suite, `isDirty` n'est posé que s'il était faux. */
function type(text: string): void {
  live += text;
  if (!store().isDirty) useEditorStore.setState({ isDirty: true });
}

const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** Déclenche Cmd+S tel que le preload le relaie, et laisse passer ce qui ne dépend pas du disque. */
async function cmdS(): Promise<void> {
  await act(async () => {
    for (const handler of handlers.get('menu:save-file') ?? []) void handler({});
    await vi.advanceTimersByTimeAsync(0);
  });
}

function hold(): { wait: () => Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait: () => held, release };
}

/** Une écriture retenue, jusqu'à ce que le test dise comment elle se termine. */
function heldWrite(verdict: () => Promise<WriteVerdict>): { finish: () => Promise<void> } {
  const gate = hold();
  onWrite = async () => {
    await gate.wait();
    return verdict();
  };
  return {
    finish: () =>
      act(async () => {
        gate.release();
        await vi.advanceTimersByTimeAsync(0);
      }),
  };
}

function open(path: string | null, text: string): void {
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
  handlers = new Map();
  disk = { [DOCUMENT]: ORIGINAL, [CHAPTER]: '# Chapitre\n' };
  writes = [];
  onWrite = healthy;
  rejections = [];
  process.on('unhandledRejection', onRejection);
  saveDialog = vi.fn(async () => ({ canceled: false, filePath: NOTE }));
  (window as unknown as { electron: unknown }).electron = {
    editor: {
      loadFile: async (path: string) => ({ success: true, content: disk[path] ?? '' }),
      saveFile: async (path: string, content: string) => {
        writes.push([path, content]);
        const verdict = await onWrite();
        if (verdict.success) disk[path] = content;
        return verdict;
      },
    },
    dialog: { saveFile: saveDialog },
    ipcRenderer: {
      on: (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
      },
      // Un retrait qui retire : une commande, un écouteur. Le doublement du vrai pont n'est
      // pas l'objet de ces tests, et le simulacre de `t` relance l'effet à chaque rendu.
      removeListener: (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, (handlers.get(channel) ?? []).filter((h) => h !== handler));
      },
    },
  };
  useNotificationStore.getState().dismissAll();
  useEditorStore.setState((s) => ({
    bufferDetached: false,
    switchLock: null,
    settings: { ...s.settings, autoSave: true, autoSaveDelay: DELAY },
  }));
  open(DOCUMENT, ORIGINAL);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  process.off('unhandledRejection', onRejection);
  useEditorStore.setState({
    filePath: null,
    content: '',
    isDirty: false,
    editorFacade: null,
    switchLock: null,
    bufferDetached: false,
  });
  useNotificationStore.getState().dismissAll();
  while (dialogs().confirmOpen) dialogs().resolveConfirm(false);
  while (dialogs().alertOpen) dialogs().closeAlert();
});

describe('Cmd+S sur un fichier ouvert', () => {
  beforeEach(() => {
    renderHook(() => useMenuShortcuts());
  });

  it('écriture refusée : le message du bouton, aucun rejet non géré, et le texte reste', async () => {
    type('Une phrase.');
    onWrite = refused;

    await cmdS();

    expect(dialogs().alertMessage).toBe(i18n.t('toolbar.saveError'));
    expect(dialogs().queue).toHaveLength(1);
    expect(rejections).toEqual([]);
    expect(disk[DOCUMENT]).toBe(ORIGINAL);
    expect(store().filePath).toBe(DOCUMENT);
    expect(store().isDirty).toBe(true);
    expect(store().getLiveContent()).toBe(`${ORIGINAL}Une phrase.`);
  });

  it('canal d’écriture en erreur : le même message', async () => {
    type('Une phrase.');
    window.electron.editor.saveFile = (async () => {
      throw new Error('invoke refusé');
    }) as never;

    await cmdS();

    expect(dialogs().alertMessage).toBe(i18n.t('toolbar.saveError'));
    expect(rejections).toEqual([]);
  });

  it('le second essai écrit tout, sans message', async () => {
    type('Une phrase.');
    onWrite = refused;
    await cmdS();
    act(() => dialogs().closeAlert());

    onWrite = healthy;
    await cmdS();

    expect(disk[DOCUMENT]).toBe(`${ORIGINAL}Une phrase.`);
    expect(store().isDirty).toBe(false);
    expect(dialogs().alertOpen).toBe(false);
  });

  // Un volume démonté se voit aussi sur un document propre : l'auteur qui enregistre par
  // réflexe doit l'apprendre, et la pastille dit « Enregistré ».
  it('document sans modification : l’échec se dit quand même', async () => {
    onWrite = refused;

    await cmdS();

    expect(dialogs().alertMessage).toBe(i18n.t('toolbar.saveError'));
  });

  // Le `t` de ces tests est un simulacre qui rend la clé : cela suffit à voir d'où vient le
  // message. Le vrai `t` périmé d'un écouteur non retiré est joué dans le parcours e2e.
  it('le message suit la langue du moment, pas celle de l’écouteur', async () => {
    onWrite = refused;
    await i18n.changeLanguage('de');
    try {
      await cmdS();

      expect(dialogs().alertMessage).toBe('Fehler beim Speichern der Datei');
    } finally {
      await i18n.changeLanguage('fr');
    }
  });

  it('témoin : une écriture réussie ne dit rien', async () => {
    type('Une phrase.');

    await cmdS();

    expect(disk[DOCUMENT]).toBe(`${ORIGINAL}Une phrase.`);
    expect(dialogs().alertOpen).toBe(false);
  });

  it('pendant une renumérotation : l’échec se dit comme tel, et le verrou reste', async () => {
    type('Une phrase.');
    act(() => store().setSwitchLock('book.renumberInProgress'));
    onWrite = refused;

    await cmdS();

    expect(dialogs().alertMessage).toBe(i18n.t('toolbar.saveError'));
    expect(store().switchLock).toBe('book.renumberInProgress');
  });
});

describe('Cmd+S et un document qui change', () => {
  beforeEach(() => {
    renderHook(() => useMenuShortcuts());
  });

  it('hors de tout document : ni écriture, ni message, même sur un disque en panne', async () => {
    await act(async () => {
      await store().replaceBuffer({ kind: 'detach' }, 'project-switch');
    });
    onWrite = refused;

    await cmdS();

    expect(writes).toEqual([]);
    expect(dialogs().alertOpen).toBe(false);
    expect(rejections).toEqual([]);
  });

  // Le main a pu basculer sur l'autre projet et refuser ce chemin : rien n'est à écrire, et
  // l'alerte parlerait d'un document qui n'est plus à l'écran.
  it('détaché pendant l’écriture : son échec n’annonce rien', async () => {
    const write = heldWrite(refused);
    await cmdS();
    expect(writes).toHaveLength(1);

    await act(async () => {
      await store().replaceBuffer({ kind: 'detach' }, 'project-switch');
    });
    await write.finish();

    expect(store().bufferDetached).toBe(true);
    expect(dialogs().alertOpen).toBe(false);
    expect(rejections).toEqual([]);
  });

  it('Cmd+S pendant l’écriture d’une bascule : le texte est écrit, et son échec n’annonce rien', async () => {
    type('Une phrase.');
    const flush = heldWrite(healthy);
    let switching: Promise<unknown> = Promise.resolve();
    await act(async () => {
      switching = store().replaceBuffer({ kind: 'open', filePath: CHAPTER }, 'open-file');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(writes).toHaveLength(1);

    const write = heldWrite(refused);
    await cmdS();
    expect(writes).toHaveLength(2);

    await flush.finish();
    await act(async () => {
      await switching;
    });
    expect(store().filePath).toBe(CHAPTER);
    await write.finish();

    expect(disk[DOCUMENT]).toBe(`${ORIGINAL}Une phrase.`);
    expect(dialogs().alertOpen).toBe(false);
    expect(rejections).toEqual([]);
  });
});

describe('Cmd+S à côté de l’autosave', () => {
  beforeEach(() => {
    renderHook(() => {
      useMenuShortcuts();
      useAutoSave();
    });
  });

  it('les deux en échec : une alerte, un seul message collant, et ils disent la même chose', async () => {
    onWrite = refused;
    type('Une phrase.');
    await wait(DELAY);
    expect(toasts()).toHaveLength(1);

    await cmdS();

    expect(dialogs().alertMessage).toBe(i18n.t('toolbar.saveError'));
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].title).toBe(i18n.t('editor.autoSaveFailed'));
    expect(store().isDirty).toBe(true);
  });

  it('Cmd+S en échec ne coupe pas les essais : le disque revenu, le texte part seul', async () => {
    onWrite = refused;
    type('Une phrase.');
    await cmdS();
    act(() => dialogs().closeAlert());

    onWrite = healthy;
    await wait(DELAY);

    expect(disk[DOCUMENT]).toBe(`${ORIGINAL}Une phrase.`);
    expect(store().isDirty).toBe(false);
    expect(toasts()).toEqual([]);
  });

  it('Cmd+S réussit pendant une série : le message collant s’en va, sans alerte', async () => {
    onWrite = refused;
    type('Une phrase.');
    await wait(DELAY);
    expect(toasts()).toHaveLength(1);

    onWrite = healthy;
    await cmdS();

    expect(disk[DOCUMENT]).toBe(`${ORIGINAL}Une phrase.`);
    expect(toasts()).toEqual([]);
    expect(dialogs().alertOpen).toBe(false);
  });

  it('Cmd+S derrière une écriture d’autosave en vol : pas de faux échec', async () => {
    const autosave = heldWrite(healthy);
    type('Une phrase.');
    await wait(DELAY);
    expect(writes).toHaveLength(1);

    await cmdS();
    expect(writes).toHaveLength(2);
    await autosave.finish();

    expect(disk[DOCUMENT]).toBe(`${ORIGINAL}Une phrase.`);
    expect(store().isDirty).toBe(false);
    expect(dialogs().alertOpen).toBe(false);
    expect(toasts()).toEqual([]);
  });

  /** L'autosave part, Cmd+S part derrière lui et échouera : les deux écritures sont en vol. */
  async function autoThenManualInFlight(): Promise<{
    finishAuto: () => Promise<void>;
    failManual: () => Promise<void>;
  }> {
    const autosave = heldWrite(healthy);
    type('Une phrase.');
    await wait(DELAY);
    const manual = heldWrite(refused);
    await cmdS();
    expect(writes).toHaveLength(2);
    return { finishAuto: autosave.finish, failManual: manual.finish };
  }

  it('Cmd+S échoue derrière un autosave qui a tout écrit : rien à annoncer', async () => {
    const { finishAuto, failManual } = await autoThenManualInFlight();

    await finishAuto();
    expect(store().isDirty).toBe(false);
    await failManual();

    expect(dialogs().alertOpen).toBe(false);
    expect(rejections).toEqual([]);
  });

  it('témoin : même échec, mais il reste une frappe à écrire : l’alerte part', async () => {
    const { finishAuto, failManual } = await autoThenManualInFlight();

    type(' Et une autre.');
    await finishAuto();
    expect(store().isDirty).toBe(true);
    await failManual();

    expect(dialogs().alertMessage).toBe(i18n.t('toolbar.saveError'));
  });
});

describe('Cmd+S sur un tampon sans titre', () => {
  beforeEach(() => {
    renderHook(() => useMenuShortcuts());
    open(null, '');
    type('Une idée à part.');
  });

  it('destination refusée : le message, et le texte reste dans le tampon', async () => {
    onWrite = refused;

    await cmdS();

    expect(saveDialog).toHaveBeenCalledTimes(1);
    expect(dialogs().alertMessage).toBe(i18n.t('toolbar.saveError'));
    expect(dialogs().queue).toHaveLength(1);
    expect(disk[NOTE]).toBeUndefined();
    expect(store().filePath).toBeNull();
    expect(store().isDirty).toBe(true);
    expect(store().getLiveContent()).toBe('Une idée à part.');
    expect(rejections).toEqual([]);
  });

  it('le second essai écrit le fichier, et le tampon prend son chemin', async () => {
    onWrite = refused;
    await cmdS();
    act(() => dialogs().closeAlert());

    onWrite = healthy;
    await cmdS();

    expect(disk[NOTE]).toBe('Une idée à part.');
    expect(store().filePath).toBe(NOTE);
    expect(store().isDirty).toBe(false);
    expect(dialogs().alertOpen).toBe(false);
  });

  it('le dialogue lui-même en erreur : le même message', async () => {
    saveDialog.mockImplementation(async () => {
      throw new Error('dialogue refusé');
    });

    await cmdS();

    expect(dialogs().alertMessage).toBe(i18n.t('toolbar.saveError'));
    expect(store().getLiveContent()).toBe('Une idée à part.');
    expect(rejections).toEqual([]);
  });

  it('témoin : le dialogue annulé ne dit rien, et n’écrit rien', async () => {
    saveDialog.mockImplementation(async () => ({ canceled: true }));

    await cmdS();

    expect(writes).toEqual([]);
    expect(dialogs().alertOpen).toBe(false);
  });
});
