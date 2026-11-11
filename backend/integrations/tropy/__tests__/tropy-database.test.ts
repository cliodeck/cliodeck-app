/**
 * Ouverture d'un .tpy sans rien laisser à côté (G2) : où chercher le journal
 * de Tropy pour choisir entre une copie en mémoire et la base elle-même.
 *
 * Revue de G2 : la règle cherchait `-wal` et `-shm` à côté du chemin reçu et
 * exigeait les deux. Deux cas lisaient alors une copie périmée, sans ce que
 * Tropy n'avait pas encore reporté dans la base : un .tpy atteint par un lien
 * symbolique (SQLite range le journal à côté de la cible, pas du lien), et un
 * `-wal` resté sans `-shm`. La synchro ne voyait pas les items du journal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sqliteAvailable } from '../../../__tests__/helpers/native-guards';
import { makeTpy, openTpyForWrite, tpyDatabasePath } from './helpers/make-tpy';
import { openTropyDatabase } from '../tropy-database';

/**
 * Garde contre la copie en mémoire d'une base agrandie : elle remplirait 4 Gio,
 * l'image lue puis la copie que better-sqlite3 en fait dans SQLite. Quand
 * `forbidden` est posé, lire d'un coup un fichier de plus de 1 Mio lève tout de
 * suite, sans rien allouer. Le reste du temps, `readFileSync` est le vrai.
 */
const largeReads = vi.hoisted(() => ({ forbidden: false }));

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const readFileSync = (
    file: Parameters<typeof real.readFileSync>[0],
    options?: Parameters<typeof real.readFileSync>[1],
  ) => {
    if (largeReads.forbidden && typeof file === 'string' && real.statSync(file).size > 2 ** 20) {
      throw new Error(`copie en mémoire de ${file} (${real.statSync(file).size} octets)`);
    }
    return real.readFileSync(file, options);
  };
  return { ...real, readFileSync };
});

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-tropy-db-'));
});

afterEach(() => {
  largeReads.forbidden = false;
  fs.rmSync(root, { recursive: true, force: true });
});

function listing(dir: string): string[] {
  return fs.readdirSync(dir).sort();
}

function digest(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Premiers octets d'un fichier, sans lire le reste (une base de 2 Gio). */
function head(file: string, length = 100): Buffer {
  const bytes = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, bytes, 0, length, 0);
  } finally {
    fs.closeSync(fd);
  }
  return bytes;
}

/**
 * Agrandit un fichier sans écrire : la fin est un trou, que le disque ne
 * porte pas (APFS, ext4). Une base SQLite agrandie ainsi se lit encore : sa
 * taille utile est dans son en-tête.
 */
function growSparse(file: string, size: number): void {
  fs.truncateSync(file, size);
}

/** Nom du projet, lu par `openTropyDatabase`. */
function projectName(dbPath: string): string {
  const db = openTropyDatabase(dbPath);
  try {
    return (db.prepare('SELECT name FROM project').get() as { name: string }).name;
  } finally {
    db.close();
  }
}

/** Tropy ouvert : un renommage encore dans le journal. À fermer par l'appelant. */
function tropyHoldingRename(projectPath: string, name: string): Database.Database {
  const tropy = openTpyForWrite(projectPath);
  tropy.pragma('journal_mode = WAL');
  tropy.pragma('wal_autocheckpoint = 0');
  tropy.prepare('UPDATE project SET name = ?').run(name);
  return tropy;
}

