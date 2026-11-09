/**
 * Ouverture de la base d'un projet Tropy, en lecture seule, sans rien laisser
 * à côté du .tpy (G2).
 *
 * Une seule règle pour les deux lecteurs du .tpy : `TropyReader.openProject`
 * (synchro, aperçu, liste des items, photos d'une source pour l'OCR) et
 * `withTropyDatabase` (identité du projet lié, L06-3,
 * `tropy-project-identity.ts`).
 */
import * as fs from 'fs';
import Database from 'better-sqlite3';

/** En-tête SQLite en journal WAL (octets 18 et 19 de l'en-tête à 2). */
function isWalDatabase(dbPath: string): boolean {
  const header = Buffer.alloc(20);
  const fd = fs.openSync(dbPath, 'r');
  try {
    const read = fs.readSync(fd, header, 0, header.length, 0);
    return read === header.length && header.toString('latin1', 0, 16) === 'SQLite format 3\u0000' &&
      (header[18] === 2 || header[19] === 2);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Ouvrir en lecture seule une base en WAL crée ses `-wal` et `-shm` quand ils
 * n'existent pas, et les laisse après la fermeture (mesuré avec
 * better-sqlite3 13). Tropy les supprime en fermant un projet : Tropy fermé,
 * tout le contenu est donc dans le fichier principal, et on en lit une copie
 * en mémoire, marquée « journal classique » (octets 18 et 19, 2 → 1) — le
 * fichier, lui, n'est pas touché. Tropy ouvert, ses `-wal` et `-shm` existent
 * déjà : on lit la base elle-même, avec ce qu'il n'a pas encore reporté. Une
 * base qui n'est pas en WAL se lit elle-même aussi.
 *
 * La copie tient la base entière en mémoire tant que la connexion reste
 * ouverte : toute la synchro, OCR compris, pour `TropyReader`.
 *
 * `dbPath` est le fichier SQLite (le `project.tpy` d'un paquet `.tropy`).
 * Rend une connexion ouverte, que l'appelant ferme.
 */
export function openTropyDatabase(dbPath: string): Database.Database {
  const journalOpen = fs.existsSync(`${dbPath}-wal`) && fs.existsSync(`${dbPath}-shm`);
  if (!journalOpen && isWalDatabase(dbPath)) {
    const image = fs.readFileSync(dbPath);
    image[18] = 1;
    image[19] = 1;
    return new Database(image, { readonly: true });
  }
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}
