/**
 * La sauvegarde ne détruit plus la dernière bonne version (S12-1-19).
 *
 * `editor:save-file` ouvrait le document en O_TRUNC : un disque plein laissait
 * un fichier vide (mesuré sur une image disque pleine : 131 072 octets → 0), et
 * chaque nouvel essai de l'autosave recommençait. Ces tests appellent les vrais
 * handlers sur un vrai dossier ; seul le disque plein est simulé, au plus près
 * de ce que fait le système : `writeFile` de `fs/promises` tronque puis lève,
 * `FileHandle.writeFile` écrit une moitié puis lève.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  projectPath: '' as string,
  diskFull: false,
}));

function enospc(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
}

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const mocked = {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (!h.diskFull) return actual.writeFile(...args);
      // O_TRUNC d'abord, l'échec ensuite : c'est l'ordre du système.
      await actual.writeFile(args[0], '');
      throw enospc();
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (h.diskFull) {
        const writeFile = handle.writeFile.bind(handle);
        handle.writeFile = async (data: Parameters<typeof writeFile>[0]) => {
          await writeFile(Buffer.from(data as Uint8Array).subarray(0, 8));
          throw enospc();
        };
      }
      return handle;
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
  dialog: {},
  shell: {},
  BrowserWindow: { fromWebContents: () => null },
  app: { isPackaged: false, getPath: () => '/tmp', getAppPath: () => '/nulle-part' },
}));

vi.mock('../../../services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => h.projectPath },
}));
vi.mock('../../../services/config-manager.js', () => ({
  configManager: { get: () => undefined, set: () => undefined },
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
import { setupFilesystemHandlers } from '../filesystem-handlers.js';

function call<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`canal non enregistré : ${channel}`);
  return handler({}, ...args) as Promise<T>;
}

function ideas(count: number): string {
  return JSON.stringify(
    { ideas: Array.from({ length: count }, (_, i) => ({ id: i, text: `Idée numéro ${i}` })) },
    null,
    2
  );
}

describe('sauvegarde par fichier temporaire et rename', () => {
  let project: string;
  let documentMd: string;

  beforeEach(() => {
    setupEditorHandlers();
    setupFilesystemHandlers();
    project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-save-')));
    h.projectPath = project;
    h.diskFull = false;
    documentMd = path.join(project, 'document.md');
    fs.writeFileSync(documentMd, '# Chapitre\n\nTexte déjà écrit.\n');
  });

  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('disque plein : document.md garde son texte, et la réponse le dit', async () => {
    h.diskFull = true;
    const response = await call<{ success: boolean; error?: string }>(
      'editor:save-file',
      documentMd,
      '# Chapitre\n\nTexte déjà écrit, et une suite.\n'
    );

    expect(response.success).toBe(false);
    expect(response.error).toContain('ENOSPC');
    expect(fs.readFileSync(documentMd, 'utf8')).toBe('# Chapitre\n\nTexte déjà écrit.\n');
    expect(fs.readdirSync(project)).toEqual(['document.md']);
  });

  it('disque plein : chaque nouvel essai de l’autosave laisse le fichier intact', async () => {
    h.diskFull = true;
    for (let i = 0; i < 3; i++) {
      await call('editor:save-file', documentMd, `essai ${i}`);
    }
    h.diskFull = false;
    expect(fs.readFileSync(documentMd, 'utf8')).toBe('# Chapitre\n\nTexte déjà écrit.\n');

    // La place est revenue : le texte de l'éditeur part enfin.
    const response = await call<{ success: boolean }>('editor:save-file', documentMd, 'la suite');
    expect(response.success).toBe(true);
    expect(fs.readFileSync(documentMd, 'utf8')).toBe('la suite');
  });

  it('un document.md lien symbolique reste un lien, et sa cible porte le nouveau texte', async () => {
    const realDir = path.join(project, 'vrai');
    fs.mkdirSync(realDir);
    const realFile = path.join(realDir, 'chapitre.md');
    fs.writeFileSync(realFile, 'ancien');
    fs.rmSync(documentMd);
    fs.symlinkSync(realFile, documentMd);

    const response = await call<{ success: boolean }>('editor:save-file', documentMd, 'nouveau');

    expect(response.success).toBe(true);
    expect(fs.lstatSync(documentMd).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(realFile, 'utf8')).toBe('nouveau');
  });

  it('« Enregistrer sous » crée le fichier qui n’existait pas', async () => {
    const target = path.join(project, 'copie.md');
    const response = await call<{ success: boolean }>('editor:save-file', target, 'texte');

    expect(response.success).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('texte');
    expect(fs.readdirSync(project).sort()).toEqual(['copie.md', 'document.md']);
  });

  it('50 paires de fs:write-file concurrentes (30 et 29 idées) : le fichier reste un JSON valide', async () => {
    const ideasJson = path.join(project, 'ideas.json');
    const long = ideas(30);
    const short = ideas(29);
    fs.writeFileSync(ideasJson, long);

    let corrupted = 0;
    for (let pair = 0; pair < 50; pair++) {
      await Promise.all([
        call('fs:write-file', ideasJson, long),
        call('fs:write-file', ideasJson, short),
      ]);
      const content = fs.readFileSync(ideasJson, 'utf8');
      try {
        JSON.parse(content);
        expect([long, short]).toContain(content);
      } catch {
        corrupted++;
      }
    }

    expect(corrupted).toBe(0);
    expect(fs.readdirSync(project).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('fs:write-file exclusif crée le fichier absent et refuse celui qui existe', async () => {
    const seed = path.join(project, 'nouveau.md');
    await call('fs:write-file', seed, '# Nom\n', { exclusive: true });
    expect(fs.readFileSync(seed, 'utf8')).toBe('# Nom\n');

    await expect(call('fs:write-file', documentMd, '# Nom\n', { exclusive: true })).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(fs.readFileSync(documentMd, 'utf8')).toBe('# Chapitre\n\nTexte déjà écrit.\n');
  });

  it('fs:write-file refuse une option mal formée plutôt que d’écraser sans le dire', async () => {
    await expect(call('fs:write-file', documentMd, 'x', { exclusive: 'oui' })).rejects.toThrow();
    expect(fs.readFileSync(documentMd, 'utf8')).toBe('# Chapitre\n\nTexte déjà écrit.\n');
  });

  it('fs:read-user-file distingue absent, lisible et illisible', async () => {
    expect(await call('fs:read-user-file', path.join(project, 'absent.md'))).toEqual({ kind: 'absent' });
    expect(await call('fs:read-user-file', documentMd)).toEqual({
      kind: 'ok',
      content: '# Chapitre\n\nTexte déjà écrit.\n',
    });

    const latin1 = path.join(project, 'latin1.md');
    fs.writeFileSync(latin1, Buffer.from([0x45, 0x74, 0xe9]));
    expect(await call('fs:read-user-file', latin1)).toMatchObject({ kind: 'unreadable', reason: 'encoding' });
  });

  it('fs:read-user-file rend « refused » hors du projet, sans lever', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-dehors-'));
    const secret = path.join(outside, 'secret.md');
    fs.writeFileSync(secret, 'à ne pas lire');
    try {
      const read = await call<{ kind: string; reason?: string; content?: string }>('fs:read-user-file', secret);
      expect(read).toMatchObject({ kind: 'unreadable', reason: 'refused' });
      expect(read.content).toBeUndefined();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('fs:quarantine-file met le fichier de côté dans le même dossier', async () => {
    const ideasJson = path.join(project, 'ideas.json');
    fs.writeFileSync(ideasJson, '{ tronqué');

    const response = await call<{ success: boolean; backupPath: string }>('fs:quarantine-file', ideasJson);

    expect(response.success).toBe(true);
    expect(path.dirname(response.backupPath)).toBe(project);
    expect(path.basename(response.backupPath)).toMatch(/^ideas\.json\.illisible-/);
    expect(fs.readFileSync(response.backupPath, 'utf8')).toBe('{ tronqué');
    expect(fs.existsSync(ideasJson)).toBe(false);
  });

  it('fs:quarantine-file refuse un chemin hors du projet', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-dehors-'));
    const victim = path.join(outside, 'garde.md');
    fs.writeFileSync(victim, 'garde');
    try {
      const response = await call<{ success: boolean }>('fs:quarantine-file', victim);
      expect(response.success).toBe(false);
      expect(fs.readFileSync(victim, 'utf8')).toBe('garde');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
