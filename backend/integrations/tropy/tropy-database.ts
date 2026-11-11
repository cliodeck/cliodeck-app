/**
 * Ouverture de la base d'un projet Tropy, en lecture seule, sans rien laisser
 * à côté du .tpy (G2), sauf pour une base trop grosse pour une copie en
 * mémoire (J5).
 *
 * Une seule règle pour les deux lecteurs du .tpy : `TropyReader.openProject`
 * (synchro, aperçu, liste des items, photos d'une source pour l'OCR) et
 * `withTropyDatabase` (identité du projet lié, L06-3,
 * `tropy-project-identity.ts`).
 */
import * as fs from 'fs';
import Database from 'better-sqlite3';

/**
 * Plus grosse base lue sur une copie en mémoire : 2 Gio − 4 Mio (J5). Deux
 * limites, mesurées, empêchent la copie au-delà :
 *
 * - `fs.readFileSync` refuse un fichier de 2^31 octets ou plus
 *   (`ERR_FS_FILE_TOO_LARGE`, avant toute lecture). Sa limite est
 *   `kIoMaxLength` (2^31 − 1) de `lib/internal/fs/utils.js`, que Node ne
 *   publie pas ; `buffer.constants.MAX_LENGTH` n'est pas cette limite (32 Gio
 *   − 1 sous Electron 45). Mesuré sous le Node 24.22 d'Electron 45 : 2^31 − 1
 *   octets se lisent, 2^31 non.
 * - better-sqlite3 recopie ensuite l'image dans la mémoire de SQLite
 *   (`Database::Deserialize` : `sqlite3_malloc64(length)`, puis `memcpy`).
 *   Sous Electron, une allocation trop grosse fait tomber le processus
 *   (SIGTRAP, code de sortie 133) au lieu d'échouer : aucune exception à
 *   rattraper. Mesuré sous Electron 45.2.3 (macOS arm64), dans le processus
 *   principal, sur des bases en WAL agrandies en fichiers creux : 2 145 382 400
 *   octets se lisent, 2 145 386 496 (2 Gio − 2 Mio) font tomber l'app. Sous
 *   Node, rien ne tombe.
 *
 * C'est la seconde qui compte ; le seuil garde 2 Mio de marge sous elle.
 * vitest tourne sous Node : aucun test ne voit la limite d'Electron. Le seuil
 * a été éprouvé dans le processus principal d'Electron 45 (PR J5) : une base
 * de 2 143 289 344 octets s'y lit sur la copie en mémoire.
 */
export const MEMORY_COPY_MAX_BYTES = 2 ** 31 - 4 * 2 ** 20;

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
 * alors un `-shm`, que Tropy retire en fermant le projet. Jusqu'à
 * `MEMORY_COPY_MAX_BYTES`, rien d'autre n'est jamais créé : aucun `-wal`.
 *
 * La copie tient la base entière en mémoire tant que la connexion reste
 * ouverte : toute la synchro, OCR compris, pour `TropyReader`. Elle ne tient
 * pas pour les plus grosses bases (`MEMORY_COPY_MAX_BYTES`, 2 Gio − 4 Mio :
 * `readFileSync` refuse 2 Gio, et sous Electron, la recopie de l'image dans
 * SQLite fait tomber l'app un peu avant). Au-delà, la base se lit donc
 * elle-même, comme une base qui n'est pas en WAL (J5) : SQLite crée alors
 * `-wal` et `-shm` à côté du .tpy et les y laisse, et Tropy les retire à sa
 * prochaine ouverture.
 *
 * `dbPath` est le fichier SQLite (le `project.tpy` d'un paquet `.tropy`).
 * Rend une connexion ouverte, que l'appelant ferme.
 */
export function openTropyDatabase(dbPath: string): Database.Database {
  const realPath = fs.realpathSync(dbPath);
  if (
    !fs.existsSync(`${realPath}-wal`) &&
    isWalDatabase(realPath) &&
    fs.statSync(realPath).size <= MEMORY_COPY_MAX_BYTES
  ) {
    const image = fs.readFileSync(realPath);
    image[18] = 1;
    image[19] = 1;
    return new Database(image, { readonly: true });
  }
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}
