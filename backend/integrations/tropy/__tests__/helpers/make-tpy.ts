/**
 * Fabrique de vrais projets Tropy (.tpy, base SQLite) pour les tests.
 *
 * D'où vient le schéma. Tropy n'est pas installé sur la machine où ce fichier
 * a été écrit, et les .tpy de l'auteur ne sont pas des fixtures : le DDL
 * ci-dessous est écrit à la main, sans copier le fichier de schéma de Tropy,
 * à partir de deux sources :
 *  1. les colonnes que `TropyReader` interroge aujourd'hui — `project.name`,
 *     `subjects.(id, template, type, modified)`, `items.id`,
 *     `photos.(id, item_id, path, filename, mimetype, position)`,
 *     `images.(id, width, height, angle)`, `selections.(id, photo_id, x, y)`,
 *     `metadata.(id, property, value_id)`, `metadata_values.(value_id, text)`,
 *     `notes.(note_id, id, text, state, deleted)`, `tags.(tag_id, name)`,
 *     `taggings.(tag_id, id)` : celles-là doivent exister telles quelles ;
 *  2. le schéma de projet de Tropy 1.17 tel qu'il est publié dans son dépôt
 *     (`db/schema/project.sql`) pour le reste : `project.(project_id, base)`,
 *     la table `trash` et ses raisons, la table `transcriptions` (Tropy ≥ 1.15),
 *     les contraintes NOT NULL et les clés étrangères qui imposent un
 *     identifiant partagé par `subjects` (un item, une photo, une sélection
 *     sont tous des sujets ; une photo et une sélection sont aussi des images).
 * Les colonnes que ClioDeck ne lit pas ne sont reprises que si une contrainte
 * de Tropy les rend obligatoires (`photos.checksum`, `photos.protocol`…).
 *
 * À RELIRE À CHAQUE MONTÉE DE TROPY : comparer avec le `project.sql` de la
 * version, ou mieux avec `sqlite3 projet.tpy .schema` sur un projet créé par
 * elle. Un schéma qui dérive rend ces tests verts sur une base que Tropy
 * n'écrit plus.
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

// MARK: - Spécification

export type TpyTrashReason = 'user' | 'auto' | 'merge';

export interface TpyNoteSpec {
  /** Texte brut, ce que `TropyReader` lit dans `notes.text`. */
  text: string;
  /** État ProseMirror sérialisé (`notes.state`) ; par défaut, un paragraphe. */
  state?: string;
  /** Note supprimée (`notes.deleted` renseigné) : Tropy la garde, invisible. */
  deleted?: boolean;
}

export interface TpyTranscriptionSpec {
  text: string;
  /** Statut Tropy : > 0 terminé, 0 en cours, < 0 en erreur. Défaut : 1. */
  status?: number;
  deleted?: boolean;
  /** ISO ; détermine « la plus récente » quand une image en a plusieurs. */
  created?: string;
  modified?: string;
}

export interface TpySelectionSpec {
  id?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  angle?: number;
  notes?: TpyNoteSpec[];
  transcriptions?: TpyTranscriptionSpec[];
  trash?: TpyTrashReason;
}

export interface TpyPhotoSpec {
  id?: number;
  /** Chemin tel que Tropy l'enregistre : absolu, ou relatif à `base`. */
  path: string;
  filename?: string;
  mimetype?: string;
  width?: number;
  height?: number;
  /** Page d'un PDF (Tropy crée une photo par page, même `path`). */
  page?: number;
  notes?: TpyNoteSpec[];
  selections?: TpySelectionSpec[];
  transcriptions?: TpyTranscriptionSpec[];
  trash?: TpyTrashReason;
}

export interface TpyItemSpec {
  /** Identifiant de sujet ; sinon attribué dans l'ordre de la spécification. */
  id?: number;
  template?: string;
  type?: string;
  /** `subjects.modified`, en ISO ; défaut : une date fixe. */
  modified?: string;
  title?: string;
  date?: string;
  creator?: string;
  /**
   * Autres métadonnées, par URI de propriété complète
   * (« https://tropy.org/v1/tropy#box » → « Carton 12 »).
   */
  metadata?: Record<string, string>;
  tags?: string[];
  notes?: TpyNoteSpec[];
  photos?: TpyPhotoSpec[];
  trash?: TpyTrashReason;
}

