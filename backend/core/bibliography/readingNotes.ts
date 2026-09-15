import { existsSync } from 'fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';

/**
 * Notes de lecture : un fichier Markdown par référence, dans un dossier
 * visible du projet.
 *
 * C'est la part **du projet** sur une référence, par opposition à ce qui
 * appartient à Zotero (métadonnées, tags, notes Zotero, en lecture seule dans
 * ClioDeck). Un fichier plutôt qu'un champ de formulaire : une note
 * d'historien est un texte, parfois long, qu'on relit ailleurs (Obsidian, un
 * éditeur quelconque), qu'on versionne, et que l'assistant pourra un jour
 * consulter comme corpus. Jamais dans le `.bib`, qui voyage (revue, co-auteur,
 * dépôt) et dont le champ `note` est bibliographique.
 *
 * Le front matter porte l'identité et les étiquettes du projet :
 *
 *     ---
 *     citekey: Braudel_1949
 *     zotero_key: ABCD1234
 *     title: La Méditerranée
 *     tags:
 *       - chapitre-2
 *     ---
 *
 * `tags` est la clé que lit Obsidian. La référence se retrouve par
 * `zotero_key` d'abord — stable —, par `citekey` ensuite : le nom du fichier
 * n'est qu'une commodité, qu'on peut changer à la main sans rien casser.
 *
 * **Remontée vers Zotero (non implémentée).** Tout est en place pour l'ajouter
 * sans migration : chaque note connaît la clé Zotero de sa notice, et les
 * étiquettes du projet restent distinctes des tags Zotero. Un futur
 * « envoyer vers Zotero » (API web, clé autorisée en écriture ; jamais la
 * base locale, que Zotero interdit d'écrire) lirait ces fichiers et
 * pousserait `tags` comme tags Zotero, le corps comme note enfant.
 */

/** Dossier des notes, à la racine du projet — comme `chapters/`. */
export const READING_NOTES_DIR = 'reading-notes';

/** Ce qui identifie une référence de la bibliographie. */
export interface ReferenceIdentity {
  citekey: string;
  zoteroKey?: string;
  title?: string;
  /** Libellé humain pour le titre du fichier (« Braudel, Fernand »). */
  author?: string;
  year?: string;
}

export interface ReadingNoteInfo {
  /** Chemin absolu du fichier. */
  file: string;
  citekey: string;
  zoteroKey?: string;
  /** Étiquettes du projet. */
  tags: string[];
}

interface ParsedNote {
  frontMatter: Record<string, unknown>;
  body: string;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Sépare front matter et corps. Un front matter illisible lève une erreur :
 * le réécrire ferait perdre ce que l'utilisateur y a mis à la main.
 */
function parseNote(content: string): ParsedNote {
  const match = content.match(FRONT_MATTER);
  if (!match) return { frontMatter: {}, body: content };
  // Schéma « core » : pas de conversion des dates. Le schéma par défaut
  // changeait `lu_le: 2026-09-14`, saisi à la main, en horodatage complet.
  const loaded = yaml.load(match[1], { schema: yaml.CORE_SCHEMA });
  const frontMatter =
    loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? (loaded as Record<string, unknown>) : {};
  return { frontMatter, body: content.slice(match[0].length) };
}

function serializeNote({ frontMatter, body }: ParsedNote): string {
  // Ordre lisible d'abord, puis ce que l'utilisateur a ajouté, intact.
  const ordered: Record<string, unknown> = {};
  for (const key of ['citekey', 'zotero_key', 'title', 'tags']) {
    if (frontMatter[key] !== undefined) ordered[key] = frontMatter[key];
  }
  for (const [key, value] of Object.entries(frontMatter)) {
    if (!(key in ordered)) ordered[key] = value;
  }
  const header = yaml.dump(ordered, { lineWidth: -1, schema: yaml.CORE_SCHEMA }).trimEnd();
  return `---\n${header}\n---\n${body.startsWith('\n') ? body : `\n${body}`}`;
}

function tagsOf(frontMatter: Record<string, unknown>): string[] {
  const raw = frontMatter.tags;
  if (Array.isArray(raw)) return raw.map(String).map((t) => t.trim()).filter(Boolean);
  if (typeof raw === 'string') return raw.split(',').map((t) => t.trim()).filter(Boolean);
  return [];
}

/** Nom de fichier sûr sur tous les systèmes (`:` est interdit sous Windows). */
export function noteFileName(citekey: string): string {
  const safe = citekey.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^[.-]+/, '');
  return `${safe || 'reference'}.md`;
}