describe.skipIf(!sqliteAvailable)('openTropyDatabase', () => {
  it('un .tpy atteint par un lien symbolique, Tropy ouvert sur la cible : lit le journal, rien de créé', () => {
    const archives = path.join(root, 'archives');
    const tpy = makeTpy(archives, { projectId: 'projet-A', name: 'Grèves nantaises', wal: true, items: [] });
    const shortcuts = path.join(root, 'raccourcis');
    fs.mkdirSync(shortcuts);
    const link = path.join(shortcuts, 'greves.tpy');
    fs.symlinkSync(tpy, link);

    const tropy = tropyHoldingRename(tpy, 'Grèves de 1907');
    try {
      const before = { archives: listing(archives), shortcuts: listing(shortcuts) };
      expect(projectName(link)).toBe('Grèves de 1907');
      expect({ archives: listing(archives), shortcuts: listing(shortcuts) }).toEqual(before);
    } finally {
      tropy.close();
    }
  });

  // Témoin : le lien porte sur le dossier du paquet, le journal se trouve donc
  // en suivant le lien, avant comme après la revue.
  it('un paquet .tropy atteint par un lien symbolique, Tropy ouvert sur la cible : lit le journal (témoin)', () => {
    const pkg = makeTpy(path.join(root, 'archives'), {
      projectId: 'projet-paquet',
      name: 'Paquet',
      packaged: true,
      wal: true,
      items: [],
    });
    const link = path.join(root, 'Paquet-raccourci.tropy');
    fs.symlinkSync(pkg, link);

    const tropy = tropyHoldingRename(pkg, 'Paquet renommé');
    try {
      const before = listing(pkg);
      expect(projectName(tpyDatabasePath(link))).toBe('Paquet renommé');
      expect(listing(pkg)).toEqual(before);
    } finally {
      tropy.close();
    }
  });

  it('un .tpy atteint par un lien symbolique, Tropy fermé : rien de créé, ni à côté du lien ni à côté de la cible', () => {
    const archives = path.join(root, 'archives');
    const tpy = makeTpy(archives, { projectId: 'projet-A', name: 'Grèves nantaises', wal: true, items: [] });
    const shortcuts = path.join(root, 'raccourcis');
    fs.mkdirSync(shortcuts);
    const link = path.join(shortcuts, 'greves.tpy');
    fs.symlinkSync(tpy, link);
    const before = { archives: listing(archives), shortcuts: listing(shortcuts) };
    const bytes = digest(tpy);

    expect(projectName(link)).toBe('Grèves nantaises');

    expect({ archives: listing(archives), shortcuts: listing(shortcuts) }).toEqual(before);
    expect(digest(tpy)).toBe(bytes);
  });

  // État anormal (Tropy ne laisse pas un `-wal` sans `-shm`) : copie partielle
  // du dossier, outil de synchronisation qui écarte le `-shm`. Le journal tient
  // des écritures validées : on les lit. SQLite recrée alors un `-shm`, que
  // Tropy retirera en fermant le projet ; la base et le journal restent intacts.
  it('un -wal resté sans -shm, avec un renommage non reporté : la lecture le voit, base et journal intacts', () => {
    const source = path.join(root, 'source');
    const tpy = makeTpy(source, { projectId: 'projet-A', name: 'Grèves nantaises', wal: true, items: [] });
    const copy = path.join(root, 'copie');
    fs.mkdirSync(copy);
    const copied = path.join(copy, path.basename(tpy));
    const tropy = tropyHoldingRename(tpy, 'Grèves de 1907');
    try {
      fs.copyFileSync(tpy, copied);
      fs.copyFileSync(`${tpy}-wal`, `${copied}-wal`);
    } finally {
      tropy.close();
    }
    const before = listing(copy);
    expect(before).toEqual([path.basename(copied), `${path.basename(copied)}-wal`]);
    const bytes = { base: digest(copied), journal: digest(`${copied}-wal`) };

    expect(projectName(copied)).toBe('Grèves de 1907');

    expect(listing(copy)).toEqual([...before, `${path.basename(copied)}-shm`].sort());
    expect({ base: digest(copied), journal: digest(`${copied}-wal`) }).toEqual(bytes);
  });

  // J5 : la copie en mémoire ne tient pas pour les plus grosses bases. Une très
  // grosse base, Tropy fermé, ne se liait plus ni ne se synchronisait. Deux
  // limites, mesurées :
  // - `readFileSync` refuse 2^31 octets (`ERR_FS_FILE_TOO_LARGE`) : c'est le
  //   défaut d'origine ;
  // - sous Electron, la copie que better-sqlite3 fait de l'image dans SQLite
  //   fait tomber le processus (SIGTRAP), sans exception, dès 2^31 − 2 Mio
  //   (revue de J5). Sous Node, où tourne ce test, elle passe : la garde dit la
  //   copie tentée.
  // Ces bases se lisent elles-mêmes ; SQLite crée alors `-wal` et `-shm`, que
  // Tropy retire à sa prochaine ouverture (décision J5). Les tailles sont
  // écrites en clair : elles bornent le seuil par le haut.
  it.each([
    { size: 2 ** 31, limit: 'readFileSync la refuse' },
    { size: 2 ** 31 - 2 * 2 ** 20, limit: 'sa copie dans SQLite fait tomber Electron' },
  ])(
    'un .tpy en WAL de $size octets ($limit), Tropy fermé : se lit lui-même, -wal et -shm à côté, base intacte',
    ({ size }) => {
      const archives = path.join(root, 'archives');
      const tpy = makeTpy(archives, { projectId: 'projet-A', name: 'Grèves nantaises', wal: true, items: [] });
      growSparse(tpy, size);
      expect(listing(archives)).toEqual([path.basename(tpy)]);
      const header = head(tpy);
      largeReads.forbidden = true;

      expect(projectName(tpy)).toBe('Grèves nantaises');

      const name = path.basename(tpy);
      expect(listing(archives)).toEqual([name, `${name}-shm`, `${name}-wal`]);
      expect(fs.statSync(tpy).size).toBe(size);
      expect(head(tpy)).toEqual(header);
    },
  );

  // Revue de J5 : la lecture directe ne vaut qu'au-delà de 2 Gio (décision J5,
  // « seulement »). Une grosse base sous le seuil se lit encore sur la copie en
  // mémoire de G2, sans rien laisser à côté du .tpy. Les tests de G2 n'emploient
  // que des bases de quelques Kio : un seuil abaissé à 1 Mio les passait tous,
  // et laissait `-wal` et `-shm` à côté de presque toutes les vraies bases. Les
  // tailles, écrites en clair, bornent le seuil par le bas. La garde dit la
  // copie tentée sans remplir 2 Gio de mémoire : l'ouverture lève alors, avant
  // que SQLite ne touche au fichier.
  it.each([
    { size: 2 ** 30, label: '1 Gio' },
    { size: 2 ** 31 - 8 * 2 ** 20, label: '2 Gio − 8 Mio' },
  ])(
    'un .tpy en WAL de $size octets ($label), Tropy fermé : copie en mémoire tentée, rien de créé à côté',
    ({ size }) => {
      const archives = path.join(root, 'archives');
      const tpy = makeTpy(archives, { projectId: 'projet-A', name: 'Grèves nantaises', wal: true, items: [] });
      growSparse(tpy, size);
      const before = listing(archives);
      expect(before).toEqual([path.basename(tpy)]);
      const header = head(tpy);
      largeReads.forbidden = true;

      expect(() => openTropyDatabase(tpy)).toThrow(/copie en mémoire/);

      expect(listing(archives)).toEqual(before);
      expect(fs.statSync(tpy).size).toBe(size);
      expect(head(tpy)).toEqual(header);
    },
  );

  it('un -shm resté sans -wal : rien dans un journal, copie en mémoire, aucun -wal créé', () => {
    const archives = path.join(root, 'archives');
    const tpy = makeTpy(archives, { projectId: 'projet-A', name: 'Grèves nantaises', wal: true, items: [] });
    fs.writeFileSync(`${tpy}-shm`, '');
    const before = listing(archives);
    const bytes = digest(tpy);

    expect(projectName(tpy)).toBe('Grèves nantaises');

    expect(listing(archives)).toEqual(before);
    expect(digest(tpy)).toBe(bytes);
  });
});

// La limite de `readFileSync` (`kIoMaxLength`) est une constante que Node ne
// publie pas : le vrai `readFileSync` doit refuser 2^31 octets, la taille du
// premier cas ci-dessus. Le côté « 2^31 − 1 octets se lisent » n'est pas éprouvé
// ici : il remplirait 2 Gio de mémoire. La limite d'Electron ne s'éprouve pas
// non plus : vitest tourne sous Node, où la copie ne fait rien tomber.
describe('limite de readFileSync', () => {
  it('le vrai readFileSync refuse un fichier de 2^31 octets (ERR_FS_FILE_TOO_LARGE)', () => {
    const big = path.join(root, 'creux.bin');
    fs.writeFileSync(big, '');
    growSparse(big, 2 ** 31);

    let error: unknown = null;
    try {
      fs.readFileSync(big);
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ code: 'ERR_FS_FILE_TOO_LARGE' });
  });
});
