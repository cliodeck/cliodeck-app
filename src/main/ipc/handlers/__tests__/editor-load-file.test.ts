/**
 * `editor:load-file` dit ce qui empêche d'ouvrir un document (S11-1-1, décision Q9).
 *
 * Toute erreur de lecture ressemblait à un fichier absent, et le repli de l'ouverture
 * d'un projet réécrivait le fichier par « # Nom ». Et `readFile(…, 'utf-8')` changeait
 * les accents d'un fichier Latin-1 en U+FFFD, que l'autosave rendait définitifs.
 *
 * Vrais handlers sur un vrai dossier ; seul le projet courant du main est simulé.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  projectPath: '' as string,
  /** Allonge les `realpath` à venir, donc la validation d'un chemin : en ms, dans l'ordre. */
  realpathDelays: [] as number[],
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const mocked = {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const delay = h.realpathDelays.shift();
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      return actual.realpath(...args);
    },
  };
  return { ...mocked, default: mocked };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
  BrowserWindow: { fromWebContents: () => null },
  app: { isPackaged: false, getPath: () => '/tmp', getAppPath: () => '/nulle-part' },
}));

vi.mock('../../../services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => h.projectPath },
}));
vi.mock('../../../services/manuscript-index-service.js', () => ({
  manuscriptIndexService: { isEnabled: () => false },
}));
vi.mock('../../../services/retrieval-service.js', () => ({ retrievalService: {} }));
vi.mock('../../../services/reading-notes-index-service.js', () => ({
  readingNotesIndexService: { configure: () => undefined, isReadingNoteFile: () => false },
}));
vi.mock('../../../services/reading-notes-indexing.js', () => ({
  indexReadingNotesInBackground: () => undefined,
}));
vi.mock('../../../services/history-service.js', () => ({
  historyService: { getHistoryManager: () => null },
}));

import { setupEditorHandlers } from '../editor-handlers.js';
import { validateWritePath } from '../../utils/path-validator.js';

interface LoadResponse {
  success: boolean;
  content?: string;
  code?: string;
  reason?: string;
  error?: string;
}

function call<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`canal non enregistré : ${channel}`);
  return handler({}, ...args) as Promise<T>;
}

const load = (filePath: string) => call<LoadResponse>('editor:load-file', filePath);

/** « Été » en Latin-1 : des octets qui ne forment pas de l'UTF-8. */
const LATIN1 = Buffer.from([0x23, 0x20, 0xc9, 0x74, 0xe9, 0x0a]);
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