async function writeAtomically(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, content, 'utf-8');
  await rename(temporary, file);
}

/**
 * Toutes les notes de lecture du projet. Les fichiers sans identité
 * (ni `citekey` ni `zotero_key`) ou au front matter illisible sont ignorés :
 * ils ne sont pas, ou plus, des notes que ClioDeck sait rattacher.
 */
export async function listReadingNotes(projectPath: string): Promise<ReadingNoteInfo[]> {
  const dir = path.join(projectPath, READING_NOTES_DIR);
  if (!existsSync(dir)) return [];

  const notes: ReadingNoteInfo[] = [];
  for (const name of await readdir(dir)) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    const file = path.join(dir, name);
    try {
      const { frontMatter } = parseNote(await readFile(file, 'utf-8'));
      const citekey = typeof frontMatter.citekey === 'string' ? frontMatter.citekey : undefined;
      const zoteroKey = typeof frontMatter.zotero_key === 'string' ? frontMatter.zotero_key : undefined;
      if (!citekey && !zoteroKey) continue;
      notes.push({ file, citekey: citekey ?? '', zoteroKey, tags: tagsOf(frontMatter) });
    } catch (error) {
      console.warn(`⚠️ Note de lecture illisible, ignorée : ${name}`, error);
    }
  }
  return notes;
}

/** Contenu d'une note de lecture, pour l'indexer. */
export interface ReadingNoteContent extends ReadingNoteInfo {
  /** Titre de la référence, tel qu'écrit dans le front matter. */
  title?: string;
  /** Corps de la note, sans le front matter. */
  body: string;
  /** Ligne (1-indexée) du fichier où commence le corps. */
  bodyStartLine: number;
}

/**
 * Lit une note de lecture. `null` si le fichier n'est pas une note que
 * ClioDeck sait rattacher (ni `citekey` ni `zotero_key`) ; lève si le front
 * matter est illisible.
 */
export async function readReadingNote(file: string): Promise<ReadingNoteContent | null> {
  const content = await readFile(file, 'utf-8');
  const { frontMatter, body } = parseNote(content);
  const citekey = typeof frontMatter.citekey === 'string' ? frontMatter.citekey : undefined;
  const zoteroKey = typeof frontMatter.zotero_key === 'string' ? frontMatter.zotero_key : undefined;
  if (!citekey && !zoteroKey) return null;
  const headerLines = content.slice(0, content.length - body.length).split('\n').length;
  return {
    file,
    citekey: citekey ?? '',
    zoteroKey,
    tags: tagsOf(frontMatter),
    title: typeof frontMatter.title === 'string' ? frontMatter.title : undefined,
    body,
    bodyStartLine: headerLines,
  };
}

/** La note d'une référence : par clé Zotero d'abord, par clé de citation ensuite. */
export function findReadingNote(
  notes: ReadingNoteInfo[],
  reference: Pick<ReferenceIdentity, 'citekey' | 'zoteroKey'>
): ReadingNoteInfo | undefined {
  if (reference.zoteroKey) {
    const byZotero = notes.find((n) => n.zoteroKey === reference.zoteroKey);
    if (byZotero) return byZotero;
  }
  return notes.find((n) => n.citekey === reference.citekey && (!n.zoteroKey || !reference.zoteroKey));
}

