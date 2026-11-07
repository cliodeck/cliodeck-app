/**
 * Identité du projet Tropy lié à un projet ClioDeck (L06-3, S02-1-18).
 *
 * Les identifiants qu'utilise la synchro — `subjects.id` pour les items et
 * les photos — sont des rowid propres à chaque .tpy, de 1 à N : l'item 10 d'un
 * fonds n'a rien à voir avec l'item 10 d'un autre. Seul `project.project_id`
 * dit de quel projet on parle. Faute de le lire, ouvrir un second projet
 * Tropy rattachait chacun de ses items à la source de même numéro du premier :
 * titre du rapport du préfet sur le texte OCR de la lettre de Blum.
 *
 * Lecture à part de `TropyReader`, qui n'est pas modifié : ouverture en
 * lecture seule, rien d'écrit, rien laissé à côté du .tpy, connexion fermée
 * quoi qu'il arrive.
 */
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { sameFile } from '../../core/vector-store/file-identity';
import type { PrimarySourcesVectorStore } from '../../core/vector-store/PrimarySourcesVectorStore';

// MARK: - Types

export interface TropyProjectIdentity {
  /** `project.project_id` ; `null` si le projet n'en porte pas. */
  projectId: string | null;
  name: string;
}

export type TropyBindingDecision =
  | { kind: 'first-link' | 'same' | 'adopt-legacy' }
  | { kind: 'different'; linkedName: string; sourceCount: number };

export interface TropyBindingAssessment {
  /** Le projet candidat, tel que lu dans son .tpy. */
  identity: TropyProjectIdentity;
  decision: TropyBindingDecision;
  /**
   * La ligne de `tropy_projects` que le candidat met à jour (`keepId` de
   * `bindTropyProject`) : celle du projet lié quand la décision le reconnaît
   * (`same`, `adopt-legacy`). Sans elle, un projet reconnu par la seule
   * empreinte — ligne sans uuid, ancien chemin disparu — recevait une ligne
   * neuve, et perdait sa surveillance. `null` sinon : une première liaison
   * ne reprend pas les réglages d'un autre projet.
   */
  linkedId: string | null;
}

/** Couples (id de photo, nom de fichier) comparés pour une ligne d'avant `project_uuid`. */
export const PHOTO_FINGERPRINT_SIZE = 200;
/** Part des couples qui doivent se retrouver dans le candidat pour le tenir pour le même projet. */
export const PHOTO_FINGERPRINT_MIN_RATIO = 0.9;

// MARK: - Lecture du .tpy

/** Même règle que `TropyReader.openProject` : un paquet `.tropy` porte sa base dans `project.tpy`. */
function databasePath(projectPath: string): string {
  if (fs.statSync(projectPath).isDirectory() && projectPath.endsWith('.tropy')) {
    return path.join(projectPath, 'project.tpy');
  }
  if (projectPath.endsWith('.tpy')) return projectPath;
  throw new Error(`Invalid Tropy project path: ${projectPath}. Expected .tropy or .tpy`);
}

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
 * déjà : on lit la base elle-même, avec ce qu'il n'a pas encore reporté.
 */
