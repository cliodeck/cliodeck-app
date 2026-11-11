/**
 * Les commandes du menu natif visent la fenêtre du moment du clic (S11-1-16).
 *
 * `createApplicationMenu` fermait ses clics sur la fenêtre du lancement. Sous macOS, l'app survit à
 * la fermeture de sa fenêtre, et la barre de menus reste : chaque commande (Cmd+Maj+O, Cmd+, …)
 * appelait `webContents.send` sur une fenêtre détruite, levait « Object has been destroyed », et ne
 * faisait rien. Une commande qui ouvre quelque chose recrée maintenant la fenêtre ; une commande sur
 * le document ouvert n'a rien à viser sans fenêtre, et ne fait rien.
 *
 * Une fenêtre recréée n'écoute pas tout de suite : la première page est le document vide, puis
 * React se monte et pose ses écouteurs bien après `did-finish-load` (CLAUDE.md §6, Electron 45). Le
 * preload dit au main quand un écouteur de commande est posé (`menu:listening`) ; d'ici là, la
 * commande attend.
 *
 * Pendant la sortie (jusqu'à 8 s, fenêtres masquées), rien ne se recrée, rien ne se réaffiche, rien
 * ne part au renderer.
 *
 * `electron` est simulé : `buildFromTemplate` rend le gabarit, `ipcMain` est un émetteur. Le vrai
 * menu, cliqué dans la vraie app, est dans `e2e/journey-menu-commands.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EventEmitter } from 'node:events';
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';

const h = vi.hoisted(() => ({ ipc: null as EventEmitter | null }));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  h.ipc = new EventEmitter();
  return {
    Menu: { buildFromTemplate: (template: MenuItemConstructorOptions[]) => template },
    ipcMain: h.ipc,
    dialog: { showMessageBox: vi.fn() },
    app: { name: 'ClioDeck', isPackaged: false, getAppPath: () => resolve(__dirname, '../../..') },
  };
});

import { createApplicationMenu } from '../menu';
import { loadMenuTranslations, setLanguage } from '../i18n';

interface FakeWindow {
  win: BrowserWindow;
  /** Ce que le renderer de cette fenêtre a reçu. */
  received: unknown[][];
  send: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  destroy: () => void;
}

/** Une fenêtre comme Electron la rend : détruite, `isDestroyed()` le dit et `send` lève. */
function fakeWindow(): FakeWindow {
  let destroyed = false;
  const received: unknown[][] = [];
  const send = vi.fn((...message: unknown[]) => {
    if (destroyed) throw new TypeError('Object has been destroyed');
    received.push(message);
  });
  const show = vi.fn();
  const reload = vi.fn();
  const webContents = { send, reload, reloadIgnoringCache: reload, isDestroyed: () => destroyed };
  const win = { webContents, isDestroyed: () => destroyed, show, focus: show };
  return {
    win: win as unknown as BrowserWindow,
    received,
    send,
    show,
    reload,
    destroy: () => {
      destroyed = true;
    },
  };
}

/**
 * Le preload d'une fenêtre dit qu'un écouteur de commande est posé (`menu:listening`). Le menu est
 * construit avant : dans l'app, `whenReady` le pose avant de créer la première fenêtre.
 */
function listening(fake: FakeWindow, ...channels: string[]): void {
  for (const channel of channels) h.ipc?.emit('menu:listening', { sender: fake.win.webContents }, channel);
}

/**
 * Les canaux qu'écoute le renderer, dans l'ordre où `useMenuShortcuts` pose ses écouteurs : c'est
 * l'ordre des annonces `menu:listening` d'une fenêtre qui se monte. Lus dans le hook lui-même.
 */
