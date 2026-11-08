/**
 * Chemin rangé d'un PDF du projet : relatif au projet (ou au dossier du `.bib`) quand il y est,
 * absolu sinon (S07-2-1).
 *
 * Le chemin d'un PDF téléchargé s'écrivait en absolu dans `bibliography-metadata.json` et dans le
 * champ `file` du `.bib`. Le dossier du projet renommé, ou ouvert sur un autre Mac (Dropbox, autre
 * nom d'utilisateur), chaque référence désignait un fichier disparu ; et le `.bib` partagé disait
 * le chemin local de l'auteur. Rangé relatif, il se résout au chargement contre le projet tel qu'il
 * est ; en mémoire et dans les réponses IPC, les chemins restent absolus.
 *
 * Pure analyse de chaînes, sans le disque (sauf `exists`) : un chemin de Windows s'analyse comme
 * tel sur tout système, jusque dans les tests.
 */

import { existsSync } from 'fs';
import path from 'path';

/** Le dossier où le téléchargement Zotero range les PDF d'un projet. */
export const PDF_DIR = 'PDFs';

/** Lettre de lecteur (`C:\`, `C:/`) ou partage réseau (`\\serveur\…`). */
const WINDOWS_PATH = /^[A-Za-z]:[\\/]|^\\\\/;

/** Les deux séparateurs, en barres obliques normales, `.` et `..` résolus : la forme où l'on compare. */
const slashed = (p: string): string => path.posix.normalize(p.replaceAll('\\', '/'));

/** Absolu ici ou sous Windows : `/…`, `C:\…`, `C:/…`, `\\serveur\…`. */
const isAbsoluteAnywhere = (p: string): boolean => path.win32.isAbsolute(p);

/** Le nom du fichier, quel que soit le séparateur. */
const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;

/** Le module de chemins qui convient à ce dossier : celui de Windows pour un chemin de Windows. */
const pathApi = (dir: string): path.PlatformPath => (WINDOWS_PATH.test(dir) ? path.win32 : path);

/**
 * La forme rangée de `absolute` : relative à `baseDir`, en barres obliques normales, quand il y est ;
 * le chemin tel quel sinon. On compare au dossier suivi d'un séparateur : `/projetX` n'est pas dans
 * `/projet`. La casse ne compte que hors de Windows, qui ne la distingue jamais. Un chemin déjà
 * relatif reste relatif.
 */
export function toStoredPath(absolute: string, baseDir: string): string {
  const file = slashed(absolute);
  if (!isAbsoluteAnywhere(absolute)) return file;
  const base = slashed(baseDir);
  const prefix = base.endsWith('/') ? base : `${base}/`;
  const windows = WINDOWS_PATH.test(absolute) || WINDOWS_PATH.test(baseDir);
  const fold = (p: string) => (windows ? p.toLowerCase() : p);
  return fold(file).startsWith(fold(prefix)) ? file.slice(prefix.length) : absolute;
}

/** Le PDF de même nom dans `PDFs/` du projet. */
const rebase = (stored: string, projectPath: string): string =>
  pathApi(projectPath).join(projectPath, PDF_DIR, baseName(stored));

/**
 * Quand `stored` est un chemin absolu rangé dans le dossier `PDFs` d'un autre dossier : le PDF de
 * même nom dans `PDFs/` du projet, qui en tiendrait lieu. Hors de ce cas, `undefined` : un PDF de
 * Zotero (`storage/<clé>/…`), ou rangé ailleurs, n'a pas de double ici. L'existence du fichier
 * n'est pas vérifiée.
 *
 * Il en tient lieu pour un chemin que le téléchargement de ce projet a écrit (`localPath` des
 * métadonnées) : celui-ci n'écrit que dans `PDFs/` du projet ouvert, et un tel chemin vient d'un
 * projet écrit avant S07-2-1, puis renommé, ou copié (sauvegarde, « Dupliquer » du Finder) alors que
 * l'original reste en place. Pas pour le champ `file` d'un `.bib` : il vient aussi d'un import, et
 * l'homonyme est alors le PDF d'une autre référence. Le PDF du `.bib` ne cède que devant le
 * téléchargement de sa référence (cf. `resolvePdf` de `BibliographyMetadataService`).
 */
export function projectCopyOf(stored: string, projectPath: string): string | undefined {
  if (!isAbsoluteAnywhere(stored)) return undefined;
  const inPdfDir = slashed(stored).split('/').slice(-2, -1)[0] === PDF_DIR;
  const outside = isAbsoluteAnywhere(toStoredPath(stored, projectPath));
  return inPdfDir && outside ? rebase(stored, projectPath) : undefined;
}

/**
 * Le chemin absolu d'un chemin rangé par le téléchargement du projet (`localPath`) : relatif,
 * rattaché au projet tel qu'il est maintenant. Absolu, dans `PDFs/` d'un autre dossier, et le projet
 * a le sien (`projectCopyOf`) : celui du projet, même si l'autre existe encore. Absolu et présent :
 * tel quel. Absolu mais disparu (projet renommé, écrit sur un autre poste) : le PDF de même nom dans
 * `PDFs/` du projet s'il y est. Sinon tel quel : un fichier rangé hors du projet n'est jamais
 * déplacé en pensée. Le `file` d'un `.bib` n'y passe qu'une fois disparu (`resolvePdf`) : la
 * préférence pour la copie se confond alors avec le repli dans `PDFs/`.
 */
export function fromStoredPath(
  stored: string,
  projectPath: string,
  exists: (p: string) => boolean = existsSync
): string {
  if (!isAbsoluteAnywhere(stored)) return pathApi(projectPath).join(projectPath, ...stored.split(/[\\/]/));
  const copy = projectCopyOf(stored, projectPath);
  if (copy && exists(copy)) return copy;
  if (exists(stored)) return stored;
  const rebased = rebase(stored, projectPath);
  return exists(rebased) ? rebased : stored;
}
