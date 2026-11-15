/**
 * L'aperçu d'un extrait : ce que montre la carte d'une recommandation de similarité, et ce que
 * lit le modèle qui les reclasse (S13-2-0).
 *
 * L'aperçu valait les 200 premiers caractères du contenu brut. Or un extrait de PDF commence par
 * le préfixe `[Doc: <titre>]` (`stripChunkHeader`), puis par le recouvrement, la fin de l'extrait
 * précédent : 69 à 86 caractères d'en-tête et 348 à 369 de recouvrement en médiane, mesuré sur
 * trois bases réelles. Neuf aperçus sur dix ne montraient aucun mot du passage trouvé, et le
 * modèle classait sur le titre, écrit deux fois.
 *
 * L'aperçu est donc une fenêtre d'environ 35 mots prise dans le texte de l'extrait : celle qui
 * contient le plus de mots différents de la requête (`tokenize`, mots vides écartés, accents
 * repliés). À égalité, et quand la requête n'a aucun mot dans l'extrait (une requête dans une
 * autre langue), la fenêtre qui commence une phrase, puis la plus proche du milieu : le milieu
 * d'un extrait d'environ 1 800 caractères tombe hors de l'en-tête et du recouvrement. Si les mots
 * de la requête sont dans le recouvrement, la fenêtre peut y tomber : ce texte fait partie de
 * l'extrait embarqué.
 */
import { stripChunkHeader } from './chunk-text';
import { tokenize, type TokenizeOptions } from '../text/normalize';

/** Environ 35 mots. */
const PREVIEW_CHARS = 240;

const TERM_OPTIONS: TokenizeOptions = { fold: 'diacritics', stopwords: true };

/** Un mot qui finit une phrase : « . », « ! », « ? » ou « … », puis au plus des guillemets ou parenthèses fermants. */
const ENDS_SENTENCE = /[.!?…]["»”’)\]]*$/u;

interface Word {
  start: number;
  end: number;
  /** Les termes de la requête que porte ce mot. */
  terms: string[];
  startsSentence: boolean;
}

/**
 * L'aperçu de `content` pour `query`, au plus `maxChars` caractères de l'extrait, blancs réduits,
 * sans l'en-tête. Un extrait qui tient en entier est rendu en entier ; sinon « … » dit de quel côté
 * il est coupé.
 */
export function chunkPreview(content: string, query: string, maxChars = PREVIEW_CHARS): string {
  const text = stripChunkHeader(content).replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;

  const queryTerms = new Set(tokenize(query, TERM_OPTIONS));
  const words: Word[] = [];
  let previous = '';
  for (const match of text.matchAll(/\S+/g)) {
    const start = match.index ?? 0;
    words.push({
      start,
      end: start + match[0].length,
      terms: queryTerms.size > 0 ? tokenize(match[0], TERM_OPTIONS).filter((t) => queryTerms.has(t)) : [],
      startsSentence: words.length === 0 || ENDS_SENTENCE.test(previous),
    });
    previous = match[0];
  }

  // Pour chaque premier mot, la fenêtre la plus longue qui tient dans `maxChars` (un mot au moins),
  // et le nombre de termes différents de la requête qu'elle contient.
  const center = text.length / 2;
  const counts = new Map<string, number>();
  let best = { first: 0, end: 1, distinct: -1, startsSentence: false, offCenter: Infinity };
  let end = 0;
  for (let first = 0; first < words.length; first++) {
    if (end <= first) {
      end = first;
      add(words[end++], counts);
    }
    while (end < words.length && words[end].end - words[first].start <= maxChars) add(words[end++], counts);

    const candidate = {
      first,
      end,
      distinct: counts.size,
      startsSentence: words[first].startsSentence,
      offCenter: Math.abs((words[first].start + words[end - 1].end) / 2 - center),
    };
    if (isBetter(candidate, best)) best = candidate;
    remove(words[first], counts);
  }

  const preview = text.slice(words[best.first].start, words[best.end - 1].end);
  return `${best.first > 0 ? '… ' : ''}${preview}${best.end < words.length ? ' …' : ''}`;
}

interface Window {
  distinct: number;
  startsSentence: boolean;
  offCenter: number;
}

/** Plus de termes de la requête ; à égalité, le début d'une phrase ; puis le plus près du milieu. */
function isBetter(a: Window, b: Window): boolean {
  if (a.distinct !== b.distinct) return a.distinct > b.distinct;
  if (a.startsSentence !== b.startsSentence) return a.startsSentence;
  return a.offCenter < b.offCenter;
}

function add(word: Word, counts: Map<string, number>): void {
  for (const term of word.terms) counts.set(term, (counts.get(term) ?? 0) + 1);
}

function remove(word: Word, counts: Map<string, number>): void {
  for (const term of word.terms) {
    const left = (counts.get(term) ?? 0) - 1;
    if (left > 0) counts.set(term, left);
    else counts.delete(term);
  }
}