const MENU_CHANNELS = [
  ...readFileSync(resolve(__dirname, '../../renderer/src/hooks/useMenuShortcuts.ts'), 'utf8').matchAll(
    /\bon\('(menu:[a-z-]+)'/g
  ),
].map(([, channel]) => channel);

/** L'app telle que `index.ts` la compose : la fenêtre du moment, sa recréation, la sortie. */
function app(initial: FakeWindow | null) {
  const state = { current: initial, leaving: false, created: [] as FakeWindow[] };
  const createWindow = vi.fn(() => {
    const next = fakeWindow();
    state.created.push(next);
    state.current = next;
    return next.win;
  });
  const template = createApplicationMenu({
    currentWindow: () => state.current?.win ?? null,
    createWindow,
    isLeaving: () => state.leaving,
  }) as unknown as MenuItemConstructorOptions[];
  const click = (label: string): void => {
    const find = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions | null => {
      for (const item of items) {
        if (item.label === label) return item;
        const inner = Array.isArray(item.submenu) ? find(item.submenu) : null;
        if (inner) return inner;
      }
      return null;
    };
    const item = find(template);
    if (!item?.click) throw new Error(`Entrée de menu absente : ${label}`);
    // Electron passe la fenêtre qui a le focus, ou rien quand il n'y en a pas.
    (item.click as (...args: unknown[]) => void)(item, undefined, {});
  };
  return { state, createWindow, click, template };
}

const realPlatform = process.platform;

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  loadMenuTranslations();
  setLanguage('fr');
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  h.ipc?.removeAllListeners();
});

describe('macOS : la fenêtre fermée, le menu reste', () => {
  it('Fichier › Ouvrir projet : aucune exception, une fenêtre recréée, et la commande lui arrive quand son renderer écoute', () => {
    const first = fakeWindow();
    const { state, createWindow, click } = app(first);
    listening(first, ...MENU_CHANNELS);
    // Cmd+W : la fenêtre est détruite, avant même que `closed` n'ait remis la référence à null.
    first.destroy();

    expect(() => click('Ouvrir projet')).not.toThrow();

    expect(first.send).not.toHaveBeenCalled();
    expect(createWindow).toHaveBeenCalledTimes(1);
    const [second] = state.created;
    // React n'est pas encore monté : rien n'est perdu, rien n'est encore parti.
    expect(second.received).toEqual([]);
    listening(second, 'menu:new-file');
    expect(second.received).toEqual([]);
    listening(second, 'menu:open-project');
    expect(second.received).toEqual([['menu:open-project']]);
  });

  it('après le `closed` de la fenêtre (référence à null) : même chose', () => {
    const { state, createWindow, click } = app(null);

    click('Paramètres');

    expect(createWindow).toHaveBeenCalledTimes(1);
    listening(state.created[0], ...MENU_CHANNELS);
    expect(state.created[0].received).toEqual([['menu:open-settings']]);
  });

  it('deux commandes avant que le renderer n’écoute : les deux arrivent, une fois chacune, dans une seule fenêtre', () => {
    const { state, createWindow, click } = app(null);

    click('Nouveau projet');
    click('Panneau Bibliographie');

    // La seconde vise la fenêtre que la première a recréée : une seule fenêtre.
    expect(createWindow).toHaveBeenCalledTimes(1);
    listening(state.created[0], ...MENU_CHANNELS);
    listening(state.created[0], ...MENU_CHANNELS);
    expect(state.created[0].received).toEqual([['menu:new-project'], ['menu:switch-panel', 'bibliography']]);
  });

  it('elles arrivent dans l’ordre des clics, même quand le renderer écoute la seconde avant la première', () => {
    const { state, click } = app(null);

    // `useMenuShortcuts` écoute `menu:open-project` avant `menu:switch-panel` : l'ordre inverse des clics.
    expect(MENU_CHANNELS.indexOf('menu:open-project')).toBeLessThan(MENU_CHANNELS.indexOf('menu:switch-panel'));
    click('Panneau Bibliographie');
    click('Ouvrir projet');

    listening(state.created[0], ...MENU_CHANNELS);

    expect(state.created[0].received).toEqual([['menu:switch-panel', 'bibliography'], ['menu:open-project']]);
  });

  it('un clic dont le canal est déjà écouté attend derrière une commande encore en attente', () => {
    const { state, click } = app(null);
    click('Panneau Bibliographie');
    const [win] = state.created;
    listening(win, 'menu:open-project');

    click('Ouvrir projet');

    expect(win.received).toEqual([]);
    listening(win, 'menu:switch-panel');
    expect(win.received).toEqual([['menu:switch-panel', 'bibliography'], ['menu:open-project']]);
  });

  it('chaque commande que le menu envoie est écoutée par le renderer : aucune ne bloque la file', () => {
    const win = fakeWindow();
    const { template } = app(win);
    listening(win, ...MENU_CHANNELS);
    // Les deux liens de l'aide ouvrent le navigateur, Recharger ne passe pas par le renderer.
    const notSent = new Set(['Documentation', 'Signaler un problème', 'Recharger', 'Forcer le rechargement']);
    const clickable = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
      items.flatMap((item) => [
        ...(item.click && !notSent.has(String(item.label)) ? [item] : []),
        ...(Array.isArray(item.submenu) ? clickable(item.submenu) : []),
      ]);
    const items = clickable(template);

    for (const item of items) (item.click as (...args: unknown[]) => void)(item, undefined, {});

    // Une commande qu'aucun écouteur n'attend resterait en tête de file, et retiendrait les suivantes.
    expect(win.received).toHaveLength(items.length);
    for (const [channel] of win.received) expect(MENU_CHANNELS, String(channel)).toContain(channel);
  });

  it('sans fenêtre, une commande sur le document ouvert (Sauvegarder, Gras, Recharger) ne recrée rien et ne lève pas', () => {
    const { createWindow, click } = app(null);

    for (const label of ['Sauvegarder', 'Gras', 'Exporter PDF', 'Vérifier les citations', 'Recharger', 'Forcer le rechargement']) {
      expect(() => click(label), label).not.toThrow();
    }

    expect(createWindow).not.toHaveBeenCalled();
  });
});

