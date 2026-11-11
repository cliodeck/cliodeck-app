/**
 * Les accélérateurs du menu natif, lus dans le gabarit construit.
 *
 * Sous macOS, Cmd+Maj+Q est « Fermer la session » : le système le prend avant l'app, et l'auteur
 * qui voulait un bloc citation se retrouvait devant la fermeture de sa session (D3). Le bloc
 * citation passe à Cmd+Option+Q. Sous Windows, AltGr arrive comme Ctrl+Alt : AltGr+Q tape `@` sur
 * un clavier allemand, celui des clés de citation `[@clé]`. Ctrl+Alt+Q l'aurait pris ; Windows et
 * Linux gardent donc Ctrl+Maj+Q, qui n'y ferme rien.
 *
 * `electron` est simulé : `buildFromTemplate` rend le gabarit. Le vrai menu, cliqué, est dans
 * `e2e/journey-menu-commands.spec.ts`. Aucune touche n'est envoyée au système.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: (template: MenuItemConstructorOptions[]) => template },
  ipcMain: { on: vi.fn(), once: vi.fn(), removeListener: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  app: { name: 'ClioDeck', isPackaged: false, getAppPath: () => resolve(__dirname, '../../..') },
}));

import { createApplicationMenu } from '../menu';
import { loadMenuTranslations, setLanguage } from '../i18n';

const realPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
});

function itemsOn(platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  Object.defineProperty(process, 'platform', { value: platform });
  loadMenuTranslations();
  setLanguage('fr');
  const fakeWindow = { webContents: { send: vi.fn() }, isDestroyed: () => false } as unknown as BrowserWindow;
  const template = createApplicationMenu({
    currentWindow: () => fakeWindow,
    createWindow: () => fakeWindow,
    isLeaving: () => false,
  }) as unknown as MenuItemConstructorOptions[];
  const flat: MenuItemConstructorOptions[] = [];
  const walk = (items: MenuItemConstructorOptions[]): void => {
    for (const item of items) {
      flat.push(item);
      if (Array.isArray(item.submenu)) walk(item.submenu);
    }
  };
  walk(template);
  return flat;
}

const blockquote = (items: MenuItemConstructorOptions[]) => items.find((i) => i.label === 'Bloc citation');

/** `CmdOrCtrl+Shift+Q` et `Shift+CmdOrCtrl+Q` sont le même geste : on compare des ensembles. */
function gesture(accelerator: string, platform: NodeJS.Platform): string {
  return accelerator
    .split('+')
    .map((part) => (part === 'CmdOrCtrl' ? (platform === 'darwin' ? 'Cmd' : 'Ctrl') : part))
    .map((part) => (part === 'Option' ? 'Alt' : part === 'Command' ? 'Cmd' : part === 'Control' ? 'Ctrl' : part))
    .sort()
    .join('+')
    .toLowerCase();
}

describe('Bloc citation : un raccourci que le système ne prend pas', () => {
  it('macOS : Cmd+Option+Q, et plus jamais Cmd+Maj+Q', () => {
    const item = blockquote(itemsOn('darwin'));
    expect(item?.accelerator).toBeDefined();
    expect(gesture(String(item?.accelerator), 'darwin')).toBe('alt+cmd+q');
  });

  it.each<NodeJS.Platform>(['win32', 'linux'])('%s : Ctrl+Maj+Q, pas Ctrl+Alt+Q, qui est AltGr+Q', (platform) => {
    const item = blockquote(itemsOn(platform));
    expect(gesture(String(item?.accelerator), platform)).toBe('ctrl+q+shift');
  });

  it.each<NodeJS.Platform>(['darwin', 'win32', 'linux'])('%s : aucun accélérateur ne sert deux fois', (platform) => {
    const gestures = itemsOn(platform)
      .map((item) => item.accelerator)
      .filter((accelerator): accelerator is string => typeof accelerator === 'string')
      .map((accelerator) => gesture(accelerator, platform));
    expect(gestures.length).toBeGreaterThan(10);
    expect(new Set(gestures).size).toBe(gestures.length);
  });
});
