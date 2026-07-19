import { readFile } from 'fs/promises';
import path from 'path';
import type { Chapter, BookSettings } from '../../../backend/types/book.js';
import { prefixFootnoteLabels } from '../../editor/footnote-tools.js';

/**
 * Assemblage d'un manuscrit multi-fichiers en un flux unique pour pandoc
 * (plan chapitres, Phase 4 — stratégie D du §1.1).
 *
 * Trois stratégies concurrentes ont été mesurées et écartées : passer N
 * fichiers à pandoc et concaténer naïvement **corrompent les notes** (deux
 * chapitres utilisant chacun `[^1]` rendent la MÊME note aux deux endroits,
 * le texte du premier étant silencieusement remplacé par celui du second) ;
 * `--file-scope` isole bien les notes mais **casse les renvois entre
 * chapitres** (l'ancre est préfixée par le fichier appelant, pas par celui
 * qui la définit). Seule la voie retenue ici préserve les deux : un flux
 * unique dont les identifiants de notes sont préfixés par chapitre.
 */

export interface AssembleOptions {
  projectPath: string;
  /** Pièces du manuscrit, dans l'ordre du manifeste. */
  chapters: Chapter[];
  settings: BookSettings;
  /** Chemin relatif -> texte vivant de l'éditeur (prime sur le disque). */
  liveOverrides?: Record<string, string>;
  /** `book` (défaut) ou un tirage de travail limité à un chapitre. */
  scope?: 'book' | { chapterId: string };
  /**
   * Transformation appliquée au texte d'un chapitre AVANT le préfixage des
   * notes. Sert la bibliographie par chapitre : citeproc y est exécuté
   * chapitre par chapitre, et ses notes générées sont préfixées comme les
   * autres. Le préfixage doit rester la dernière étape, sinon les notes
   * créées par la transformation échapperaient à l'isolation.
   */
  transformChapter?: (content: string, chapter: Chapter) => Promise<string>;
}

export interface AssembledManuscript {
  /** Flux unique prêt pour pandoc. */
  markdown: string;
  chapterCount: number;
  /** Chapitres ignorés, fichiers illisibles… — à remonter à l'utilisateur. */
  warnings: string[];
}

/** Ordre de rendu : liminaires, corps, pièces finales (arbitrage 6). */
const KIND_ORDER: Record<string, number> = { front: 0, chapter: 1, back: 2 };

function isInsideProject(projectDir: string, relPath: string): boolean {
  if (path.isAbsolute(relPath)) return false;
  const resolved = path.resolve(projectDir, relPath);
  const rel = path.relative(projectDir, resolved);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Identifiant d'espace de noms des notes d'une pièce. Fondé sur l'ordre et
 * non sur le titre : stable si l'auteur renomme un chapitre, et sans
 * caractère susceptible de gêner pandoc.
 */
function notePrefix(index: number): string {
  return `ch${index + 1}`;
}

/**
 * Commandes LaTeX de vidage des notes de fin, injectées en brut dans le
 * markdown (pandoc laisse passer le LaTeX brut — vérifié). `endnotes`
 * accumule les notes jusqu'au prochain `\theendnotes` ; sans remise à zéro
 * explicite du compteur, la numérotation court sur tout l'ouvrage.
 */
function endnoteFlush(settings: BookSettings): string {
  const reset = settings.noteNumbering === 'per-chapter'
    ? '\n\\setcounter{endnote}{0}'
    : '';
  return `\n\n\\theendnotes${reset}\n`;
}

/**
 * Remise à zéro du compteur de notes de bas de page à l'ouverture d'un
 * chapitre (`noteNumbering: 'per-chapter'`). En classe `book`, LaTeX
 * numérote les notes en continu par défaut.
 */
const FOOTNOTE_RESET = '\n\n\\setcounter{footnote}{0}\n';

export async function assembleManuscript(
  opts: AssembleOptions
): Promise<AssembledManuscript> {
  const { projectPath, settings, liveOverrides = {}, scope = 'book' } = opts;
  const warnings: string[] = [];

  const selected =
    typeof scope === 'object'
      ? opts.chapters.filter((c) => c.id === scope.chapterId)
      : [...opts.chapters];

  if (typeof scope === 'object' && selected.length === 0) {
    warnings.push(`Chapitre introuvable dans le manifeste : ${scope.chapterId}`);
  }

  // L'ordre du manifeste fait foi (arbitrage 7) ; le `kind` regroupe
  // ensuite liminaires, corps et pièces finales.
  const ordered = selected.sort((a, b) => {
    const ka = KIND_ORDER[a.kind ?? 'chapter'] ?? 1;
    const kb = KIND_ORDER[b.kind ?? 'chapter'] ?? 1;
    return ka !== kb ? ka - kb : a.order - b.order;
  });

  const parts: string[] = [];
  let chapterCount = 0;
  // Bascules de matière LaTeX : le template ne les code plus en dur, car
  // seule la composition du manifeste sait où le corps commence et où les
  // pièces finales débutent (arbitrage 6).
  let mainOpened = false;
  let backOpened = false;

  for (const chapter of ordered) {
    if (!isInsideProject(projectPath, chapter.filePath)) {
      warnings.push(`Chapitre ignoré (chemin hors projet) : ${chapter.filePath}`);
      continue;
    }

    let content = liveOverrides[chapter.filePath];
    if (content === undefined) {
      try {
        content = await readFile(path.resolve(projectPath, chapter.filePath), 'utf-8');
      } catch {
        warnings.push(`Chapitre ignoré (fichier illisible) : ${chapter.filePath}`);
        continue;
      }
    }

    if (opts.transformChapter) {
      content = await opts.transformChapter(content, chapter);
    }

    // Dernière étape : l'isolation des espaces de noms de notes.
    content = prefixFootnoteLabels(content, notePrefix(chapterCount));

    const kind = chapter.kind ?? 'chapter';
    const isBodyChapter = kind === 'chapter';
    let piece = content.trimEnd();

    if (isBodyChapter && !mainOpened) {
      piece = '\\mainmatter\n\n' + piece;
      mainOpened = true;
    } else if (kind === 'back' && !backOpened) {
      // `\backmatter` implique la sortie du corps : ouvrir la matière
      // principale si le manuscrit n'a que des liminaires et des annexes.
      if (!mainOpened) mainOpened = true;
      piece = '\\backmatter\n\n' + piece;
      backOpened = true;
    }

    if (isBodyChapter && settings.noteNumbering === 'per-chapter'
        && settings.noteStyle === 'footnote') {
      piece = FOOTNOTE_RESET + piece;
    }

    if (settings.noteStyle === 'endnote-chapter') {
      piece += endnoteFlush(settings);
    }

    parts.push(piece);
    chapterCount++;
  }

  let markdown = parts.join('\n\n');

  // Notes de fin d'ouvrage : un seul vidage, après la dernière pièce.
  if (settings.noteStyle === 'endnote-book' && chapterCount > 0) {
    markdown += endnoteFlush({ ...settings, noteNumbering: 'continuous' });
  }

  return { markdown: markdown ? markdown + '\n' : '', chapterCount, warnings };
}