describe('la commande vise la fenêtre du moment du clic', () => {
  it('une fenêtre recréée depuis la construction du menu reçoit la commande, pas l’ancienne', () => {
    const first = fakeWindow();
    const { state, click } = app(first);
    const second = fakeWindow();
    listening(second, ...MENU_CHANNELS);
    state.current = second;

    click('Ouvrir projet');

    expect(first.send).not.toHaveBeenCalled();
    expect(second.received).toEqual([['menu:open-project']]);
  });

  it('une fenêtre dont le renderer écoute reçoit la commande tout de suite', () => {
    const win = fakeWindow();
    const { createWindow, click } = app(win);
    listening(win, ...MENU_CHANNELS);

    click('Gras');

    expect(win.received).toEqual([['menu:format-bold']]);
    expect(createWindow).not.toHaveBeenCalled();
  });
});

describe('pendant la sortie (fenêtres masquées, jusqu’à 8 s)', () => {
  it('fenêtre masquée : rien ne part au renderer, rien n’est réaffiché, rien n’est recréé', () => {
    const win = fakeWindow();
    const { state, createWindow, click } = app(win);
    listening(win, ...MENU_CHANNELS);
    state.leaving = true;

    for (const label of ['Ouvrir projet', 'Nouveau fichier', 'Paramètres', 'Sauvegarder', 'Recharger']) click(label);

    expect(win.send).not.toHaveBeenCalled();
    expect(win.show).not.toHaveBeenCalled();
    expect(win.reload).not.toHaveBeenCalled();
    expect(createWindow).not.toHaveBeenCalled();
  });

  it('sans fenêtre : aucune fenêtre recréée', () => {
    const { state, createWindow, click } = app(null);
    state.leaving = true;

    click('Ouvrir projet');

    expect(createWindow).not.toHaveBeenCalled();
  });

  it('une commande en attente quand la sortie commence ne part pas', () => {
    const { state, click } = app(null);
    click('Ouvrir projet');
    state.leaving = true;

    listening(state.created[0], ...MENU_CHANNELS);

    expect(state.created[0].received).toEqual([]);
  });
});