function withTropyDatabase<T>(projectPath: string, read: (db: Database.Database) => T): T {
  const dbPath = databasePath(projectPath);
  const journalOpen = fs.existsSync(`${dbPath}-wal`) && fs.existsSync(`${dbPath}-shm`);
  let db: Database.Database;
  if (!journalOpen && isWalDatabase(dbPath)) {
    const image = fs.readFileSync(dbPath);
    image[18] = 1;
    image[19] = 1;
    db = new Database(image, { readonly: true });
  } else {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  }
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/**
 * `project_id` et nom du projet Tropy. Lève si le fichier est absent ou n'est
 * pas un projet Tropy : à l'appelant de décider, la garde ne devine pas.
 */
export function readTropyProjectIdentity(projectPath: string): TropyProjectIdentity {
  return withTropyDatabase(projectPath, (db) => {
    const row = db.prepare('SELECT project_id, name FROM project LIMIT 1').get() as
      | { project_id: string | null; name: string | null }
      | undefined;
    return { projectId: row?.project_id || null, name: row?.name || 'Unnamed Project' };
  });
}

/**
 * Part des couples (id de photo, nom de fichier) de `sample` que le candidat
 * porte à l'identique, nom dérivé comme le fait `TropyReader`. `null` sans
 * rien à comparer.
 */
export function readTropyPhotoMatchRatio(
  projectPath: string,
  sample: ReadonlyArray<{ id: number; filename: string }>
): number | null {
  if (sample.length === 0) return null;
  return withTropyDatabase(projectPath, (db) => {
    const lookup = db.prepare('SELECT path, filename FROM photos WHERE id = ?');
    let matches = 0;
    for (const { id, filename } of sample) {
      const row = lookup.get(id) as { path: string; filename: string | null } | undefined;
      if (row && (row.filename || path.basename(row.path)) === filename) matches++;
    }
    return matches / sample.length;
  });
}

// MARK: - Décision

/**
 * Le candidat est-il le projet Tropy dont viennent les sources ? Pure : tout
 * ce qui se lit sur le disque est lu avant (`assessTropyBinding`).
 *
 * 1. Même `project_id` : le même projet, où qu'il soit — déplacé, renommé, ou
 *    copié dans le Finder (une copie garde son `project_id` : accepté).
 * 2. Ligne d'avant `project_uuid`, ou identité du candidat illisible : le même
 *    fichier est le même projet ; si l'ancien chemin n'existe plus, l'empreinte
 *    des photos tranche, à 90 % ou plus.
 * 3. Aucune source : rien ne peut être greffé, le lien se (re)noue librement.
 * 4. Sinon, un autre projet : refusé. On le remplace par la purge existante.
 *
 * Un projet ClioDeck, un projet Tropy (décision Q25, pour la v1). Rien d'autre
 * ne l'impose : `tropy_projects` peut tenir plusieurs lignes et chacune porte
 * son `project_uuid`. Lier plusieurs projets Tropy à un projet ClioDeck (ou
 * une collection Zotero comme fonds de sources primaires), noté pour une v1.5
 * ou une v2, demandera de cloisonner les sources par projet — `tropy_sources`
 * et `tropy_photos` n'ont pas de colonne de projet — puis de remplacer cette
 * règle : c'est ici, et dans `bindTropyProject`, que le « un seul » se décide.
 */
export function decideTropyBinding(
  linked: { projectUuid: string | null; tpyPath: string; name: string } | null,
  sourceCount: number,
  candidate: {
    projectId: string | null;
    pathIsSameFile: boolean;
    linkedPathExists: boolean;
    photoMatchRatio: number | null;
  }
): TropyBindingDecision {
  if (linked?.projectUuid && candidate.projectId) {
    if (linked.projectUuid === candidate.projectId) return { kind: 'same' };
  } else {
    if (linked && candidate.pathIsSameFile) return { kind: 'adopt-legacy' };
    if (
      !candidate.linkedPathExists &&
      candidate.photoMatchRatio !== null &&
      candidate.photoMatchRatio >= PHOTO_FINGERPRINT_MIN_RATIO
    ) {
      return { kind: 'adopt-legacy' };
    }
  }

  if (sourceCount === 0) return { kind: 'first-link' };
  return { kind: 'different', linkedName: linked?.name ?? '', sourceCount };
}

/**
 * Lit ce que `decideTropyBinding` demande — l'identité du candidat, le lien
 * enregistré, et l'empreinte des photos quand elle seule peut trancher — puis
 * décide. Lève si le candidat n'est pas lisible.
 */
export function assessTropyBinding(
  projectPath: string,
  store: Pick<PrimarySourcesVectorStore, 'getTropyProject' | 'getStatistics' | 'getPhotoFingerprint'>
): TropyBindingAssessment {
  const identity = readTropyProjectIdentity(projectPath);
  const linked = store.getTropyProject();
  const sourceCount = store.getStatistics().sourceCount;
  const linkedPathExists = linked !== null && fs.existsSync(linked.tpyPath);
  const pathIsSameFile = linked !== null && sameFile(linked.tpyPath, projectPath);

  let photoMatchRatio: number | null = null;
  const identityDecides = !!linked?.projectUuid && !!identity.projectId;
  if (!identityDecides && !linkedPathExists && sourceCount > 0) {
    try {
      photoMatchRatio = readTropyPhotoMatchRatio(
        projectPath,
        store.getPhotoFingerprint(PHOTO_FINGERPRINT_SIZE)
      );
    } catch (error) {
      // Pas d'empreinte, pas de preuve : la décision refusera.
      console.warn('⚠️ [TROPY-IDENTITY] Photo fingerprint unreadable:', error);
    }
  }

  const decision = decideTropyBinding(linked, sourceCount, {
    projectId: identity.projectId,
    pathIsSameFile,
    linkedPathExists,
    photoMatchRatio,
  });
  const recognised = decision.kind === 'same' || decision.kind === 'adopt-legacy';
  return { identity, decision, linkedId: recognised ? (linked?.id ?? null) : null };
}
