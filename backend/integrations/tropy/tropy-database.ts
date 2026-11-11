/**
 * Ouverture de la base d'un projet Tropy, en lecture seule, sans rien laisser
 * à côté du .tpy (G2), sauf à partir de 2 Gio (J5).
 *
 * Une seule règle pour les deux lecteurs du .tpy : `TropyReader.openProject`
 * (synchro, aperçu, liste des items, photos d'une source pour l'OCR) et
 * `withTropyDatabase` (identité du projet lié, L06-3,
 * `tropy-project-identity.ts`).
 */
import * as fs from 'fs';
import Database from 'better-sqlite3';

/**
 * Plus gros fichier que `fs.readFileSync` lit d'un coup : `kIoMaxLength`
 * (2^31 − 1 octets, un de moins que 2 Gio) de `lib/internal/fs/utils.js`,
 * que Node ne publie pas. Au-delà, `readFileSync` lève
 * `ERR_FS_FILE_TOO_LARGE` avant toute lecture (mesuré sous le Node 24.22
 * d'Electron 45 : 2^31 − 1 octets se lisent, 2^31 non).
 * `buffer.constants.MAX_LENGTH` n'est pas cette limite : il vaut 32 Gio − 1
 * sous Electron 45. `tropy-database.test.ts` la confronte au vrai
 * `readFileSync`.
 */
export const READ_FILE_SYNC_MAX_BYTES = 2 ** 31 - 1;

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
 * better-sqlite3 13). Tropy les supprime en fermant un projet : sans `-wal`,
 * tout le contenu est donc dans le fichier principal, et on en lit une copie
 * en mémoire, marquée « journal classique » (octets 18 et 19, 2 → 1) — le
 * fichier, lui, n'est pas touché. Avec un `-wal`, Tropy est ouvert (ses
 * `-wal` et `-shm` existent) ou a laissé un journal : on lit la base
 * elle-même, avec ce qu'il n'a pas encore reporté. Une base qui n'est pas en
 * WAL se lit elle-même aussi.
 *
 * Le journal se cherche à côté du fichier réel, liens symboliques résolus :
 * c'est là que SQLite le range. Un `-shm` seul ne compte pas (aucune écriture
 * n'y attend) ; un `-wal` resté sans `-shm` — état anormal : copie partielle,
 * outil de synchronisation qui écarte le `-shm` — se lit, et SQLite recrée
 * alors un `-shm`, que Tropy retire en fermant le projet. En dessous de 2 Gio,
 * rien d'autre n'est jamais créé : aucun `-wal`.
 *
 * La copie tient la base entière en mémoire tant que la connexion reste
 * ouverte : toute la synchro, OCR compris, pour `TropyReader`. Elle passe par
 * `fs.readFileSync`, qui refuse un fichier de 2 Gio ou plus
 * (`READ_FILE_SYNC_MAX_BYTES`). Au-delà, la base se lit donc elle-même, comme
 * une base qui n'est pas en WAL (J5) : SQLite crée alors `-wal` et `-shm` à
 * côté du .tpy et les y laisse, et Tropy les retire à sa prochaine ouverture.
 *
 * `dbPath` est le fichier SQLite (le `project.tpy` d'un paquet `.tropy`).
 * Rend une connexion ouverte, que l'appelant ferme.
 */
export function openTropyDatabase(dbPath: string): Database.Database {
  const realPath = fs.realpathSync(dbPath);
  if (
    !fs.existsSync(`${realPath}-wal`) &&
    isWalDatabase(realPath) &&
    fs.statSync(realPath).size <= READ_FILE_SYNC_MAX_BYTES
  ) {
    const image = fs.readFileSync(realPath);
    image[18] = 1;
    image[19] = 1;
    return new Database(image, { readonly: true });
  }
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}
