/**
 * Recherche dans tout le manuscrit (audit item 21).
 *
 * `Cmd+F` de CodeMirror ne cherche que le document ouvert : dans un livre de
 * douze chapitres, retrouver un nom propre supposait de les ouvrir un à un.
 * Ce module fournit la partie pure — le balayage et la mise en forme des
 * occurrences ; le panneau et la navigation vivent dans `Book/ManuscriptSearch`.
 *
 * Deux règles issues de l'usage historien :
 *
 * - **insensible à la casse et aux diacritiques** : « eglise » doit trouver
 *   « église », faute de quoi la recherche rate ce que l'auteur a écrit avec
 *   ses accents. En revanche « Danzig » et « Dantzig » restent deux termes
 *   distincts : ce sont deux graphies d'un nom, pas deux accentuations, et
 *   les confondre relèverait d'une recherche floue que personne n'a demandée.
 * - **le chapitre ouvert vient de l'éditeur vivant**, jamais du disque : les
 *   frappes non sauvegardées doivent être trouvables (garanti en amont par
 *   `manuscriptStore.readManuscript()`).
 */

/** Longueur de l'extrait de contexte affiché autour d'une occurrence. */
const CONTEXT_BEFORE = 32;
const CONTEXT_AFTER = 48;

/** Au-delà, on cesse de compter : un terme trop commun noierait le panneau. */
export const MAX_MATCHES_PER_CHAPTER = 200;

export interface SearchMatch {
  /** Décalage dans le texte du chapitre. */
  from: number;
  to: number;
  /** Ligne 1-indexée, pour `revealLine`. */
  line: number;
  /** Extrait de contexte, découpé autour de l'occurrence. */
  before: string;
  match: string;
  after: string;
}

export interface ChapterMatches {
  chapterId: string;
  title: string;
  filePath: string;
  /** Le texte cherché venait de l'éditeur (chapitre ouvert). */
  live: boolean;
  matches: SearchMatch[];
  /** Vrai si le comptage a été arrêté à `MAX_MATCHES_PER_CHAPTER`. */
  truncated: boolean;
}

export interface SearchOutcome {
  query: string;
  chapters: ChapterMatches[];
  total: number;
}

/**
 * Repli des diacritiques et de la casse, en préservant **la longueur** :
 * les décalages calculés sur la forme repliée doivent rester valides sur le
 * texte d'origine. `NFD` séparerait les accents en caractères distincts et
 * décalerait tout — d'où la normalisation caractère par caractère.
 */
export function foldForSearch(text: string): string {
  let out = '';
  for (const char of text) {
    const folded = char
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();
    // Un caractère qui se décompose en plusieurs (ligature « œ ») ou qui
    // disparaît est laissé tel quel, en minuscules : la longueur prime.
    out += folded.length === 1 ? folded : char.toLowerCase();
  }
  return out;
}

/** Numéro de ligne (1-indexé) du décalage donné. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

/** Extrait de contexte, replié sur une seule ligne pour l'affichage. */
function excerpt(text: string, from: number, to: number): Pick<SearchMatch, 'before' | 'match' | 'after'> {
  const flatten = (s: string): string => s.replace(/\s+/g, ' ');
  return {
    before: flatten(text.slice(Math.max(0, from - CONTEXT_BEFORE), from)),
    match: text.slice(from, to),
    after: flatten(text.slice(to, Math.min(text.length, to + CONTEXT_AFTER))),
  };
}

/** Occurrences d'un terme dans un texte. */
export function findMatches(content: string, query: string): { matches: SearchMatch[]; truncated: boolean } {
  const needle = foldForSearch(query.trim());
  if (!needle) return { matches: [], truncated: false };

  const haystack = foldForSearch(content);
  const matches: SearchMatch[] = [];
  let index = haystack.indexOf(needle);

  while (index !== -1) {
    if (matches.length >= MAX_MATCHES_PER_CHAPTER) {
      return { matches, truncated: true };
    }
    const to = index + needle.length;
    matches.push({
      from: index,
      to,
      line: lineAt(content, index),
      ...excerpt(content, index, to),
    });
    index = haystack.indexOf(needle, to);
  }

  return { matches, truncated: false };
}

export interface SearchableDocument {
  chapterId: string;
  title: string;
  filePath: string;
  content: string;
  live: boolean;
}

/** Balaye le manuscrit ordonné ; ne retourne que les chapitres qui matchent. */
export function searchManuscript(
  documents: SearchableDocument[],
  query: string
): SearchOutcome {
  const chapters: ChapterMatches[] = [];
  let total = 0;

  for (const doc of documents) {
    const { matches, truncated } = findMatches(doc.content, query);
    if (matches.length === 0) continue;
    total += matches.length;
    chapters.push({
      chapterId: doc.chapterId,
      title: doc.title,
      filePath: doc.filePath,
      live: doc.live,
      matches,
      truncated,
    });
  }

  return { query: query.trim(), chapters, total };
}
