/**
 * Le texte de l'auteur qu'un coffre Obsidian peut contenir.
 *
 * La documentation invite à ouvrir `reading-notes/` dans Obsidian : un coffre lié peut donc
 * contenir le projet tout entier. Indexés comme notes du coffre, notes de lecture et manuscrit
 * passaient par le canal « vault », qui ne connaît ni `rag.readingNotesCloudConsent` ni la
 * politique du manuscrit : refuser d'envoyer ses notes de lecture au cloud ne tenait plus
 * (S09-1-13). Ces textes ont leurs propres corpus ; le coffre les laisse de côté, à
 * l'indexation comme à la recherche.
 *
 * Coffre et projet se comparent par chemins réels (`realLocation`) : un coffre ouvert par un
 * lien, ou `/tmp` sous macOS, désigne le même dossier que son chemin réel.
 */
import fs from 'fs';
import path from 'path';
import { READING_NOTES_DIR } from '../../core/bibliography/readingNotes.js';
import { parseUserJson } from '../../core/fs/user-files.js';
import { realLocation } from '../../core/vector-store/file-identity.js';
import { CHAPTERS_DIR } from '../../types/book.js';

/** Ce qui, dans un projet, est le texte de l'auteur : dossiers et fichiers, relatifs au projet. */
const AUTHOR_TEXT = [READING_NOTES_DIR, CHAPTERS_DIR, 'document.md', 'slides.md', 'abstract.md'];

/** Les fichiers du manifeste d'un livre : un chapitre peut vivre hors de `chapters/`. */
function manifestFiles(projectRoot: string): string[] {
  try {
    const manifest = parseUserJson<{ chapters?: Array<{ filePath?: unknown }> }>(
      fs.readFileSync(path.join(projectRoot, 'project.json'), 'utf8')
    );
    if (!Array.isArray(manifest.chapters)) return [];
    return manifest.chapters
      .map((c) => c?.filePath)
      .filter((p): p is string => typeof p === 'string' && p.endsWith('.md'));
  } catch {
    return []; // Pas de manifeste, ou illisible : article ou présentation.
  }
}

/** `relative` de `root` à `target`, par segments, ou `null` si `target` n'est pas dessous. */
function relativeInside(root: string, target: string): string | null {
  const relative = path.relative(root.normalize('NFC'), target.normalize('NFC'));
  if (relative === '') return '';
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep).join('/');
}

/**
 * Les chemins, relatifs au coffre et séparés par `/`, que le coffre doit laisser de côté : notes
 * de lecture, chapitres, `document.md`, `slides.md`, `abstract.md` et les fichiers du manifeste,
 * quand ils sont sous le coffre. Une liste vide si le coffre ne contient rien du projet ; `['']`
 * (tout le coffre) si le coffre est lui-même l'un d'eux ou se trouve dedans.
 */
export function authorTextInVault(vaultPath: string, projectRoot: string): string[] {
  const realVault = realLocation(vaultPath);
  const realRoot = realLocation(projectRoot);
  if (realVault === null || realRoot === null) return [];

  const exclusions = new Set<string>();
  for (const entry of [...AUTHOR_TEXT, ...manifestFiles(projectRoot)]) {
    const real = realLocation(path.resolve(realRoot, entry));
    if (real === null) continue;
    // Le coffre dans un dossier du texte de l'auteur : tout ce qu'il contient en est.
    if (relativeInside(real, realVault) !== null) return [''];
    const relative = relativeInside(realVault, real);
    if (relative !== null) exclusions.add(relative);
  }
  return [...exclusions];
}

/** Ce chemin du coffre (relatif, séparé par `/`) est-il l'une des exclusions, ou dessous ? */
export function isExcludedFromVault(relativePath: string, exclusions: readonly string[]): boolean {
  const candidate = relativePath.normalize('NFC');
  return exclusions.some(
    (excluded) => excluded === '' || candidate === excluded || candidate.startsWith(`${excluded}/`)
  );
}
