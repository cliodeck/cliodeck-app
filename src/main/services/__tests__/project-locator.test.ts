/**
 * Où sont les projets que nomment les brouillons (J12).
 *
 * Un brouillon porte le chemin de son projet. Dossier déplacé, renommé ou supprimé : ses brouillons
 * n'apparaissaient plus nulle part. Le panneau des brouillons demande donc au main, pour chaque
 * chemin, si `project.json` y est encore, et la clé de fichier du dossier (`sameFileKey`) : un
 * dossier renommé par la seule casse, sous macOS, garde `project.json` à l'ancien chemin, et la
 * comparaison des chaînes cachait aussi ses brouillons dans le projet rouvert.
 *
 * Ces dossiers sont ceux de projets que l'app ne connaît plus, parfois sur un volume qui ne répond
 * plus : lecture seule, jamais synchrone, chaque chemin sous un délai. Un vrai disque, sauf pour
 * le délai et les erreurs, qu'un disque simulé provoque.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { symlinkAvailable } from '../../../../backend/__tests__/helpers/native-guards';
import { createProjectLocator, volumeOf, type LocateDisk } from '../project-locator';

let root: string;

beforeEach(() => {
  // Le dossier réel : sous macOS, le dossier temporaire passe par un lien (`/var` → `/private/var`).
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cliodeck-locate-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Sur le vrai disque, un délai large : la CI est plus lente que le Mac, et ces tests vérifient ce que
 * dit le disque, pas le délai (que le disque simulé, plus bas, éprouve).
 */
const locator = () => createProjectLocator({ timeoutMs: 30_000 });

/** Un dossier de projet, avec son `project.json`. */
function project(name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ name, type: 'article' }));
  return dir;
}

/** Le disque sous la casse : un seul fichier, sous les deux noms (macOS, Windows). */
const caseInsensitive = ((): boolean => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cliodeck-casse-'));
  writeFileSync(path.join(dir, 'sonde'), '');
  const insensitive = existsSync(path.join(dir, 'SONDE'));
  rmSync(dir, { recursive: true });
  return insensitive;
})();

describe('project-locator : présent, absent', () => {
  it('un projet à son chemin est présent, avec sa clé ; un dossier renommé laisse l’ancien chemin absent', async () => {
    const before = project('These');
    const after = path.join(root, 'These-2026');
    renameSync(before, after);

    const places = await locator().locate([before, after]);

    expect(places).toEqual([
      { path: before, state: 'absent' },
      { path: after, state: 'present', key: after },
    ]);
  });

  it('un dossier sans project.json, ou un project.json qui n’est pas un fichier, est absent', async () => {
    const empty = path.join(root, 'vide');
    mkdirSync(empty);
    const odd = path.join(root, 'bizarre');
    mkdirSync(path.join(odd, 'project.json'), { recursive: true });

    const places = await locator().locate([empty, odd]);

    expect(places.map((p) => p.state)).toEqual(['absent', 'absent']);
  });

  it('rien n’est créé ni écrit, même au chemin d’un projet disparu', async () => {
    const gone = path.join(root, 'disparu', 'These');
    const listing = readdirSync(root);

    await locator().locate([gone, path.join(gone, 'project.json')]);

    expect(readdirSync(root)).toEqual(listing);
    expect(existsSync(path.join(root, 'disparu'))).toBe(false);
  });

  it('un chemin relatif, ou qui contient un caractère nul, n’est ni présent ni absent', async () => {
    const places = await locator().locate(['projets/These', `${root}/a\0b`]);

    expect(places.map((p) => p.state)).toEqual(['unknown', 'unknown']);
  });

  it('un même chemin demandé deux fois ne se lit qu’une fois, et ne se rend qu’une fois', async () => {
    const dir = project('These');

    const places = await locator().locate([dir, dir]);

    expect(places).toEqual([{ path: dir, state: 'present', key: dir }]);
  });
});

describe('project-locator : même dossier, autre chemin', () => {
  it.runIf(symlinkAvailable)('un lien vers le dossier : présent, avec la clé du dossier réel', async () => {
    const real = project('These');
    const link = path.join(root, 'lien-vers-These');
    symlinkSync(real, link);

    const [viaLink, direct] = await locator().locate([link, real]);

    expect(viaLink).toEqual({ path: link, state: 'present', key: real });
    expect(direct).toEqual({ path: real, state: 'present', key: real });
  });

  it.runIf(caseInsensitive)('un dossier renommé par la seule casse : l’ancien chemin a la clé du nouveau', async () => {
    const before = project('Thèse');
    const after = path.join(root, 'thèse');
    renameSync(before, after);

    const [old, current] = await locator().locate([before, after]);

    // `project.json` répond encore à l'ancien chemin : présent, pas absent. La clé seule dit que
    // c'est le projet ouvert.
    expect(old.state).toBe('present');
    expect(current.state).toBe('present');
    expect(old.state === 'present' && current.state === 'present' && old.key === current.key).toBe(true);
  });
});