export interface TpySpec {
  /** `project.project_id` : l'identité du projet, stable d'une version à l'autre. */
  projectId: string;
  name?: string;
  /** `project.base` : à quoi sont relatifs les chemins de photos. */
  base?: 'project' | 'home';
  items: TpyItemSpec[];
  /** Paquet `<nom>.tropy/` contenant `project.tpy` et `assets/`. */
  packaged?: boolean;
  /** Base en journal WAL, comme Tropy l'ouvre. */
  wal?: boolean;
}

// MARK: - Schéma

const DC = 'http://purl.org/dc/elements/1.1/';
const GENERIC_TEMPLATE = 'https://tropy.org/v1/templates/generic';
const DEFAULT_MODIFIED = '2026-05-06T13:13:22.394Z';
const FIXED_CREATED = '2026-05-01T09:00:00.000Z';

const DDL = `
CREATE TABLE project (
  project_id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  base TEXT,
  created NUMERIC NOT NULL DEFAULT CURRENT_TIMESTAMP,
  modified NUMERIC NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (project_id != ''),
  CHECK (name != '')
);

CREATE TABLE subjects (
  id INTEGER PRIMARY KEY,
  template TEXT NOT NULL DEFAULT '${GENERIC_TEMPLATE}',
  type TEXT,
  created NUMERIC NOT NULL DEFAULT CURRENT_TIMESTAMP,
  modified NUMERIC NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE images (
  id INTEGER PRIMARY KEY REFERENCES subjects (id) ON DELETE CASCADE,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  angle NUMERIC NOT NULL DEFAULT 0,
  mirror BOOLEAN NOT NULL DEFAULT 0
);

CREATE TABLE items (
  id INTEGER PRIMARY KEY REFERENCES subjects (id) ON DELETE CASCADE,
  cover_image_id INTEGER REFERENCES images (id) ON DELETE SET NULL
);

CREATE TABLE photos (
  id INTEGER PRIMARY KEY REFERENCES images (id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  position INTEGER,
  path TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'file',
  mimetype TEXT NOT NULL,
  checksum TEXT NOT NULL,
  orientation INTEGER NOT NULL DEFAULT 1,
  metadata TEXT NOT NULL DEFAULT '{}',
  size INTEGER NOT NULL DEFAULT 0,
  filename TEXT,
  page INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE selections (
  id INTEGER PRIMARY KEY REFERENCES images (id) ON DELETE CASCADE,
  photo_id INTEGER NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
  x NUMERIC NOT NULL DEFAULT 0,
  y NUMERIC NOT NULL DEFAULT 0,
  position INTEGER
);

CREATE TABLE metadata_values (
  value_id INTEGER PRIMARY KEY,
  datatype TEXT NOT NULL,
  text TEXT NOT NULL,
  data TEXT,
  UNIQUE (datatype, text)
);

CREATE TABLE metadata (
  id INTEGER NOT NULL REFERENCES subjects (id) ON DELETE CASCADE,
  property TEXT NOT NULL,
  value_id INTEGER NOT NULL REFERENCES metadata_values (value_id),
  language TEXT,
  created NUMERIC NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id, property)
);

CREATE TABLE notes (
  note_id INTEGER PRIMARY KEY,
  id INTEGER NOT NULL REFERENCES subjects (id) ON DELETE CASCADE,
  position INTEGER,
  text TEXT NOT NULL,
  language TEXT,
  state TEXT,
  created NUMERIC NOT NULL DEFAULT CURRENT_TIMESTAMP,
  modified NUMERIC NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted NUMERIC
);

CREATE TABLE tags (
  tag_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE,
  color TEXT,
  created NUMERIC NOT NULL DEFAULT CURRENT_TIMESTAMP,
  modified NUMERIC NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (name)
);

CREATE TABLE taggings (
  tag_id INTEGER NOT NULL REFERENCES tags (tag_id) ON DELETE CASCADE,
  id INTEGER NOT NULL REFERENCES subjects (id) ON DELETE CASCADE,
  created NUMERIC NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id, tag_id)
);

CREATE TABLE trash (
  id INTEGER PRIMARY KEY REFERENCES subjects (id) ON DELETE CASCADE,
  reason TEXT NOT NULL DEFAULT 'user',
  deleted NUMERIC NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (reason IN ('user', 'auto', 'merge'))
);

CREATE TABLE transcriptions (
  transcription_id INTEGER PRIMARY KEY,
  id INTEGER NOT NULL REFERENCES images (id) ON DELETE CASCADE,
  text TEXT NOT NULL DEFAULT '',
  data TEXT,
  config TEXT,
  status INTEGER NOT NULL DEFAULT 0,
  created NUMERIC NOT NULL DEFAULT CURRENT_TIMESTAMP,
  modified NUMERIC NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted NUMERIC
);
`;

