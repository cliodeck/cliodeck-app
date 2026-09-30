/**
 * La vérification « pandoc et xelatex sont-ils là ? » des deux services
 * d'export, telle qu'elle s'exécute vraiment.
 *
 * Sous Windows, elle lançait `which`, qui n'existe pas : le lancement
 * échouait, l'événement `error` n'était écouté par personne — donc une
 * exception non rattrapée dans le processus principal — et le bouton
 * « Exporter » restait grisé alors que les deux outils étaient installés.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

interface SpawnCall {
  command: string;
  args: string[];
  options: { env: NodeJS.ProcessEnv };
}

const calls: SpawnCall[] = [];
/** Ce que fait le processus simulé : trouvé, absent, ou introuvable au lancement. */
let outcome: 'found' | 'not-found' | 'spawn-error' = 'found';

vi.mock('child_process', () => ({
  spawn: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => {
      if (outcome === 'spawn-error') {
        // Ce que fait Node quand le binaire n'existe pas : sans écouteur,
        // `emit('error')` lève — c'est le défaut que l'on garde.
        child.emit('error', Object.assign(new Error('spawn which ENOENT'), { code: 'ENOENT' }));
        return;
      }
      child.emit('close', outcome === 'found' ? 0 : 1);
    });
    return child;
  },
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false },
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { fromWebContents: () => null },
}));

const { pdfExportService } = await import('../pdf-export.js');
const { wordExportService } = await import('../word-export.js');

/** `checkPandoc` est privée : l'export Word la traverse à chaque envoi. */
const checkPandoc = () =>
  (wordExportService as unknown as { checkPandoc(): Promise<boolean> }).checkPandoc();

const WINDOWS_PATH = 'C:\\Program Files\\Pandoc\;C:\\Windows\\system32';
let realPlatform: NodeJS.Platform;
let realPath: string | undefined;

function pretendPlatform(platform: NodeJS.Platform, pathValue: string) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  process.env.PATH = pathValue;
}

beforeEach(() => {
  calls.length = 0;
  outcome = 'found';
  realPlatform = process.platform;
  realPath = process.env.PATH;
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  process.env.PATH = realPath;
});

describe('export PDF — recherche des outils', () => {
  it('sous Windows : `where`, et le PATH transmis intact', async () => {
    pretendPlatform('win32', WINDOWS_PATH);

    await expect(pdfExportService.checkDependencies()).resolves.toEqual({ pandoc: true, xelatex: true });

    expect(calls.map((c) => c.command)).toEqual(['where', 'where']);
    expect(calls.map((c) => c.args[0]).sort()).toEqual(['pandoc', 'xelatex']);
    for (const call of calls) {
      expect(call.options.env.PATH).toBe(WINDOWS_PATH);
      expect(call.options.env.PATH).not.toContain('/opt/homebrew/bin');
    }
  });

  it('sur macOS : `which`, et les emplacements Homebrew/MacTeX ajoutés', async () => {
    pretendPlatform('darwin', '/usr/bin');

    await pdfExportService.checkDependencies();

    expect(calls.map((c) => c.command)).toEqual(['which', 'which']);
    expect(calls[0].options.env.PATH).toContain('/Library/TeX/texbin');
  });

  it('un outil absent est rapporté absent, sans exception', async () => {
    pretendPlatform('darwin', '/usr/bin');
    outcome = 'not-found';
    await expect(pdfExportService.checkDependencies()).resolves.toEqual({ pandoc: false, xelatex: false });
  });

  it('un lancement impossible répond « absent » au lieu de lever', async () => {
    pretendPlatform('win32', WINDOWS_PATH);
    outcome = 'spawn-error';
    await expect(pdfExportService.checkDependencies()).resolves.toEqual({ pandoc: false, xelatex: false });
  });
});

describe('export Word — recherche de pandoc', () => {
  it('sous Windows : `where`, PATH intact, et un lancement impossible répond « absent »', async () => {
    pretendPlatform('win32', WINDOWS_PATH);

    await expect(checkPandoc()).resolves.toBe(true);
    expect(calls[0].command).toBe('where');
    expect(calls[0].options.env.PATH).toBe(WINDOWS_PATH);

    outcome = 'spawn-error';
    await expect(checkPandoc()).resolves.toBe(false);
  });

  it('sur macOS : `which` et PATH étendu', async () => {
    pretendPlatform('darwin', '/usr/bin');
    await checkPandoc();
    expect(calls[0].command).toBe('which');
    expect(calls[0].options.env.PATH).toContain('/opt/homebrew/bin');
  });
});
