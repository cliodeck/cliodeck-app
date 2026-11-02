/**
 * Le socle d'écriture des fichiers de l'historien, sur un vrai disque.
 *
 * Seuls deux échecs sont simulés, faute de pouvoir les provoquer ici : le
 * `rename` qu'un antivirus refuse sous Windows, et la création du temporaire
 * sur un disque plein. Tout le reste (droits, xattr, liens, casse) passe par
 * le système de fichiers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({
  renameFailures: [] as string[],
  renameCalls: 0,
  lastRenameTarget: null as string | null,
  temporaryOpenFailure: null as string | null,
  cpFails: false,
}));

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulé`), { code });
}

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const mocked = {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      h.renameCalls++;
      h.lastRenameTarget = String(args[1]);
      const code = h.renameFailures.shift();
      if (code) throw errno(code);
      return actual.rename(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (h.temporaryOpenFailure && path.basename(String(args[0])).startsWith('.~')) {
        throw errno(h.temporaryOpenFailure);
      }
      return actual.open(...args);
    },
  };
  return { ...mocked, default: mocked };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      if (!h.cpFails) return (actual.execFile as (...a: unknown[]) => unknown)(...args);
      (args[args.length - 1] as (error: Error) => void)(new Error('cp: échec simulé'));
      return undefined;
    },
  };
});

import {
  atomicWriteFile,
  quarantineFile,
  readUserFile,
  renameWithRetry,
  UnreadableFileError,
  updateFile,
  updateJsonFile,
  withFileLock,
} from '../user-files.js';

const isRoot = process.getuid?.() === 0;
const posixPermissions = process.platform !== 'win32' && !isRoot;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function simulatePlatform(platform: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  return () => Object.defineProperty(process, 'platform', original);
}

let dir: string;
let doc: string;

/** Tout ce qui, dans le dossier, n'est pas ce que l'historien y a mis. */
const temporaries = (folder = dir) => fs.readdirSync(folder).filter((name) => name.includes('.tmp'));

beforeEach(() => {
  h.renameFailures = [];
  h.renameCalls = 0;
  h.temporaryOpenFailure = null;
  h.cpFails = false;
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-user-files-')));
  doc = path.join(dir, 'document.md');
});

