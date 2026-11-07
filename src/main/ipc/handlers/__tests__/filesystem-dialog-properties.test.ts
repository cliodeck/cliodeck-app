/**
 * Ouvrir un projet Tropy sous Windows et Linux (S18-2-8).
 *
 * Le panneau Sources primaires demande `['openFile', 'openDirectory']` : sous
 * macOS, un paquet `.tropy` se choisit comme un dossier et un `.tpy` comme un
 * fichier. Sous Windows et Linux, la documentation d'Electron est formelle :
 * « an open dialog can not be both a file selector and a directory selector […]
 * a directory selector will be shown », et un `.tpy` devenait impossible à
 * choisir. Le main y retire donc `openDirectory` ; un paquet, simple dossier
 * sur ces systèmes, s'ouvre par son `project.tpy`.
 *
 * Vrai handler `dialog:open-file` ; le dialogue natif et la plateforme sont simulés.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialog: vi.fn(async (_options: { properties?: string[] }) => ({ canceled: true, filePaths: [] })),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
  dialog: { showOpenDialog: h.showOpenDialog },
  shell: {},
  app: { isPackaged: false, getPath: () => '/tmp', getAppPath: () => '/nonexistent-app-path' },
}));
vi.mock('../../../services/config-manager.js', () => ({
  configManager: { get: () => undefined, set: () => undefined },
}));

import { setupFilesystemHandlers } from '../filesystem-handlers.js';

setupFilesystemHandlers();

const PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;

afterEach(() => {
  Object.defineProperty(process, 'platform', PLATFORM);
  h.showOpenDialog.mockClear();
});

/** Les `properties` que le dialogue natif reçoit, sous `platform`. */
async function propertiesShown(platform: NodeJS.Platform, properties?: string[]): Promise<string[] | undefined> {
  Object.defineProperty(process, 'platform', { ...PLATFORM, value: platform });
  const handler = h.handlers.get('dialog:open-file');
  if (!handler) throw new Error('canal non enregistré : dialog:open-file');
  await handler({}, { title: 'Sélectionner un projet Tropy', properties, filters: [{ name: 'Tropy Project', extensions: ['tropy', 'tpy'] }] });
  expect(h.showOpenDialog).toHaveBeenCalledTimes(1);
  return h.showOpenDialog.mock.calls[0][0].properties;
}

describe('dialog:open-file — fichiers et dossiers à la fois', () => {
  it.each<NodeJS.Platform>(['win32', 'linux'])(
    '%s : openDirectory retiré, le .tpy redevient sélectionnable',
    async (platform) => {
      expect(await propertiesShown(platform, ['openFile', 'openDirectory'])).toEqual(['openFile']);
    }
  );

  it('darwin : inchangé, un paquet .tropy se choisit comme un dossier', async () => {
    expect(await propertiesShown('darwin', ['openFile', 'openDirectory'])).toEqual(['openFile', 'openDirectory']);
  });

  it.each<NodeJS.Platform>(['win32', 'linux', 'darwin'])(
    '%s : un choix de dossier seul reste un choix de dossier',
    async (platform) => {
      expect(await propertiesShown(platform, ['openDirectory', 'createDirectory'])).toEqual([
        'openDirectory',
        'createDirectory',
      ]);
    }
  );

  it.each<NodeJS.Platform>(['win32', 'linux'])('%s : les autres propriétés sont gardées', async (platform) => {
    expect(await propertiesShown(platform, ['openFile', 'openDirectory', 'multiSelections'])).toEqual([
      'openFile',
      'multiSelections',
    ]);
  });

  it('sans propriétés : rien n’est ajouté', async () => {
    expect(await propertiesShown('win32')).toBeUndefined();
  });
});