// MARK: - Écriture

function noteState(text: string): string {
  return JSON.stringify({
    doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
  });
}

/** Chemin du fichier SQLite d'un projet fabriqué (paquet ou .tpy nu). */
export function tpyDatabasePath(projectPath: string): string {
  return projectPath.endsWith('.tropy') ? path.join(projectPath, 'project.tpy') : projectPath;
}

/** Retire la base et ses fichiers de journal, nommément : réécrire un projet au même chemin. */
function removeDatabase(dbPath: string): void {
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

/**
 * Écrit un projet Tropy dans `dir` et rend le chemin à passer à `TropyReader`
 * (le dossier `.tropy` d'un paquet, sinon le `.tpy`).
 *
 * Un projet existant au même chemin est remplacé : c'est ainsi qu'un test
 * simule « l'historien a modifié son projet dans Tropy » entre deux synchros.
 * Les identifiants non fixés sont attribués dans l'ordre de la spécification
 * (item, ses photos, leurs sélections, item suivant…), à partir de 1 — un
 * même ordre donne donc les mêmes identifiants d'une réécriture à l'autre.
 */
export function makeTpy(dir: string, spec: TpySpec): string {
  const name = spec.name ?? 'Fonds de test';
  const fileStem = name.replace(/[^\p{L}\p{N}_-]+/gu, '-');

  let projectPath: string;
  if (spec.packaged) {
    projectPath = path.join(dir, `${fileStem}.tropy`);
    fs.mkdirSync(path.join(projectPath, 'assets'), { recursive: true });
  } else {
    fs.mkdirSync(dir, { recursive: true });
    projectPath = path.join(dir, `${fileStem}.tpy`);
  }
  const dbPath = tpyDatabasePath(projectPath);
  removeDatabase(dbPath);

  const db = new Database(dbPath);
  try {
    if (spec.wal) db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(DDL);
    writeContents(db, spec, name);
  } finally {
    db.close();
  }

  return projectPath;
}

/**
 * Ouvre en écriture un projet fabriqué par `makeTpy`, pour le modifier en
 * place (photo déplacée, note ajoutée) ou garder ouverte une connexion WAL
 * comme le fait Tropy. À fermer par l'appelant.
 */
export function openTpyForWrite(projectPath: string): Database.Database {
  const db = new Database(tpyDatabasePath(projectPath));
  db.pragma('foreign_keys = ON');
  return db;
}

function writeContents(db: Database.Database, spec: TpySpec, name: string): void {
  const insertProject = db.prepare(
    'INSERT INTO project (project_id, name, base, created, modified) VALUES (?, ?, ?, ?, ?)'
  );
  const insertSubject = db.prepare(
    'INSERT INTO subjects (id, template, type, created, modified) VALUES (?, ?, ?, ?, ?)'
  );
  const insertImage = db.prepare(
    'INSERT INTO images (id, width, height, angle) VALUES (?, ?, ?, ?)'
  );
  const insertItem = db.prepare('INSERT INTO items (id) VALUES (?)');
  const insertPhoto = db.prepare(
    `INSERT INTO photos (id, item_id, position, path, mimetype, checksum, filename, page)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertSelection = db.prepare(
    'INSERT INTO selections (id, photo_id, x, y, position) VALUES (?, ?, ?, ?, ?)'
  );
  const upsertValue = db.prepare(
    `INSERT INTO metadata_values (datatype, text) VALUES (?, ?)
     ON CONFLICT (datatype, text) DO UPDATE SET text = excluded.text
     RETURNING value_id`
  );
  const insertMetadata = db.prepare(
    'INSERT INTO metadata (id, property, value_id) VALUES (?, ?, ?)'
  );
  const insertNote = db.prepare(
    `INSERT INTO notes (id, position, text, state, created, modified, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const upsertTag = db.prepare(
    `INSERT INTO tags (name) VALUES (?)
     ON CONFLICT (name) DO UPDATE SET name = name
     RETURNING tag_id`
  );
  const insertTagging = db.prepare('INSERT INTO taggings (tag_id, id) VALUES (?, ?)');
  const insertTrash = db.prepare('INSERT INTO trash (id, reason) VALUES (?, ?)');
  const insertTranscription = db.prepare(
    `INSERT INTO transcriptions (id, text, status, created, modified, deleted)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const taken = new Set<number>();
  for (const item of spec.items) {
    if (item.id !== undefined) taken.add(item.id);
    for (const photo of item.photos ?? []) {
      if (photo.id !== undefined) taken.add(photo.id);
      for (const sel of photo.selections ?? []) if (sel.id !== undefined) taken.add(sel.id);
    }
  }
  let next = 1;
  const allocate = (fixed?: number): number => {
    if (fixed !== undefined) return fixed;
    while (taken.has(next)) next++;
    taken.add(next);
    return next;
  };

  const notes = (subjectId: number, list: TpyNoteSpec[] | undefined): void => {
    (list ?? []).forEach((n, position) => {
      insertNote.run(
        subjectId,
        position,
        n.text,
        n.state ?? noteState(n.text),
        FIXED_CREATED,
        FIXED_CREATED,
        n.deleted ? FIXED_CREATED : null
      );
    });
  };
  const transcriptions = (imageId: number, list: TpyTranscriptionSpec[] | undefined): void => {
    for (const t of list ?? []) {
      insertTranscription.run(
        imageId,
        t.text,
        t.status ?? 1,
        t.created ?? FIXED_CREATED,
        t.modified ?? t.created ?? FIXED_CREATED,
        t.deleted ? FIXED_CREATED : null
      );
    }
  };
  const metadata = (subjectId: number, property: string, text: string | undefined): void => {
    if (!text) return;
    const { value_id } = upsertValue.get('http://www.w3.org/2001/XMLSchema#string', text) as {
      value_id: number;
    };
    insertMetadata.run(subjectId, property, value_id);
  };

  db.transaction(() => {
    insertProject.run(spec.projectId, name, spec.base ?? null, FIXED_CREATED, FIXED_CREATED);

    for (const item of spec.items) {
      const itemId = allocate(item.id);
      insertSubject.run(
        itemId,
        item.template ?? GENERIC_TEMPLATE,
        item.type ?? null,
        FIXED_CREATED,
        item.modified ?? DEFAULT_MODIFIED
      );
      insertItem.run(itemId);

      metadata(itemId, `${DC}title`, item.title);
      metadata(itemId, `${DC}date`, item.date);
      metadata(itemId, `${DC}creator`, item.creator);
      for (const [property, text] of Object.entries(item.metadata ?? {})) {
        metadata(itemId, property, text);
      }
      for (const tag of item.tags ?? []) {
        const { tag_id } = upsertTag.get(tag) as { tag_id: number };
        insertTagging.run(tag_id, itemId);
      }
      notes(itemId, item.notes);
      if (item.trash) insertTrash.run(itemId, item.trash);

      (item.photos ?? []).forEach((photo, position) => {
        const photoId = allocate(photo.id);
        insertSubject.run(photoId, GENERIC_TEMPLATE, null, FIXED_CREATED, FIXED_CREATED);
        insertImage.run(photoId, photo.width ?? 1200, photo.height ?? 1600, 0);
        insertPhoto.run(
          photoId,
          itemId,
          position,
          photo.path,
          photo.mimetype ?? guessMimetype(photo.path),
          `checksum-${photoId}`,
          photo.filename ?? path.basename(photo.path),
          photo.page ?? 0
        );
        notes(photoId, photo.notes);
        transcriptions(photoId, photo.transcriptions);
        if (photo.trash) insertTrash.run(photoId, photo.trash);

        (photo.selections ?? []).forEach((sel, selPosition) => {
          const selId = allocate(sel.id);
          insertSubject.run(selId, GENERIC_TEMPLATE, null, FIXED_CREATED, FIXED_CREATED);
          insertImage.run(selId, sel.width ?? 100, sel.height ?? 100, sel.angle ?? 0);
          insertSelection.run(selId, photoId, sel.x ?? 0, sel.y ?? 0, selPosition);
          notes(selId, sel.notes);
          transcriptions(selId, sel.transcriptions);
          if (sel.trash) insertTrash.run(selId, sel.trash);
        });
      });
    }
  })();
}

function guessMimetype(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff';
  return 'image/jpeg';
}