describe('editor:load-file', () => {
  let project: string;
  let documentMd: string;

  beforeEach(async () => {
    setupEditorHandlers();
    project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-lecture-')));
    h.projectPath = project;
    h.realpathDelays = [];
    documentMd = path.join(project, 'document.md');
    fs.writeFileSync(documentMd, '# Chapitre\n');
    // Sous Vitest, le second de deux import() concurrents d'un module simulé rend
    // le vrai module (mesuré), et le validateur garde en cache son import paresseux.
    await validateWritePath(documentMd);
  });

  afterEach(() => {
    fs.chmodSync(documentMd, 0o644);
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('un fichier lisible rend son texte', async () => {
    expect(await load(documentMd)).toEqual({ success: true, content: '# Chapitre\n' });
  });

  it('un fichier vide n’est pas un fichier absent', async () => {
    fs.writeFileSync(documentMd, '');
    expect(await load(documentMd)).toEqual({ success: true, content: '' });
  });

  it('un fichier absent du projet : `absent`, seul cas où il peut être créé', async () => {
    const response = await load(path.join(project, 'absent.md'));

    expect(response).toMatchObject({ success: false, code: 'absent' });
    expect(response.error).toBeTruthy();
  });

  it('Latin-1 : refusé, et le fichier ne bouge pas d’un octet', async () => {
    fs.writeFileSync(documentMd, LATIN1);

    const response = await load(documentMd);

    expect(response).toMatchObject({ success: false, code: 'unreadable', reason: 'encoding' });
    expect(response.content).toBeUndefined();
    expect(fs.readFileSync(documentMd).equals(LATIN1)).toBe(true);
  });

  it('Windows-1252 : l’apostrophe courbe 0x92 n’est pas de l’UTF-8 non plus', async () => {
    fs.writeFileSync(documentMd, Buffer.from([0x6c, 0x92, 0x65, 0x61, 0x75, 0x0a]));

    expect(await load(documentMd)).toMatchObject({ code: 'unreadable', reason: 'encoding' });
  });

  it('BOM UTF-8 : le fichier s’ouvre, sans le BOM dans le texte, et revient tel quel sur le disque', async () => {
    const bytes = Buffer.concat([BOM, Buffer.from('# Été\n', 'utf8')]);
    fs.writeFileSync(documentMd, bytes);

    const response = await load(documentMd);

    expect(response).toEqual({ success: true, content: '# Été\n' });

    await call('editor:save-file', documentMd, response.content);
    expect(fs.readFileSync(documentMd).equals(bytes)).toBe(true);
  });

  it('BOM et frappe : toujours un seul BOM en tête après l’écriture', async () => {
    fs.writeFileSync(documentMd, Buffer.concat([BOM, Buffer.from('# Été\n', 'utf8')]));

    const { content } = await load(documentMd);
    await call('editor:save-file', documentMd, `${content}Suite.\n`);
    expect(fs.readFileSync(documentMd).equals(Buffer.concat([BOM, Buffer.from('# Été\nSuite.\n', 'utf8')]))).toBe(true);

    // Et à la lecture suivante, toujours rien dans le texte.
    expect((await load(documentMd)).content).toBe('# Été\nSuite.\n');
  });

  it('BOM déjà dans le texte reçu (une copie lue ailleurs) : il n’est pas doublé', async () => {
    fs.writeFileSync(documentMd, Buffer.concat([BOM, Buffer.from('# Été\n', 'utf8')]));

    await call('editor:save-file', documentMd, '\uFEFF# Été\nSuite.\n');

    expect(fs.readFileSync(documentMd).equals(Buffer.concat([BOM, Buffer.from('# Été\nSuite.\n', 'utf8')]))).toBe(true);
  });

  it('un fichier sans BOM n’en reçoit pas, un fichier neuf non plus', async () => {
    await call('editor:save-file', documentMd, '# Sans\n');
    expect(fs.readFileSync(documentMd).equals(Buffer.from('# Sans\n', 'utf8'))).toBe(true);

    const neuf = path.join(project, 'neuf.md');
    await call('editor:save-file', neuf, '# Neuf\n');
    expect(fs.readFileSync(neuf).equals(Buffer.from('# Neuf\n', 'utf8'))).toBe(true);
  });

  it('un dossier à la place du document : illisible, jamais « absent »', async () => {
    const dir = path.join(project, 'dossier.md');
    fs.mkdirSync(dir);

    expect(await load(dir)).toMatchObject({ success: false, code: 'unreadable', reason: 'not-a-file' });
  });

  it.skipIf(process.getuid?.() === 0)('droits retirés : illisible, jamais « absent »', async () => {
    fs.chmodSync(documentMd, 0o000);

    expect(await load(documentMd)).toMatchObject({ success: false, code: 'unreadable', reason: 'permission' });
  });

  it('hors du projet : refusé, qu’il existe ou non, sans dire lequel des deux', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-dehors-'));
    const secret = path.join(outside, 'secret.md');
    fs.writeFileSync(secret, 'à ne pas lire');
    try {
      const present = await load(secret);
      const missing = await load(path.join(outside, 'absent.md'));

      expect(present).toMatchObject({ success: false, code: 'unreadable', reason: 'refused' });
      expect(present.content).toBeUndefined();
      expect(missing).toMatchObject({ success: false, code: 'unreadable', reason: 'refused' });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('une lecture demandée après une sauvegarde lit ce que cette sauvegarde a écrit', async () => {
    // La validation de la sauvegarde traîne : sans le verrou, la lecture passerait devant.
    h.realpathDelays = [200];

    const saving = call('editor:save-file', documentMd, '# Nouveau texte\n');
    // La sauvegarde a pris le verrou, et son délai : la lecture arrive pendant son attente.
    await vi.waitFor(() => expect(h.realpathDelays).toEqual([]), { interval: 2 });
    const reading = load(documentMd);

    const [, response] = await Promise.all([saving, reading]);
    expect(response.content).toBe('# Nouveau texte\n');
  });
});
