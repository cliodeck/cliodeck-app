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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sqliteAvailable } from '../../../__tests__/helpers/native-guards';
import { makeTpy, openTpyForWrite, tpyDatabasePath } from './helpers/make-tpy';
import { openTropyDatabase } from '../tropy-database';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-tropy-db-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function listing(dir: string): string[] {
  return fs.readdirSync(dir).sort();
}

function digest(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
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