function identityFrontMatter(reference: ReferenceIdentity): Record<string, unknown> {
  const fm: Record<string, unknown> = { citekey: reference.citekey };
  if (reference.zoteroKey) fm.zotero_key = reference.zoteroKey;
  if (reference.title) fm.title = reference.title;
  return fm;
}

function template(reference: ReferenceIdentity): string {
  const who = reference.author ? `${reference.author} — ` : '';
  const when = reference.year ? ` (${reference.year})` : '';
  return `\n# ${who}${reference.title ?? reference.citekey}${when}\n\n`;
}

/**
 * Chemin de la note de la référence, créée si elle n'existe pas. Une note
 * existante n'est jamais réécrite ici.
 */
export async function ensureReadingNote(projectPath: string, reference: ReferenceIdentity): Promise<string> {
  const existing = findReadingNote(await listReadingNotes(projectPath), reference);
  if (existing) return existing.file;

  let file = path.join(projectPath, READING_NOTES_DIR, noteFileName(reference.citekey));
  if (existsSync(file)) {
    // Un front matter cassé rend la note invisible à `listReadingNotes`.
    // Créer une seconde note à côté ferait croire la première perdue : on
    // s'arrête et on le dit.
    try {
      parseNote(await readFile(file, 'utf-8'));
    } catch {
      throw new Error(
        `${path.basename(file)} a un en-tête (front matter) illisible : corrigez-le avant d'y revenir depuis ClioDeck.`
      );
    }
  }
  // Un fichier de même nom sans identité ClioDeck (écrit à la main) ne se
  // remplace pas : on en choisit un autre.
  for (let n = 2; existsSync(file); n++) {
    file = path.join(projectPath, READING_NOTES_DIR, noteFileName(`${reference.citekey}-${n}`));
  }
  await writeAtomically(file, serializeNote({ frontMatter: identityFrontMatter(reference), body: template(reference) }));
  return file;
}

/**
 * Remplace les étiquettes du projet d'une référence. Crée la note au besoin ;
 * garde intacts le corps et tout ce que l'utilisateur a ajouté au front
 * matter.
 */
export async function setProjectTags(
  projectPath: string,
  reference: ReferenceIdentity,
  tags: string[]
): Promise<ReadingNoteInfo> {
  const file = await ensureReadingNote(projectPath, reference);
  const note = parseNote(await readFile(file, 'utf-8'));

  const cleaned = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
  if (cleaned.length > 0) note.frontMatter.tags = cleaned;
  else delete note.frontMatter.tags;
  // La note rattrape l'identité courante (clé refaite, clé Zotero apparue).
  note.frontMatter.citekey = reference.citekey;
  if (reference.zoteroKey) note.frontMatter.zotero_key = reference.zoteroKey;

  await writeAtomically(file, serializeNote(note));
  return { file, citekey: reference.citekey, zoteroKey: reference.zoteroKey, tags: cleaned };
}

/**
 * Suit les clés de citation refaites par la synchronisation : met à jour le
 * front matter et renomme le fichier, sauf si son nom a été changé à la main
 * ou si le nouveau nom est déjà pris. Une note n'est jamais supprimée, même
 * quand sa référence sort de la bibliographie : c'est le travail de
 * l'historien.
 */
export async function followRenamedCitekeys(
  projectPath: string,
  renames: Array<{ zoteroKey: string; from: string; to: string }>
): Promise<void> {
  if (renames.length === 0) return;
  const notes = await listReadingNotes(projectPath);

  for (const { zoteroKey, from, to } of renames) {
    const note = findReadingNote(notes, { citekey: from, zoteroKey });
    if (!note) continue;

    const parsed = parseNote(await readFile(note.file, 'utf-8'));
    parsed.frontMatter.citekey = to;
    await writeAtomically(note.file, serializeNote(parsed));

    const target = path.join(path.dirname(note.file), noteFileName(to));
    if (path.basename(note.file) === noteFileName(from) && !existsSync(target)) {
      await rename(note.file, target);
    }
  }
}