describe('project-locator : un volume qui ne répond pas', () => {
  /** Un disque dont certains chemins ne répondent jamais, et qui compte ses lectures. */
  function stuckDisk(stuck: (p: string) => boolean): LocateDisk & { reads: string[] } {
    const reads: string[] = [];
    return {
      reads,
      stat: (filePath) => {
        reads.push(filePath);
        if (stuck(filePath)) return new Promise(() => undefined);
        return Promise.resolve({ isFile: () => true });
      },
      key: async (dirPath) => dirPath,
    };
  }

  it('un chemin qui ne répond pas dans le délai n’est ni présent ni absent ; les autres répondent', async () => {
    const disk = stuckDisk((p) => p.startsWith('/Volumes/Disque'));

    const places = await createProjectLocator({ disk, timeoutMs: 20 }).locate(['/Volumes/Disque/These', '/Users/a/Memoire']);

    expect(places).toEqual([
      { path: '/Volumes/Disque/These', state: 'unknown' },
      { path: '/Users/a/Memoire', state: 'present', key: '/Users/a/Memoire' },
    ]);
  });

  it('une lecture encore en attente n’est pas relancée : un volume mort ne retient qu’une lecture par dossier', async () => {
    const disk = stuckDisk(() => true);
    const locator = createProjectLocator({ disk, timeoutMs: 20 });

    await locator.locate(['/Volumes/Disque/These']);
    await locator.locate(['/Volumes/Disque/These']);

    expect(disk.reads).toEqual(['/Volumes/Disque/These/project.json']);
  });

  /**
   * Un disque dont les lectures bloquées se libèrent à la demande (`release`), et qui compte celles
   * qui sont en vol : chacune retient un fil du pool de libuv, qui n'en a que quatre.
   */
  function heldDisk(stuck: (p: string) => boolean): LocateDisk & {
    reads: string[];
    maxInFlight: () => number;
    release: () => void;
  } {
    const reads: string[] = [];
    const held: Array<() => void> = [];
    let inFlight = 0;
    let max = 0;
    return {
      reads,
      maxInFlight: () => max,
      release: () => held.splice(0).forEach((free) => free()),
      stat: (filePath) => {
        reads.push(filePath);
        if (!stuck(filePath)) return Promise.resolve({ isFile: () => true });
        inFlight += 1;
        max = Math.max(max, inFlight);
        return new Promise((resolve) =>
          held.push(() => {
            inFlight -= 1;
            resolve({ isFile: () => true });
          })
        );
      },
      key: async (dirPath) => dirPath,
    };
  }

  /** Laisse finir ce que `release` a débloqué. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('cinq volumes qui ne répondent pas : au plus deux lectures en vol, toutes demandes confondues, jusqu’à leur vraie fin', async () => {
    let frozen = true;
    const disk = heldDisk((p) => frozen && p.startsWith('/Volumes/'));
    const locator = createProjectLocator({ disk, timeoutMs: 20 });
    const nas = (i: number) => `/Volumes/NAS${i}/These`;

    const first = await locator.locate([1, 2, 3, 4, 5].map(nas));
    // Une lecture restée au-delà de son délai garde sa place : la demande suivante n'en lance pas d'autre.
    const second = await locator.locate([6, 7].map(nas));

    expect([...first, ...second].map((p) => p.state)).toEqual(Array(7).fill('unknown'));
    expect(disk.maxInFlight()).toBe(2);
    expect(disk.reads).toEqual([nas(1), nas(2)].map((d) => `${d}/project.json`));

    // Les volumes reviennent : les lectures qui attendaient leur place et ont passé leur délai ne
    // partent jamais ; une demande nouvelle lit.
    frozen = false;
    disk.release();
    await settle();
    expect(await locator.locate([nas(6)])).toEqual([{ path: nas(6), state: 'present', key: nas(6) }]);
    expect(disk.reads).toEqual([nas(1), nas(2), nas(6)].map((d) => `${d}/project.json`));
  });

  it('quatre dossiers d’un même volume figé n’en retiennent qu’une lecture ; un projet local répond', async () => {
    const disk = heldDisk((p) => p.startsWith('/Volumes/NAS/'));
    const theses = [1, 2, 3, 4].map((i) => `/Volumes/NAS/These${i}`);

    const places = await createProjectLocator({ disk, timeoutMs: 20 }).locate([...theses, '/Users/a/Memoire']);

    expect(places).toEqual([
      ...theses.map((dir) => ({ path: dir, state: 'unknown' })),
      { path: '/Users/a/Memoire', state: 'present', key: '/Users/a/Memoire' },
    ]);
    expect(disk.reads.filter((p) => p.startsWith('/Volumes/NAS/'))).toEqual(['/Volumes/NAS/These1/project.json']);
    disk.release();
  });

  it('une erreur autre que « absent » (droits, entrée-sortie) n’est ni présent ni absent', async () => {
    const disk: LocateDisk = {
      stat: async (filePath) => {
        throw Object.assign(new Error(`EACCES: ${filePath}`), { code: filePath.includes('Prive') ? 'EACCES' : 'EIO' });
      },
      key: async (dirPath) => dirPath,
    };

    const places = await createProjectLocator({ disk }).locate(['/Users/a/Prive', '/Volumes/Abime']);

    expect(places.map((p) => p.state)).toEqual(['unknown', 'unknown']);
  });
});

describe('project-locator : le volume d’un chemin', () => {
  it('macOS et Linux : un disque monté a son volume ; le reste est sur la racine', () => {
    expect(volumeOf('/Volumes/NAS/Theses/These', path.posix)).toBe('/Volumes/NAS');
    expect(volumeOf('/mnt/nas/These', path.posix)).toBe('/mnt/nas');
    expect(volumeOf('/media/fred/Cle/These', path.posix)).toBe('/media/fred');
    expect(volumeOf('/run/media/fred/Cle/These', path.posix)).toBe('/run/media/fred');
    expect(volumeOf('/Users/fred/These', path.posix)).toBe('/');
    expect(volumeOf('/Volumes', path.posix)).toBe('/');
  });

  it('Windows : le lecteur, ou le partage réseau, sans égard à la casse', () => {
    expect(volumeOf('C:\\Users\\fred\\These', path.win32)).toBe('c:\\');
    expect(volumeOf('c:\\Users\\fred\\Memoire', path.win32)).toBe('c:\\');
    expect(volumeOf('\\\\Serveur\\Partage\\These', path.win32)).toBe('\\\\serveur\\partage\\');
  });
});
