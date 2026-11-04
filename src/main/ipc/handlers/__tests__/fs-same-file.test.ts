/**
 * `fs:same-file` : le disque tranche, pas les chaînes (CLAUDE.md §6, #123). Savoir si
 * `context.md` est le document ouvert ne se lit pas sur deux chemins : casse différente sous
 * macOS, racine passant par un lien. Et le chemin passe par le validateur, comme les autres
 * canaux `fs:*` : ce qui mène hors du projet n'y est le même que rien.
 *
 * Vrai handler sur un vrai dossier ; seul le projet courant du main est simulé.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  projectPath: null as string | null,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
  dialog: {},
  shell: {},
  app: { isPackaged: false, getPath: () => '/tmp', getAppPath: () => '/nonexistent-app-path' },
}));
vi.mock('../../../services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => h.projectPath },
}));
vi.mock('../../../services/config-manager.js', () => ({
  configManager: { get: () => undefined, set: () => undefined },
}));

import { setupFilesystemHandlers } from '../filesystem-handlers.js';
import { symlinkAvailable } from '../../../../../backend/__tests__/helpers/native-guards.js';

setupFilesystemHandlers();

function same(a: unknown, b: unknown): Promise<boolean> {
  const handler = h.handlers.get('fs:same-file');
  if (!handler) throw new Error('canal non enregistré : fs:same-file');
  return handler({}, a, b) as Promise<boolean>;
}

let base: string;
let project: string;
let outside: string;
let contextMd: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-meme-fichier-'));
  project = path.join(base, 'projet');
  outside = path.join(base, 'dehors');
  fs.mkdirSync(project);
  fs.mkdirSync(outside);
  contextMd = path.join(project, 'context.md');
  fs.writeFileSync(contextMd, 'Consignes.');
  fs.writeFileSync(path.join(project, 'document.md'), 'Manuscrit.');
  h.projectPath = project;
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('fs:same-file', () => {
  it('le même chemin, puis un autre fichier', async () => {
    expect(await same(contextMd, contextMd)).toBe(true);
    expect(await same(contextMd, path.join(project, 'document.md'))).toBe(false);
  });

  it('un fichier encore absent, désigné deux fois, est le même', async () => {
    fs.rmSync(contextMd);

    expect(await same(contextMd, contextMd)).toBe(true);
    expect(await same(contextMd, path.join(project, 'document.md'))).toBe(false);
  });

  it('à la casse près, sur un disque qui ne la distingue pas', async () => {
    const shouted = path.join(path.dirname(project), 'PROJET', 'CONTEXT.MD');
    const insensitive = fs.existsSync(shouted);

    expect(await same(contextMd, shouted)).toBe(insensitive);
  });

  it('un nom en NFD désigne le fichier écrit en NFC', async () => {
    const nfc = path.join(project, 'été.md'.normalize('NFC'));
    const nfd = path.join(project, 'été.md'.normalize('NFD'));
    fs.writeFileSync(nfc, 'Texte.');

    expect(await same(nfc, nfd)).toBe(true);
  });

  it.skipIf(!symlinkAvailable)('une racine passée par un lien ne change pas le fichier', async () => {
    const alias = path.join(base, 'alias');
    fs.symlinkSync(project, alias);
    h.projectPath = alias;

    expect(await same(path.join(alias, 'context.md'), contextMd)).toBe(true);
    expect(await same(contextMd, path.join(alias, 'context.md'))).toBe(true);
    expect(await same(path.join(alias, 'document.md'), contextMd)).toBe(false);
  });

  it.skipIf(!symlinkAvailable)('un lien interne vers ce fichier est ce fichier', async () => {
    const link = path.join(project, 'consignes.md');
    fs.symlinkSync('context.md', link);

    expect(await same(link, contextMd)).toBe(true);
  });

  it('ce qui est hors du projet n’est le même que rien, sans lever', async () => {
    const elsewhere = path.join(outside, 'journal.md');
    fs.writeFileSync(elsewhere, 'Privé.');

    expect(await same(elsewhere, elsewhere)).toBe(false);
    expect(await same(elsewhere, contextMd)).toBe(false);
  });

  it.skipIf(!symlinkAvailable)('un lien qui sort du projet non plus : il ne confirme pas où il mène', async () => {
    const elsewhere = path.join(outside, 'journal.md');
    fs.writeFileSync(elsewhere, 'Privé.');
    fs.rmSync(contextMd);
    fs.symlinkSync(elsewhere, contextMd);

    expect(await same(contextMd, contextMd)).toBe(false);
    expect(await same(contextMd, elsewhere)).toBe(false);
  });

  it('sans projet ouvert : rien n’est le même', async () => {
    h.projectPath = null;

    expect(await same(contextMd, contextMd)).toBe(false);
  });

  it('un chemin qui n’en est pas un est refusé par le schéma', async () => {
    await expect(same('', contextMd)).rejects.toThrow();
    await expect(same(contextMd, 42)).rejects.toThrow();
  });
});
