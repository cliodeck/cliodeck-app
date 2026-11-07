/**
 * Identité du projet Tropy lié (L06-3, S02-1-18).
 *
 * Les identifiants d'items et de photos d'un .tpy sont des rowid locaux, de 1
 * à N dans chaque projet : seul `project.project_id` dit de quel projet on
 * parle. `decideTropyBinding` tranche à partir de ce qui a été lu, sans
 * SQLite ; la lecture du .tpy, elle, est testée sur de vrais fichiers, et
 * doit laisser le projet de l'historien exactement tel qu'elle l'a trouvé.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sqliteAvailable } from '../../../__tests__/helpers/native-guards';
import { makeTpy, openTpyForWrite, tpyDatabasePath } from './helpers/make-tpy';
import {
  decideTropyBinding,
  readTropyPhotoMatchRatio,
  readTropyProjectIdentity,
} from '../tropy-project-identity';

// MARK: - Table de décision (sans SQLite)

const LINKED = { projectUuid: 'projet-A', tpyPath: '/Archives/A.tropy', name: 'Grèves nantaises' };
const LEGACY = { ...LINKED, projectUuid: null };

function candidate(over: Partial<Parameters<typeof decideTropyBinding>[2]> = {}) {
  return {
    projectId: 'projet-A',
    pathIsSameFile: false,
    linkedPathExists: true,
    photoMatchRatio: null,
    ...over,
  };
}

describe('decideTropyBinding', () => {
  it('premier projet lié : rien à greffer', () => {
    expect(decideTropyBinding(null, 0, candidate({ linkedPathExists: false }))).toEqual({
      kind: 'first-link',
    });
  });

  it('même project_id : le même projet, où qu’il soit', () => {
    expect(decideTropyBinding(LINKED, 25, candidate())).toEqual({ kind: 'same' });
    // Déplacé : l'ancien chemin n'existe plus, l'identité suffit.
    expect(decideTropyBinding(LINKED, 25, candidate({ linkedPathExists: false }))).toEqual({
      kind: 'same',
    });
  });

  it('autre project_id : refusé, même au même chemin et avec les mêmes photos', () => {
    const expected = { kind: 'different', linkedName: 'Grèves nantaises', sourceCount: 25 };
    expect(decideTropyBinding(LINKED, 25, candidate({ projectId: 'projet-B' }))).toEqual(expected);
    // Un autre projet enregistré à la place du premier : le chemin ne prouve rien
    // quand l'identité est connue, l'empreinte non plus.
    expect(
      decideTropyBinding(
        LINKED,
        25,
        candidate({ projectId: 'projet-B', pathIsSameFile: true, photoMatchRatio: 1 })
      )
    ).toEqual(expected);
  });

  it('autre project_id sans aucune source : rien à perdre, le lien se renoue', () => {
    expect(decideTropyBinding(LINKED, 0, candidate({ projectId: 'projet-B' }))).toEqual({
      kind: 'first-link',
    });
  });

  it('ligne d’avant la colonne : le même fichier est le même projet', () => {
    expect(decideTropyBinding(LEGACY, 25, candidate({ pathIsSameFile: true }))).toEqual({
      kind: 'adopt-legacy',
    });
  });

  it('ligne d’avant la colonne, ancien chemin présent : un autre fichier est refusé, empreinte ou pas', () => {
    expect(decideTropyBinding(LEGACY, 25, candidate({ photoMatchRatio: 1 }))).toEqual({
      kind: 'different',
      linkedName: 'Grèves nantaises',
      sourceCount: 25,
    });
  });

  it('ligne d’avant la colonne, ancien chemin disparu : l’empreinte tranche, à 90 % ou plus', () => {
    const moved = { linkedPathExists: false };
    expect(decideTropyBinding(LEGACY, 25, candidate({ ...moved, photoMatchRatio: 1 }))).toEqual({
      kind: 'adopt-legacy',
    });
    expect(decideTropyBinding(LEGACY, 25, candidate({ ...moved, photoMatchRatio: 0.9 }))).toEqual({
      kind: 'adopt-legacy',
    });
    expect(decideTropyBinding(LEGACY, 25, candidate({ ...moved, photoMatchRatio: 0.89 }))).toEqual({
      kind: 'different',
      linkedName: 'Grèves nantaises',
      sourceCount: 25,
    });
    // Aucune photo à comparer : aucune preuve, refus.
    expect(decideTropyBinding(LEGACY, 25, candidate({ ...moved, photoMatchRatio: null }))).toEqual({
      kind: 'different',
      linkedName: 'Grèves nantaises',
      sourceCount: 25,
    });
  });

  it('identité du candidat illisible : on retombe sur le chemin, comme pour une ligne ancienne', () => {
    expect(
      decideTropyBinding(LINKED, 25, candidate({ projectId: null, pathIsSameFile: true }))
    ).toEqual({ kind: 'adopt-legacy' });
    expect(decideTropyBinding(LINKED, 25, candidate({ projectId: null }))).toEqual({
      kind: 'different',
      linkedName: 'Grèves nantaises',
      sourceCount: 25,
    });
  });

  it('des sources sans projet enregistré : seule l’empreinte les rattache', () => {
    const orphan = candidate({ linkedPathExists: false });
    expect(decideTropyBinding(null, 3, { ...orphan, photoMatchRatio: 0.95 })).toEqual({
      kind: 'adopt-legacy',
    });
    expect(decideTropyBinding(null, 3, { ...orphan, photoMatchRatio: 0.1 })).toEqual({
      kind: 'different',
      linkedName: '',
      sourceCount: 3,
    });
  });
});

// MARK: - Lecture du .tpy (vrais fichiers)

let root: string;

function listing(dir: string): string[] {
  return fs.readdirSync(dir).sort();
}

function digest(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-tropy-identity-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('readTropyProjectIdentity', () => {
  it('lit project_id et nom d’un .tpy nu', () => {
    const tpy = makeTpy(root, { projectId: 'projet-A', name: 'Grèves nantaises', items: [] });
    expect(readTropyProjectIdentity(tpy)).toEqual({ projectId: 'projet-A', name: 'Grèves nantaises' });
  });

  it('lit un paquet .tropy en WAL sans créer de -wal ni de -shm à côté de la base', () => {
    const pkg = makeTpy(root, {
      projectId: 'projet-paquet',
      name: 'Paquet',
      packaged: true,
      wal: true,
      items: [{ title: 'Pièce', photos: [{ path: 'scan.jpg' }] }],
    });
    const before = listing(pkg);
    const bytes = digest(tpyDatabasePath(pkg));

    expect(readTropyProjectIdentity(pkg)).toEqual({ projectId: 'projet-paquet', name: 'Paquet' });

    // Tropy fermé : la base n'a pas de journal à côté, la lecture n'en laisse pas.
    expect(listing(pkg)).toEqual(before);
    expect(digest(tpyDatabasePath(pkg))).toBe(bytes);
  });

  it('lit l’état courant d’un projet que Tropy tient ouvert, sans rien y écrire', () => {
    const tpy = makeTpy(root, { projectId: 'projet-A', name: 'Grèves nantaises', wal: true, items: [] });
    const tropy = openTpyForWrite(tpy);
    try {
      tropy.pragma('journal_mode = WAL');
      tropy.pragma('wal_autocheckpoint = 0');
      // Renommé dans Tropy, pas encore reporté dans le fichier principal.
      tropy.prepare('UPDATE project SET name = ?').run('Grèves de 1907');
      const before = listing(root);

      expect(readTropyProjectIdentity(tpy)).toEqual({ projectId: 'projet-A', name: 'Grèves de 1907' });
      expect(listing(root)).toEqual(before);
    } finally {
      tropy.close();
    }
  });

  it('refuse un chemin absent ou qui n’est pas un projet Tropy', () => {
    expect(() => readTropyProjectIdentity(path.join(root, 'absent.tpy'))).toThrow();
    const notTropy = path.join(root, 'notes.txt');
    fs.writeFileSync(notTropy, 'pas une base');
    expect(() => readTropyProjectIdentity(notTropy)).toThrow();
  });
});

describe.skipIf(!sqliteAvailable)('readTropyPhotoMatchRatio', () => {
  it('compare des couples (id de photo, nom de fichier) au projet candidat', () => {
    const tpy = makeTpy(root, {
      projectId: 'projet-A',
      items: [
        { id: 10, photos: [{ id: 11, path: '/scans/rapport.jpg' }, { id: 12, path: '/scans/rapport-p2.jpg' }] },
        { id: 20, photos: [{ id: 21, path: '/scans/lettre.jpg', filename: 'Lettre.JPG' }] },
      ],
    });

    expect(
      readTropyPhotoMatchRatio(tpy, [
        { id: 11, filename: 'rapport.jpg' },
        { id: 12, filename: 'rapport-p2.jpg' },
        { id: 21, filename: 'Lettre.JPG' },
      ])
    ).toBe(1);
    // Mêmes identifiants, autres fichiers : un autre fonds numéroté pareil.
    expect(
      readTropyPhotoMatchRatio(tpy, [
        { id: 11, filename: 'affiche.jpg' },
        { id: 12, filename: 'rapport-p2.jpg' },
        { id: 99, filename: 'absent.jpg' },
        { id: 21, filename: 'pv.jpg' },
      ])
    ).toBe(0.25);
    expect(readTropyPhotoMatchRatio(tpy, [])).toBeNull();
  });
});