afterEach(() => {
  fs.chmodSync(dir, 0o755);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('atomicWriteFile', () => {
  it('écrit les octets tels quels : BOM, CRLF, NFD et NUL ne sont pas touchés', async () => {
    const text = '﻿# Été\r\nNUL\u0000 🎉\n';
    await atomicWriteFile(doc, text);
    expect(fs.readFileSync(doc).equals(Buffer.from(text, 'utf8'))).toBe(true);

    const raw = new Uint8Array([0xff, 0x00, 0xfe, 0x0d, 0x0a]);
    await atomicWriteFile(doc, raw);
    expect(fs.readFileSync(doc).equals(Buffer.from(raw))).toBe(true);
    expect(temporaries()).toEqual([]);
  });

  it('remplace le fichier au lieu de le réécrire : un lecteur ne voit jamais de fichier tronqué', async () => {
    fs.writeFileSync(doc, 'ancien');
    const before = fs.statSync(doc).ino;
    await atomicWriteFile(doc, 'nouveau');
    expect(fs.readFileSync(doc, 'utf8')).toBe('nouveau');
    expect(fs.statSync(doc).ino).not.toBe(before);
  });

  it.skipIf(process.platform === 'win32')('conserve le mode 0640, et un 0666 que le umask aurait rogné', async () => {
    for (const mode of [0o640, 0o666]) {
      fs.writeFileSync(doc, 'ancien');
      fs.chmodSync(doc, mode);
      await atomicWriteFile(doc, 'nouveau');
      expect(fs.statSync(doc).mode & 0o777).toBe(mode);
    }
  });

  it.skipIf(process.platform !== 'darwin')('conserve les xattr, étiquettes Finder comprises', async () => {
    fs.writeFileSync(doc, 'ancien');
    execFileSync('xattr', ['-w', 'com.apple.metadata:_kMDItemUserTags', 'Rouge', doc]);
    execFileSync('xattr', ['-w', 'user.cliodeck', 'bonjour', doc]);

    await atomicWriteFile(doc, 'nouveau');

    const names = execFileSync('xattr', [doc]).toString().trim().split('\n');
    expect(names).toEqual(expect.arrayContaining(['com.apple.metadata:_kMDItemUserTags', 'user.cliodeck']));
    expect(execFileSync('xattr', ['-p', 'user.cliodeck', doc]).toString().trim()).toBe('bonjour');
  });

  it('un cp -p en échec ne fait pas échouer la sauvegarde', async () => {
    fs.writeFileSync(doc, 'ancien');
    h.cpFails = true;

    await atomicWriteFile(doc, 'nouveau');

    expect(fs.readFileSync(doc, 'utf8')).toBe('nouveau');
    expect(temporaries()).toEqual([]);
  });

  it.skipIf(process.platform !== 'darwin')('conserve la date de création, et date la modification de maintenant', async () => {
    fs.writeFileSync(doc, 'ancien');
    const created = new Date('2020-01-02T03:04:05Z');
    const modified = new Date('2024-06-07T08:09:10Z');
    fs.utimesSync(doc, created, created);
    fs.utimesSync(doc, modified, modified);

    const start = Date.now();
    await atomicWriteFile(doc, 'nouveau');

    const stats = fs.statSync(doc);
    expect(stats.birthtime.toISOString()).toBe(created.toISOString());
    expect(stats.mtimeMs).toBeGreaterThanOrEqual(start - 2000);
  });

  it.skipIf(!posixPermissions)('refuse un fichier protégé en écriture, qu’un rename écraserait', async () => {
    fs.writeFileSync(doc, 'protégé');
    fs.chmodSync(doc, 0o444);

    await expect(atomicWriteFile(doc, 'nouveau')).rejects.toMatchObject({ code: 'EACCES' });

    expect(fs.readFileSync(doc, 'utf8')).toBe('protégé');
    expect(temporaries()).toEqual([]);
  });

  it.skipIf(!posixPermissions)('repli en place si le dossier est en lecture seule et le fichier inscriptible', async () => {
    fs.writeFileSync(doc, 'ancien');
    fs.chmodSync(dir, 0o555);

    await atomicWriteFile(doc, 'nouveau');

    fs.chmodSync(dir, 0o755);
    expect(fs.readFileSync(doc, 'utf8')).toBe('nouveau');
    expect(temporaries()).toEqual([]);
  });

  it('jamais de repli en place sur un disque plein : le fichier reste intact', async () => {
    fs.writeFileSync(doc, 'dernière bonne version');
    h.temporaryOpenFailure = 'ENOSPC';

    await expect(atomicWriteFile(doc, 'nouveau')).rejects.toMatchObject({ code: 'ENOSPC' });

    expect(fs.readFileSync(doc, 'utf8')).toBe('dernière bonne version');
    expect(temporaries()).toEqual([]);
  });

  it('un rename en échec laisse l’ancienne version, sans temporaire, et relève l’erreur d’origine', async () => {
    fs.writeFileSync(doc, 'ancien');
    h.renameFailures = ['EIO'];

    await expect(atomicWriteFile(doc, 'nouveau')).rejects.toMatchObject({ code: 'EIO' });

    expect(fs.readFileSync(doc, 'utf8')).toBe('ancien');
    expect(temporaries()).toEqual([]);
  });

  it('un fichier neuf dans un dossier absent échoue sans rien créer', async () => {
    const missing = path.join(dir, 'pas-de-dossier', 'note.md');
    await expect(atomicWriteFile(missing, 'x')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('refuse un dossier', async () => {
    fs.mkdirSync(doc);
    await expect(atomicWriteFile(doc, 'x')).rejects.toThrow();
    expect(fs.statSync(doc).isDirectory()).toBe(true);
    expect(temporaries()).toEqual([]);
  });

  it('un nom très long tient dans la limite du système malgré le préfixe du temporaire', async () => {
    const long = path.join(dir, `${'é'.repeat(120)}.md`);
    await atomicWriteFile(long, 'texte');
    expect(fs.readFileSync(long, 'utf8')).toBe('texte');
  });

  it('un lien symbolique reste un lien, et sa cible reçoit le texte', async () => {
    const realDir = path.join(dir, 'vrai');
    fs.mkdirSync(realDir);
    const real = path.join(realDir, 'chapitre.md');
    fs.writeFileSync(real, 'ancien');
    fs.symlinkSync(real, doc);

    await atomicWriteFile(doc, 'nouveau');

    expect(fs.lstatSync(doc).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('nouveau');
    expect(temporaries()).toEqual([]);
  });

  it('un lien pendant reste un lien, et sa cible est créée', async () => {
    const real = path.join(dir, 'pas-encore.md');
    fs.symlinkSync('pas-encore.md', doc);

    await atomicWriteFile(doc, 'neuf');

    expect(fs.lstatSync(doc).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('neuf');
  });

  it('garde la casse enregistrée sur un disque insensible à la casse', async (ctx) => {
    const onDisk = path.join(dir, 'Chapitre.md');
    fs.writeFileSync(onDisk, 'ancien');
    if (!fs.existsSync(path.join(dir, 'chapitre.md'))) ctx.skip();

    await atomicWriteFile(path.join(dir, 'chapitre.md'), 'nouveau');

    // Le rename vise le nom enregistré : tous les systèmes ne le garderaient pas seuls.
    expect(h.lastRenameTarget).toBe(onDisk);
    expect(fs.readdirSync(dir)).toEqual(['Chapitre.md']);
    expect(fs.readFileSync(onDisk, 'utf8')).toBe('nouveau');
  });

  it('100 écritures simultanées : la dernière demandée gagne, sans temporaire restant', async () => {
    const payload = (i: number) => `${'x'.repeat(1000 - i)}${i}`;
    await Promise.all(Array.from({ length: 100 }, (_, i) => atomicWriteFile(doc, payload(i))));
    expect(fs.readFileSync(doc, 'utf8')).toBe(payload(99));
    expect(temporaries()).toEqual([]);
  });
});

describe('atomicWriteFile hors macOS, sans cp -p', () => {
  // `cp -p` donne au temporaire le mode du fichier, ce qui masque sous macOS les
  // deux précautions dont les autres systèmes dépendent.
  let restorePlatform: () => void = () => undefined;
  beforeEach(() => {
    restorePlatform = simulatePlatform('linux');
  });
  afterEach(() => restorePlatform());

  it.skipIf(process.platform === 'win32')('conserve le mode 0640, et un 0666 que le umask aurait rogné', async () => {
    for (const mode of [0o640, 0o666]) {
      fs.writeFileSync(doc, 'ancien');
      fs.chmodSync(doc, mode);
      await atomicWriteFile(doc, 'nouveau');
      expect(fs.statSync(doc).mode & 0o777).toBe(mode);
    }
  });

  it.skipIf(!posixPermissions)('refuse un fichier protégé en écriture, qu’un rename écraserait', async () => {
    fs.writeFileSync(doc, 'protégé');
    fs.chmodSync(doc, 0o444);

    await expect(atomicWriteFile(doc, 'nouveau')).rejects.toMatchObject({ code: 'EACCES' });

    expect(fs.readFileSync(doc, 'utf8')).toBe('protégé');
    expect(temporaries()).toEqual([]);
  });
});

describe('renameWithRetry', () => {
  let restorePlatform: () => void = () => undefined;
  afterEach(() => restorePlatform());

  it('sous Windows, reprend un rename refusé en EPERM', async () => {
    restorePlatform = simulatePlatform('win32');
    fs.writeFileSync(doc, 'ancien');
    h.renameFailures = ['EPERM', 'EBUSY', 'EACCES'];

    await atomicWriteFile(doc, 'nouveau');

    expect(h.renameCalls).toBe(4);
    expect(fs.readFileSync(doc, 'utf8')).toBe('nouveau');
    expect(temporaries()).toEqual([]);
  });

  it('sous Windows, abandonne après ses reprises : ancienne version intacte, sans temporaire', async () => {
    restorePlatform = simulatePlatform('win32');
    fs.writeFileSync(doc, 'ancien');
    h.renameFailures = Array.from({ length: 20 }, () => 'EPERM');

    await expect(atomicWriteFile(doc, 'nouveau')).rejects.toMatchObject({ code: 'EPERM' });

    expect(h.renameCalls).toBe(6);
    expect(fs.readFileSync(doc, 'utf8')).toBe('ancien');
    expect(temporaries()).toEqual([]);
  });

  it('ne reprend pas ce qu’une reprise ne guérit pas', async () => {
    restorePlatform = simulatePlatform('win32');
    h.renameFailures = ['ENOENT'];
    await expect(renameWithRetry(path.join(dir, 'a'), path.join(dir, 'b'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(h.renameCalls).toBe(1);
  });

  it('hors Windows, un EPERM est une vraie erreur et ne se reprend pas', async () => {
    restorePlatform = simulatePlatform('linux');
    h.renameFailures = ['EPERM'];
    await expect(renameWithRetry(path.join(dir, 'a'), path.join(dir, 'b'))).rejects.toMatchObject({ code: 'EPERM' });
    expect(h.renameCalls).toBe(1);
  });
});

describe('withFileLock', () => {
  it('sert 100 appels dans l’ordre, un seul à la fois', async () => {
    const order: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        withFileLock(doc, async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await sleep(i % 5 === 0 ? 2 : 0);
          order.push(i);
          inFlight--;
        })
      )
    );
    expect(maxInFlight).toBe(1);
    expect(order).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it('un appel qui échoue rend son erreur et ne bloque pas les suivants', async () => {
    const first = withFileLock(doc, async () => {
      throw new Error('raté');
    });
    const second = withFileLock(doc, async () => 'servi');
    await expect(first).rejects.toThrow('raté');
    await expect(second).resolves.toBe('servi');
  });

  it('un fichier et son lien symbolique attendent dans la même file', async () => {
    fs.writeFileSync(doc, 'x');
    const link = path.join(dir, 'lien.md');
    fs.symlinkSync(doc, link);
    let inFlight = 0;
    let maxInFlight = 0;
    const task = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(5);
      inFlight--;
    };
    await Promise.all([withFileLock(doc, task), withFileLock(link, task)]);
    expect(maxInFlight).toBe(1);
  });

  it('un fichier encore absent garde sa file une fois créé, même par un dossier lien', async () => {
    const realDir = path.join(dir, 'vrai');
    fs.mkdirSync(realDir);
    const aliasDir = path.join(dir, 'alias');
    fs.symlinkSync(realDir, aliasDir);
    let inFlight = 0;
    let maxInFlight = 0;
    const task = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(5);
      inFlight--;
    };
    await Promise.all([
      withFileLock(path.join(aliasDir, 'neuf.md'), task),
      withFileLock(path.join(realDir, 'neuf.md'), task),
    ]);
    expect(maxInFlight).toBe(1);
  });

  it('écrire le fichier verrouillé depuis le verrou ne s’attend pas soi-même', async () => {
    const written = withFileLock(doc, async () => {
      await atomicWriteFile(doc, 'depuis le verrou');
      return fs.readFileSync(doc, 'utf8');
    });
    await expect(Promise.race([written, sleep(2000).then(() => 'bloqué')])).resolves.toBe('depuis le verrou');
  });

  it('le verrou tenu pour un fichier ne retient pas les autres fichiers', async () => {
    const other = path.join(dir, 'autre.md');
    const outcome = withFileLock(doc, async () => {
      await atomicWriteFile(other, 'autre');
      return 'fini';
    });
    await expect(Promise.race([outcome, sleep(2000).then(() => 'bloqué')])).resolves.toBe('fini');
  });
});

describe('updateFile', () => {
  it('20 mises à jour concurrentes : aucune ne se perd', async () => {
    fs.writeFileSync(doc, '');
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        updateFile(doc, async (current) => {
          await sleep(1);
          return `${current ?? ''}${i}\n`;
        })
      )
    );
    const lines = fs.readFileSync(doc, 'utf8').trim().split('\n').map(Number);
    expect(lines).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('passe null pour un fichier absent, et le crée', async () => {
    const seen: Array<string | null> = [];
    const result = await updateFile(doc, (current) => {
      seen.push(current);
      return 'créé';
    });
    expect(seen).toEqual([null]);
    expect(result).toEqual({ written: true, content: 'créé' });
    expect(fs.readFileSync(doc, 'utf8')).toBe('créé');
  });

  it('un retour null n’écrit rien', async () => {
    fs.writeFileSync(doc, 'intact');
    const inode = fs.statSync(doc).ino;
    const result = await updateFile(doc, () => null);
    expect(result).toEqual({ written: false, content: 'intact' });
    expect(fs.statSync(doc).ino).toBe(inode);
  });

  it('un fichier illisible lève UnreadableFileError sans appeler le mutator', async () => {
    fs.writeFileSync(doc, Buffer.from([0x45, 0x74, 0xe9]));
    const mutator = vi.fn(() => 'écrasé');

    const failure = await updateFile(doc, mutator).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UnreadableFileError);
    expect(failure).toMatchObject({ code: 'file_unreadable', filePath: doc, reason: 'encoding' });
    expect(mutator).not.toHaveBeenCalled();
    expect(fs.readFileSync(doc).equals(Buffer.from([0x45, 0x74, 0xe9]))).toBe(true);
  });

  it('un mutator qui lève n’écrit rien, et son erreur remonte', async () => {
    fs.writeFileSync(doc, 'intact');
    await expect(
      updateFile(doc, () => {
        throw new Error('conflit');
      })
    ).rejects.toThrow('conflit');
    expect(fs.readFileSync(doc, 'utf8')).toBe('intact');
  });

  it('un mutator peut écrire le fichier qu’il met à jour sans se bloquer', async () => {
    const updated = updateFile(doc, async () => {
      await atomicWriteFile(doc, 'intermédiaire');
      return 'final';
    });
    await expect(Promise.race([updated, sleep(2000).then(() => 'bloqué')])).resolves.toMatchObject({
      written: true,
    });
    expect(fs.readFileSync(doc, 'utf8')).toBe('final');
  });
});

describe('updateJsonFile', () => {
  const jsonFile = () => path.join(dir, 'config.json');

  it('JSON invalide : UnreadableFileError « invalid-json », mutator non appelé, fichier intact', async () => {
    fs.writeFileSync(jsonFile(), '{ "a": 1, }');
    const mutator = vi.fn(() => ({ a: 2 }));

    const failure = await updateJsonFile(jsonFile(), mutator).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UnreadableFileError);
    expect(failure).toMatchObject({ reason: 'invalid-json' });
    expect(mutator).not.toHaveBeenCalled();
    expect(fs.readFileSync(jsonFile(), 'utf8')).toBe('{ "a": 1, }');
  });

  it('un fichier vide n’est pas absent : c’est un JSON invalide', async () => {
    fs.writeFileSync(jsonFile(), '');
    await expect(updateJsonFile(jsonFile(), () => ({}))).rejects.toMatchObject({ reason: 'invalid-json' });
  });

  it('indentation 2 sans saut final par défaut, et rend la valeur', async () => {
    const result = await updateJsonFile<{ a: number }>(jsonFile(), (current) => {
      expect(current).toBeNull();
      return { a: 1 };
    });
    expect(result).toEqual({ written: true, value: { a: 1 } });
    expect(fs.readFileSync(jsonFile(), 'utf8')).toBe('{\n  "a": 1\n}');
  });

  it('respecte indent et trailingNewline', async () => {
    await updateJsonFile(jsonFile(), () => ({ a: 1 }), { indent: 4, trailingNewline: true });
    expect(fs.readFileSync(jsonFile(), 'utf8')).toBe('{\n    "a": 1\n}\n');
  });

  it('un retour null n’écrit rien et rend la valeur lue', async () => {
    fs.writeFileSync(jsonFile(), '{"a":1}');
    const result = await updateJsonFile<{ a: number }>(jsonFile(), () => null);
    expect(result).toEqual({ written: false, value: { a: 1 } });
    expect(fs.readFileSync(jsonFile(), 'utf8')).toBe('{"a":1}');
  });

  it('20 mises à jour concurrentes : aucune ne se perd', async () => {
    fs.writeFileSync(jsonFile(), '{"items":[]}');
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        updateJsonFile<{ items: number[] }>(jsonFile(), async (current) => {
          await sleep(1);
          return { items: [...(current?.items ?? []), i] };
        })
      )
    );
    expect(JSON.parse(fs.readFileSync(jsonFile(), 'utf8')).items).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
});

describe('readUserFile', () => {
  it('rend absent pour un fichier qui n’existe pas', async () => {
    expect(await readUserFile(doc)).toEqual({ kind: 'absent' });
  });

  it('rend absent quand un élément du chemin est un fichier (ENOTDIR)', async () => {
    fs.writeFileSync(doc, 'x');
    expect(await readUserFile(path.join(doc, 'sous-fichier.md'))).toEqual({ kind: 'absent' });
  });

  it('rend absent pour un lien pendant', async () => {
    fs.symlinkSync('pas-encore.md', doc);
    expect(await readUserFile(doc)).toEqual({ kind: 'absent' });
  });

  it('rend le contenu, BOM compris : l’aller-retour est fidèle', async () => {
    const text = '﻿# Été\r\nÀ suivre\n';
    fs.writeFileSync(doc, text);
    const read = await readUserFile(doc);
    expect(read).toEqual({ kind: 'ok', content: text });
  });

  it('rend unreadable/not-a-file pour un dossier', async () => {
    fs.mkdirSync(doc);
    expect(await readUserFile(doc)).toMatchObject({ kind: 'unreadable', reason: 'not-a-file' });
  });

  it('rend unreadable/encoding pour du Latin-1, au lieu de U+FFFD irréversibles', async () => {
    fs.writeFileSync(doc, Buffer.from([0x45, 0x74, 0xe9]));
    expect(await readUserFile(doc)).toMatchObject({ kind: 'unreadable', reason: 'encoding' });
    expect(await readUserFile(doc, { lossyUtf8: true })).toEqual({ kind: 'ok', content: 'Et�' });
  });

  it.skipIf(!posixPermissions)('rend unreadable/permission pour un fichier interdit de lecture', async () => {
    fs.writeFileSync(doc, 'secret');
    fs.chmodSync(doc, 0o000);
    expect(await readUserFile(doc)).toMatchObject({ kind: 'unreadable', reason: 'permission' });
    fs.chmodSync(doc, 0o644);
  });
});

describe('quarantineFile', () => {
  it('renomme en <nom>.illisible-<horodatage> dans le même dossier et rend le chemin', async () => {
    fs.writeFileSync(doc, 'abîmé');
    const backup = await quarantineFile(doc);

    expect(path.dirname(backup)).toBe(dir);
    expect(path.basename(backup)).toMatch(/^document\.md\.illisible-\d{4}-\d{2}-\d{2}T[\d-]+Z(-\d+)?$/);
    expect(fs.readFileSync(backup, 'utf8')).toBe('abîmé');
    expect(fs.existsSync(doc)).toBe(false);
  });

  it('n’écrase jamais une mise de côté précédente, même à la même milliseconde', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-02T10:00:00.000Z') });
    try {
      fs.writeFileSync(doc, 'premier');
      const first = await quarantineFile(doc);
      fs.writeFileSync(doc, 'second');
      const second = await quarantineFile(doc);

      expect(second).not.toBe(first);
      expect(fs.readFileSync(first, 'utf8')).toBe('premier');
      expect(fs.readFileSync(second, 'utf8')).toBe('second');
    } finally {
      vi.useRealTimers();
    }
  });

  it('lève ENOENT si le fichier n’existe pas', async () => {
    await expect(quarantineFile(doc)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('un lien symbolique : le fichier réel est mis de côté, à côté de lui', async () => {
    const realDir = path.join(dir, 'vrai');
    fs.mkdirSync(realDir);
    const real = path.join(realDir, 'ideas.json');
    fs.writeFileSync(real, '{ abîmé');
    fs.symlinkSync(real, doc);

    const backup = await quarantineFile(doc);

    expect(path.dirname(backup)).toBe(realDir);
    expect(fs.readFileSync(backup, 'utf8')).toBe('{ abîmé');
    expect(fs.lstatSync(doc).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(real)).toBe(false);
  });
});
