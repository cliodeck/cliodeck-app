/**
 * Bilan de santé d'un projet ClioDeck — vérifications.
 *
 * Les défauts graves du cycle rc.5 étaient silencieux : 221 documents pour 55
 * PDF, un OCR de 24 h jeté, une bibliographie à 70/69/67 entrées. Rien ne
 * plantait, mais un invariant simple était violé — « ce qui doit être égal
 * l'est-il ? ». Ce module les vérifie, en **lecture seule stricte** : la base
 * est ouverte `immutable` (aucun fichier -wal/-shm créé, rien d'écrit), les
 * fichiers du projet ne sont que lus.
 *
 * Chaque constat a un niveau :
 *   - `ok`    : l'invariant tient ;
 *   - `ecart` : il ne tient pas — pas forcément un bug, mais il faut une
 *               explication (l'`aide` en propose une quand elle est connue) ;
 *   - `info`  : un état à connaître, qui n'est pas une anomalie.
 */

import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const IGNORED_DIRS = new Set(['.cliodeck', '.git', 'node_modules', '.obsidian', '.trash']);

/** Ouvre brain.db sans jamais rien écrire à côté. */
export async function openBrainDb(dbPath) {
  const { DatabaseSync } = await import('node:sqlite');
  const url = pathToFileURL(dbPath);
  // Une base WAL encore ouverte par l'app a des pages non reportées dans le
  // fichier principal : `immutable` les ignorerait. Dans ce cas seulement,
  // ouverture en lecture seule classique (les fichiers -wal/-shm existent déjà).
  const wal = `${dbPath}-wal`;
  const walPending = existsSync(wal) && statSync(wal).size > 0;
  if (!walPending) url.searchParams.set('immutable', '1');
  return { db: new DatabaseSync(url, { readOnly: true }), walPending };
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

/** Chemin réel (liens résolus, casse du disque), ou le chemin tel quel s'il n'existe pas. */
function fileIdentity(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

function listFiles(root, predicate, dir = root, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) listFiles(root, predicate, path.join(dir, entry.name), out);
    } else if (predicate(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** Clés d'entrées d'un .bib, sans @comment / @string / @preamble. */
export function bibEntryKeys(bibText) {
  const keys = [];
  const re = /^@(\w+)\s*[{(]\s*([^,\s]+)\s*,/gm;
  let m;
  while ((m = re.exec(bibText))) {
    if (!/^(comment|string|preamble)$/i.test(m[1])) keys.push(m[2]);
  }
  return keys;
}

/**
 * Chemins des PDF rattachés à une entrée de la bibliographie — les seuls que
 * l'app propose à l'indexation : champ `file` du .bib (résolu comme
 * `BibTeXParser.resolveFilePath`), ou pièce jointe Zotero téléchargée
 * conservée dans bibliography-metadata.json. Un PDF du dossier absent de cet
 * ensemble n'est pas un échec d'indexation : rien ne l'a jamais demandée.
 */
export function attachedPdfPaths(projectPath, project) {
  const attached = new Set();
  const bibRel = project.bibliographySource?.filePath ?? (project.bibliography ? path.relative(projectPath, project.bibliography) : null);
  const bibPath = bibRel ? path.resolve(projectPath, bibRel) : null;
  if (bibPath && existsSync(bibPath)) {
    const re = /^\s*file\s*=\s*[{"](.*)[}"]\s*,?\s*$/gim;
    const text = readFileSync(bibPath, 'utf8');
    let m;
    while ((m = re.exec(text))) {
      let field = m[1].replace(/[{}]/g, '');
      const parts = field.split(':');
      if (parts.length >= 3) field = parts[1];
      else if (parts.length === 2) field = parts[1].includes('/') ? parts[0] : parts[1];
      attached.add(fileIdentity(path.isAbsolute(field) ? field : path.resolve(path.dirname(bibPath), field)));
    }
  }
  const metaPath = path.join(projectPath, '.cliodeck', 'bibliography-metadata.json');
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      for (const entry of Object.values(meta.citations ?? {})) {
        for (const att of entry.zoteroAttachments ?? []) {
          if (att.downloaded && att.localPath) attached.add(fileIdentity(att.localPath));
        }
      }
    } catch {
      // Illisible : signalé dans la section bibliographie.
    }
  }
  return attached;
}

function duplicates(values) {
  const seen = new Set();
  const dup = new Set();
  for (const v of values) (seen.has(v) ? dup : seen).add(v);
  return [...dup];
}

const sample = (list, n = 5) =>
  list.length <= n ? list.join(', ') : `${list.slice(0, n).join(', ')} … (+${list.length - n})`;

export function runHealthChecks(projectPath, db) {
  const findings = [];
  const add = (domaine, niveau, message, aide) => findings.push({ domaine, niveau, message, aide });

  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
  );
  const has = (t) => tables.has(t);
  const count = (sql, ...params) => Number(db.prepare(sql).get(...params)?.n ?? 0);

  // ── Projet ────────────────────────────────────────────────────────────
  let project = {};
  const projectJson = path.join(projectPath, 'project.json');
  if (existsSync(projectJson)) {
    try {
      project = JSON.parse(readFileSync(projectJson, 'utf8'));
      add('projet', 'info', `« ${project.name ?? '?'} », type ${project.type ?? '?'}`);
    } catch {
      add('projet', 'ecart', 'project.json illisible');
    }
  } else {
    add('projet', 'ecart', 'project.json absent : est-ce bien la racine d’un projet ?');
  }

  // ── Sources secondaires (PDF) ─────────────────────────────────────────
  if (has('pdf_documents')) {
    const docs = db.prepare('SELECT id, file_path FROM pdf_documents').all();
    const paths = docs.map((d) => d.file_path);
    // Un fichier s'identifie par son chemin réel, pas par la chaîne (#123) :
    // sur macOS, deux chemins qui ne diffèrent que par la casse désignent le
    // même fichier, et tous deux « existent ».
    const identities = paths.map((p) => fileIdentity(p));
    const distinct = new Set(identities);
    if (docs.length === 0) {
      add('pdf', 'info', 'aucun PDF indexé');
    } else if (distinct.size === docs.length) {
      add('pdf', 'ok', `${docs.length} document(s), un par fichier`);
    } else {
      const dups = duplicates(identities).map((p) => path.basename(p));
      add(
        'pdf',
        'ecart',
        `${docs.length} documents pour ${distinct.size} fichiers — doublons : ${sample(dups)}`,
        'Ouvrir le projet avec la rc.5 ou plus retire les doublons (et, depuis la rc.6, ceux dont les chemins ne diffèrent que par la casse), après une sauvegarde brain.db.avant-dedoublonnage-<date>.',
      );
    }

    const missing = [...new Set(paths)].filter((p) => p && !existsSync(p));
    if (missing.length) {
      add('pdf', 'ecart', `${missing.length} document(s) indexé(s) dont le fichier n’existe plus : ${sample(missing.map((p) => path.basename(p)))}`, 'Fichier déplacé, renommé ou supprimé après indexation.');
    }

    const onDisk = listFiles(projectPath, (n) => /\.pdf$/i.test(n)).map((p) => fileIdentity(path.resolve(p)));
    const notIndexed = onDisk.filter((p) => !distinct.has(p));
    add('pdf', 'info', `${onDisk.length} PDF dans le dossier du projet, dont ${notIndexed.length} non indexé(s)`);
    // Non indexé ne veut pas dire échec : l'app n'indexe que les PDF rattachés
    // à une entrée. Mesuré sur un projet réel, les 7 « non indexés » d'un
    // numéro spécial n'étaient tout simplement pas dans la bibliographie.
    const attached = attachedPdfPaths(projectPath, project);
    const neverAsked = notIndexed.filter((p) => !attached.has(p));
    const failed = notIndexed.filter((p) => attached.has(p));
    if (neverAsked.length) {
      add('pdf', 'info', `${neverAsked.length} PDF non rattaché(s) à la bibliographie, donc jamais proposé(s) à l’indexation : ${sample(neverAsked.map((p) => path.basename(p)))}`, 'L’app n’indexe que les PDF rattachés à une entrée (champ file du .bib, ou pièce jointe Zotero téléchargée). Pour les citer : ajouter les références à Zotero puis synchroniser ; pour seulement les interroger : les glisser dans le panneau d’index des PDF.');
    }
    if (failed.length) {
      add('pdf', 'ecart', `${failed.length} PDF rattaché(s) à la bibliographie mais non indexé(s) : ${sample(failed.map((p) => path.basename(p)))}`, 'Lancer « Indexer tous les PDFs ». Si l’écart persiste, l’indexation échoue pour ces fichiers : lancer l’app depuis un terminal pour lire l’erreur, ou tester l’extraction avec scripts/pdf-extraction-snapshot.mjs.');
    }

    if (has('pdf_chunks') && docs.length > 0) {
      const chunks = count('SELECT COUNT(*) n FROM pdf_chunks');
      const noEmb = count('SELECT COUNT(*) n FROM pdf_chunks WHERE embedding IS NULL OR length(embedding) = 0');
      const orphans = count('SELECT COUNT(*) n FROM pdf_chunks c WHERE NOT EXISTS (SELECT 1 FROM pdf_documents d WHERE d.id = c.document_id)');
      const empty = count('SELECT COUNT(*) n FROM pdf_documents d WHERE NOT EXISTS (SELECT 1 FROM pdf_chunks c WHERE c.document_id = d.id)');
      add('pdf', noEmb ? 'ecart' : 'ok', `${chunks} extrait(s), ${noEmb} sans embedding`, noEmb ? 'Extraits invisibles de la recherche sémantique : réindexer les documents concernés.' : undefined);
      if (orphans) add('pdf', 'ecart', `${orphans} extrait(s) orphelin(s), sans document`);
      if (empty) add('pdf', 'ecart', `${empty} document(s) sans aucun extrait`, 'Indexation interrompue, ou PDF sans texte (scan non OCRisé).');

      const meta = path.join(projectPath, '.cliodeck', 'hnsw.index.meta.json');
      if (existsSync(meta) && chunks > 0) {
        try {
          const m = JSON.parse(readFileSync(meta, 'utf8'));
          const ids = new Set((m.chunkIdMap ?? []).map((e) => e[1]));
          const known = new Set(db.prepare('SELECT id FROM pdf_chunks WHERE embedding IS NOT NULL').all().map((r) => r.id));
          const stale = [...ids].filter((id) => !known.has(id)).length;
          const absent = [...known].filter((id) => !ids.has(id)).length;
          if (!stale && !absent) add('pdf', 'ok', `index HNSW aligné sur la base (${ids.size} vecteurs)`);
          else add('pdf', 'ecart', `index HNSW : ${stale} vecteur(s) d’extraits disparus, ${absent} extrait(s) absent(s) de l’index`, 'Attendu juste après une suppression ou un dédoublonnage : l’index se reconstruit une fois l’indexation terminée. Persistant après relance = anomalie.');
        } catch {
          add('pdf', 'ecart', 'hnsw.index.meta.json illisible');
        }
      }
    }

    // Collections Zotero (#130) : un projet qui suit une collection doit
    // voir ses documents rattachés, sans quoi le filtre par collection de
    // l'assistant ne trouve rien.
    const projectCollection = project.zotero?.collectionKey ?? project.bibliographySource?.zoteroCollection;
    if (projectCollection && docs.length > 0 && has('pdf_document_collections') && has('pdf_zotero_collections')) {
      const collections = count('SELECT COUNT(*) n FROM pdf_zotero_collections');
      const unlinked = count('SELECT COUNT(*) n FROM pdf_documents d WHERE NOT EXISTS (SELECT 1 FROM pdf_document_collections l WHERE l.document_id = d.id)');
      const used = count('SELECT COUNT(DISTINCT collection_key) n FROM pdf_document_collections');
      if (unlinked === 0) {
        add('pdf', 'ok', `chaque document est rattaché à une collection Zotero (${used} collection(s) utilisée(s) sur ${collections})`);
      } else {
        add(
          'pdf',
          'ecart',
          `${unlinked}/${docs.length} document(s) rattaché(s) à aucune collection Zotero`,
          'Le filtre par collection de l’assistant ignore ces documents. Avant la rc.6-beta.3, les PDF indexés après la synchronisation n’étaient jamais rattachés (#130) : relancer « Synchroniser avec Zotero ». Une référence hors de toute collection reste possible.',
        );
      }
      if (has('pdf_zotero_collections')) {
        const byKey = new Map(db.prepare('SELECT key, parent_key FROM pdf_zotero_collections').all().map((r) => [r.key, r.parent_key]));
        const dangling = [...byKey.values()].filter((p) => p && !byKey.has(p)).length;
        if (dangling) add('pdf', 'ecart', `${dangling} collection(s) dont la collection parente est absente`, 'Arbre incomplet : le filtre récursif perd des branches. Relancer « Synchroniser avec Zotero ».');
        if (!byKey.has(projectCollection)) add('pdf', 'ecart', 'la collection Zotero du projet est absente de la base', 'Relancer « Synchroniser avec Zotero ».');
      }
    }
  }

  // ── Bibliographie ─────────────────────────────────────────────────────
  const bibRel = project.bibliographySource?.filePath ?? (project.bibliography ? path.relative(projectPath, project.bibliography) : null);
  const bibPath = bibRel ? path.resolve(projectPath, bibRel) : null;
  if (bibPath && existsSync(bibPath)) {
    const keys = bibEntryKeys(readFileSync(bibPath, 'utf8'));
    const dupKeys = duplicates(keys);
    add('bibliographie', dupKeys.length ? 'ecart' : 'ok', `${keys.length} entrée(s) dans ${path.basename(bibPath)}${dupKeys.length ? `, clés en double : ${sample(dupKeys)}` : ', clés uniques'}`, dupKeys.length ? 'Deux entrées sous une même clé : pandoc n’en citera qu’une.' : undefined);

    const invalid = keys.filter((k) => !/^[A-Za-z0-9_:.+-]+$/.test(k));
    if (invalid.length) add('bibliographie', 'ecart', `${invalid.length} clé(s) hors ASCII sûr : ${sample(invalid)}`, 'Pandoc peut rejeter tout le fichier. « Synchroniser avec Zotero » refait ces clés depuis la rc.5.');

    const metaPath = path.join(projectPath, '.cliodeck', 'bibliography-metadata.json');
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        const entries = meta.citations ?? {};
        const metaIds = Object.values(entries).map((e) => e.id ?? '').filter(Boolean);
        const keySet = new Set(keys);
        const withoutBib = metaIds.filter((id) => !keySet.has(id));
        add('bibliographie', 'info', `${Object.keys(entries).length} fiche(s) de métadonnées (pièces jointes, tags Zotero), schéma v${meta.version ?? '?'}`);
        if (withoutBib.length) add('bibliographie', 'ecart', `${withoutBib.length} fiche(s) sans entrée dans le .bib : ${sample(withoutBib)}`, 'Référence retirée du .bib, ou clé renommée : la fiche est orpheline.');

        // Un même fichier ne peut pas être le PDF de deux références (#131) :
        // c'est la trace d'une pièce jointe écrasée par une autre de même nom.
        const referencesByFile = new Map();
        for (const entry of Object.values(entries)) {
          for (const att of entry.zoteroAttachments ?? []) {
            if (!att.downloaded || !att.localPath) continue;
            const id = fileIdentity(att.localPath);
            const refs = referencesByFile.get(id) ?? new Set();
            refs.add(entry.id ?? '?');
            referencesByFile.set(id, refs);
          }
        }
        const shared = [...referencesByFile].filter(([, refs]) => refs.size > 1);
        if (shared.length) {
          add(
            'bibliographie',
            'ecart',
            `${shared.length} fichier(s) PDF rattaché(s) à plusieurs références : ${sample(shared.map(([p, refs]) => `${path.basename(p)} ← ${[...refs].join(' + ')}`), 3)}`,
            'Pièces jointes Zotero de même nom (exports Europresse…) : avant la rc.6-beta.3, la seconde écrasait la première (#131). Une seule de ces références a son vrai PDF : retélécharger les autres depuis leur fiche.',
          );
        }
      } catch {
        add('bibliographie', 'ecart', 'bibliography-metadata.json illisible');
      }
    }
    add('bibliographie', 'info', 'comparaison avec la collection Zotero non faite (le bilan ne lit pas Zotero)');
  } else if (bibRel) {
    add('bibliographie', 'ecart', `fichier de bibliographie déclaré mais absent : ${bibRel}`);
  }

  // ── Sources primaires (Tropy) ─────────────────────────────────────────
  if (has('tropy_sources')) {
    const sources = count('SELECT COUNT(*) n FROM tropy_sources');
    if (has('tropy_projects')) {
      const rows = db.prepare('SELECT tpy_path, COUNT(*) n FROM tropy_projects GROUP BY tpy_path').all();
      for (const r of rows) {
        if (r.n > 1) add('tropy', 'ecart', `${r.n} lignes pour le même projet Tropy (${path.basename(r.tpy_path)})`, 'Héritage des synchronisations antérieures à la rc.5 : la prochaine synchronisation les fond.');
        if (!existsSync(r.tpy_path)) add('tropy', 'ecart', `projet Tropy lié introuvable : ${r.tpy_path}`);
      }
      if (rows.length > 1) add('tropy', 'info', `${rows.length} projets Tropy différents liés`);
    }
    if (sources === 0) {
      add('tropy', 'info', 'aucune source primaire');
    } else {
      const withTx = count("SELECT COUNT(*) n FROM tropy_sources WHERE coalesce(length(transcription), 0) > 0");
      add('tropy', 'info', `${sources} source(s), ${withTx} avec transcription`);
      const txNoChunk = count("SELECT COUNT(*) n FROM tropy_sources s WHERE coalesce(length(s.transcription), 0) > 0 AND NOT EXISTS (SELECT 1 FROM tropy_chunks c WHERE c.source_id = s.id)");
      add('tropy', txNoChunk ? 'ecart' : 'ok', txNoChunk ? `${txNoChunk} source(s) transcrite(s) sans aucun extrait` : 'chaque source transcrite a ses extraits', txNoChunk ? 'Transcription présente mais introuvable par la recherche : c’est la signature du défaut d’août (réenregistrement en cascade).' : undefined);
      const chunks = count('SELECT COUNT(*) n FROM tropy_chunks');
      const noEmb = count('SELECT COUNT(*) n FROM tropy_chunks WHERE embedding IS NULL OR length(embedding) = 0');
      const orphans = count('SELECT COUNT(*) n FROM tropy_chunks c WHERE NOT EXISTS (SELECT 1 FROM tropy_sources s WHERE s.id = c.source_id)');
      add('tropy', noEmb ? 'ecart' : 'ok', `${chunks} extrait(s), ${noEmb} sans embedding`);
      if (orphans) add('tropy', 'ecart', `${orphans} extrait(s) orphelin(s), sans source`);

      const meta = path.join(projectPath, '.cliodeck', 'primary-hnsw.index.meta.json');
      if (existsSync(meta)) {
        try {
          const m = JSON.parse(readFileSync(meta, 'utf8'));
          const size = Number(m.currentSize ?? (m.labelMap ?? []).length);
          const withEmb = chunks - noEmb;
          add('tropy', size === withEmb ? 'ok' : 'ecart', `index HNSW : ${size} vecteur(s) pour ${withEmb} extrait(s) avec embedding`, size === withEmb ? undefined : 'Écart persistant après une synchronisation complète = index à reconstruire.');
        } catch {
          add('tropy', 'ecart', 'primary-hnsw.index.meta.json illisible');
        }
      }
    }
  }

  // ── Manuscrit ─────────────────────────────────────────────────────────
  const pieces = [];
  if (project.type === 'book' && Array.isArray(project.chapters) && project.chapters.length) {
    for (const ch of project.chapters) if (ch?.filePath) pieces.push(ch.filePath);
  } else {
    for (const candidate of ['document.md', 'slides.md']) {
      if (existsSync(path.join(projectPath, candidate))) {
        pieces.push(candidate);
        break;
      }
    }
  }
  const missingPieces = pieces.filter((p) => !existsSync(path.join(projectPath, p)));
  if (missingPieces.length) add('manuscrit', 'ecart', `${missingPieces.length} pièce(s) du manifeste absente(s) du disque : ${sample(missingPieces)}`);
  if (!has('manuscript_chapters')) {
    add('manuscrit', 'info', 'corpus manuscrit jamais indexé dans ce projet');
  } else {
    const rows = new Map(db.prepare('SELECT relative_path, content_hash FROM manuscript_chapters').all().map((r) => [r.relative_path, r.content_hash]));
    const present = pieces.filter((p) => existsSync(path.join(projectPath, p)));
    if (rows.size === 0 && present.length) {
      add('manuscrit', 'info', `${present.length} pièce(s), aucune indexée (corpus manuscrit désactivé ?)`);
    } else if (present.length) {
      const stale = present.filter((p) => rows.get(p) !== sha256(readFileSync(path.join(projectPath, p), 'utf8')));
      const notIndexed = present.filter((p) => !rows.has(p));
      add('manuscrit', stale.length ? 'ecart' : 'ok', stale.length ? `${stale.length}/${present.length} pièce(s) dont l’index ne correspond pas au texte : ${sample(stale)}${notIndexed.length ? ` (dont ${notIndexed.length} jamais indexée(s))` : ''}` : `${present.length} pièce(s), index à jour`, stale.length ? 'Normal si le texte a changé depuis la dernière sauvegarde dans l’app ; sinon l’indexation après sauvegarde a échoué.' : undefined);
      const extra = [...rows.keys()].filter((p) => !present.includes(p));
      if (extra.length) add('manuscrit', 'ecart', `${extra.length} pièce(s) indexée(s) qui ne font plus partie du manuscrit : ${sample(extra)}`, 'L’assistant peut citer un texte retiré.');
      const noEmb = count('SELECT COUNT(*) n FROM manuscript_chunks WHERE embedding IS NULL OR length(embedding) = 0');
      if (noEmb) add('manuscrit', 'ecart', `${noEmb} extrait(s) du manuscrit sans embedding`);
    }
  }

  // ── Notes de lecture ──────────────────────────────────────────────────
  const notesDir = path.join(projectPath, 'reading-notes');
  const noteFiles = existsSync(notesDir) ? readdirSync(notesDir).filter((n) => n.endsWith('.md')) : [];
  if (noteFiles.length === 0) {
    add('notes', 'info', 'aucune note de lecture');
  } else if (!has('reading_notes')) {
    add('notes', 'info', `${noteFiles.length} note(s) de lecture, corpus jamais indexé`);
  } else {
    const rows = db.prepare('SELECT relative_path, content_hash FROM reading_notes').all();
    const byPath = new Map(rows.map((r) => [r.relative_path.split(path.sep).join('/'), r.content_hash]));
    const stale = noteFiles.filter((n) => {
      const rel = `reading-notes/${n}`;
      const h = byPath.get(rel) ?? byPath.get(n);
      return h !== sha256(readFileSync(path.join(notesDir, n), 'utf8'));
    });
    add('notes', stale.length ? 'ecart' : 'ok', stale.length ? `${stale.length}/${noteFiles.length} note(s) non indexée(s) ou modifiée(s) depuis : ${sample(stale)}` : `${noteFiles.length} note(s), index à jour`, stale.length ? 'Normal juste après une modification hors de l’app. Si les embeddings passent par un service en ligne (ou un Ollama distant), les notes ne sont indexées qu’avec l’option « Envoyer les notes de lecture aux modèles en ligne ». Sinon, lancer la réindexation des notes.' : undefined);
    const noEmb = has('reading_notes_chunks') ? count('SELECT COUNT(*) n FROM reading_notes_chunks WHERE embedding IS NULL OR length(embedding) = 0') : 0;
    if (noEmb) add('notes', 'ecart', `${noEmb} extrait(s) de notes sans embedding`);
  }

  // ── Voûte Obsidian ────────────────────────────────────────────────────
  if (has('obsidian_notes')) {
    const notes = count('SELECT COUNT(*) n FROM obsidian_notes');
    if (notes) {
      const noEmb = count('SELECT COUNT(*) n FROM obsidian_chunks WHERE embedding IS NULL OR length(embedding) = 0');
      add('obsidian', noEmb ? 'ecart' : 'ok', `${notes} note(s), ${count('SELECT COUNT(*) n FROM obsidian_chunks')} extrait(s), ${noEmb} sans embedding`);
    }
  }

  return findings;
}
