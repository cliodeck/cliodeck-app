/**
 * Normalisation du texte pour les recherches lexicales : une seule façon de
 * découper et de replier un mot, partagée par l'index et par la requête.
 *
 * Avant L07-3, chaque recherche avait la sienne, et BM25 en avait deux : le
 * tokeniseur de `natural` à l'indexation, qui coupe un mot sur chaque lettre
 * hors ASCII (« Liège » → « li », « ge »), et un découpage sur les blancs à la
 * requête, qui gardait « liège ». Aucun mot accentué n'était retrouvé.
 *
 * Règles :
 * - un mot est une suite de lettres, marques et chiffres Unicode, après NFC :
 *   NFC et NFD donnent le même mot, et « Größe » reste un seul mot ;
 * - le chinois et le japonais, écrits sans blancs, sont découpés en bigrammes ;
 * - un mot écrit entièrement en capitales (au moins deux lettres) n'est jamais
 *   un mot vide : « US », « CE », « SA », « WHO » sont des sigles.
 *
 * Les listes de mots vides sont écrites repliées (minuscules, sans accents) et
 * s'appliquent toutes ensemble : la langue d'un extrait n'est pas connue. Un
 * mot n'y entre donc que s'il n'est un terme d'historien dans aucune des trois
 * langues : « war » (allemand) est « la guerre » en anglais, « Waren » des
 * marchandises, « l'Est » une région. Ce qui est retiré des listes usuelles est
 * dit à côté de chaque liste.
 */

export type StopwordLanguage = 'fr' | 'en' | 'de';

/**
 * Français : la liste de la textométrie (`TextometricsService`), plus les
 * élisions, que le découpage sépare de leur mot (« l'État » → « l », « État »),
 * et les pronoms personnels.
 *
 * Retirés de la liste usuelle : « est » (l'Est, le bloc de l'Est), « été »
 * (l'été 1914), « sommes » (les sommes versées), et trois mots qui sont des
 * noms en anglais : « car », « son », « ton » (la tonne).
 */
const FR = [
  'le', 'la', 'les', 'l', 'un', 'une', 'des', 'de', 'du', 'd', 'au', 'aux', 'a',
  'et', 'ou', 'mais', 'donc', 'ni', 'pour', 'dans', 'sur', 'avec', 'par', 'sans', 'en', 'y',
  'ce', 'c', 'cet', 'cette', 'ces', 'qui', 'que', 'qu', 'quoi', 'dont', 'jusqu', 'lorsqu', 'puisqu',
  'je', 'j', 'tu', 'il', 'elle', 'on', 'nous', 'vous', 'ils', 'elles',
  'me', 'm', 'te', 't', 'se', 's', 'moi', 'toi', 'lui', 'eux',
  'sa', 'ses', 'leur', 'leurs', 'mon', 'ma', 'mes', 'ta', 'tes',
  'notre', 'nos', 'votre', 'vos',
  'si', 'ne', 'n', 'pas', 'plus',
  'etre', 'avoir', 'faire', 'dit', 'peut', 'sont', 'etait',
  'ai', 'as', 'avons', 'avez', 'ont', 'suis', 'es', 'etes',
];

/**
 * Anglais : la liste de la textométrie. Retirés : « may » (le mois de mai :
 * May 1968) et « will » (the general will, un testament).
 */
const EN = [
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from',
  'as', 'is', 'was', 'are', 'were', 'been', 'be', 'have', 'has', 'had', 'do', 'does', 'did',
  'would', 'could', 'should', 'might', 'can',
  'this', 'that', 'these', 'those', 'it', 'its', 'he', 'she', 'they', 'we', 'you', 'i', 'me', 'my',
  'your', 'his', 'her', 'their', 'our', 'us',
  'which', 'who', 'whom', 'whose', 'what', 'where', 'when', 'why', 'how',
  'not', 'no', 'nor', 'so', 'than', 'too', 'very', 'also', 'only', 'just',
];

/**
 * Allemand : nouvelle liste, mots-outils seulement. Écartés des listes
 * usuelles : « war » (war, la guerre, en anglais), « waren » (die Waren, les
 * marchandises), « man » et « nun » (noms anglais), « will » (voir l'anglais),
 * « für », qui se replie en « fur » (the fur trade).
 */
const DE = [
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'eines', 'einem', 'einen',
  'und', 'oder', 'aber', 'denn', 'sondern', 'doch', 'noch', 'auch', 'nur', 'schon', 'sehr',
  'so', 'wie', 'als', 'wenn', 'weil', 'dass', 'daß', 'ob', 'also', 'jedoch', 'sowie',
  'zu', 'zum', 'zur', 'im', 'in', 'ins', 'an', 'am', 'auf', 'aus', 'bei', 'beim', 'mit', 'nach',
  'von', 'vom', 'vor', 'uber', 'unter', 'durch', 'gegen', 'ohne', 'um', 'bis', 'seit',
  'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'mich', 'mir', 'dich', 'dir', 'uns', 'euch',
  'sich', 'ihm', 'ihn', 'ihnen',
  'sein', 'seine', 'seiner', 'seines', 'seinem', 'seinen',
  'ihre', 'ihrer', 'ihres', 'ihrem', 'ihren',
  'ist', 'sind', 'bin', 'hat', 'haben', 'hatte', 'hatten', 'habe',
  'wird', 'werden', 'wurde', 'wurden', 'worden', 'ware', 'kann', 'konnen', 'konnte', 'soll', 'muss',
  'nicht', 'nichts', 'kein', 'keine', 'keinen', 'keiner', 'keinem',
  'dies', 'diese', 'dieser', 'dieses', 'diesem', 'diesen',
  'welche', 'welcher', 'welches', 'alle', 'allen', 'aller', 'alles',
  'da', 'dort', 'hier', 'dann', 'wo', 'was', 'wer', 'wem', 'wen', 'damit', 'dabei', 'dazu',
];

export const STOPWORDS: Readonly<Record<StopwordLanguage, ReadonlySet<string>>> = {
  fr: new Set(FR),
  en: new Set(EN),
  de: new Set(DE),
};

export const ALL_STOPWORDS: ReadonlySet<string> = new Set([...FR, ...EN, ...DE]);

export function toNfc(text: string): string {
  return text.normalize('NFC');
}

export function foldCase(text: string): string {
  return toNfc(text).toLowerCase();
}

/** Retire les accents (marques combinantes après NFD), sans toucher à la casse. */
function stripMarks(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');
}

/** Minuscules sans accents : « ÉTAT » → « etat ». « ß » n'est pas un accent et reste. */
export function foldDiacritics(text: string): string {
  return stripMarks(text).toLowerCase();
}

export interface TokenizeOptions {
  /** `case` : minuscules ; `diacritics` : minuscules sans accents ; absent : le mot tel quel. */
  fold?: 'case' | 'diacritics';
  /** Écarte les mots vides des trois langues, sauf un mot écrit en capitales. */
  stopwords?: boolean;
  /** Longueur minimale d'un jeton, comptée après repli. */
  minLength?: number;
}

const WORD_RE = /[\p{L}\p{M}\p{N}]+/gu;
const CJK_RE = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u;
const CJK_RUN_RE = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]+|[^\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]+/gu;

/** Sépare les écritures d'un mot, puis découpe chaque suite chinoise ou japonaise en bigrammes. */
function cjkPieces(word: string): string[] {
  const pieces: string[] = [];
  for (const [run] of word.matchAll(CJK_RUN_RE)) {
    if (!CJK_RE.test(run)) {
      pieces.push(run);
      continue;
    }
    const chars = Array.from(run);
    if (chars.length === 1) pieces.push(run);
    for (let i = 0; i + 1 < chars.length; i++) pieces.push(chars[i] + chars[i + 1]);
  }
  return pieces;
}

/** Au moins deux caractères, une capitale et aucune minuscule : un sigle, pas un mot vide. */
function isAllCaps(word: string): boolean {
  return word.length >= 2 && /\p{Lu}/u.test(word) && !/\p{Ll}/u.test(word);
}

export function tokenize(text: string, opts: TokenizeOptions = {}): string[] {
  const { fold, stopwords = false, minLength = 1 } = opts;
  // L'index BM25 passe par ici pour tout le corpus : les accents se retirent une fois pour tout
  // le texte, pas mot à mot, et le découpage en bigrammes ne s'essaie que s'il y a lieu.
  const base = fold === 'diacritics' ? stripMarks(text) : toNfc(text);
  const hasCjk = CJK_RE.test(base);
  const tokens: string[] = [];
  for (const [word] of base.matchAll(WORD_RE)) {
    for (const piece of hasCjk ? cjkPieces(word) : [word]) {
      // En repli `diacritics`, le texte est déjà sans accents : la minuscule suffit.
      const bare = fold === 'diacritics' ? piece.toLowerCase() : null;
      if (stopwords && ALL_STOPWORDS.has(bare ?? foldDiacritics(piece)) && !isAllCaps(piece)) {
        continue;
      }
      const token = bare ?? (fold === 'case' ? piece.toLowerCase() : piece);
      if (token.length >= minLength) tokens.push(token);
    }
  }
  return tokens;
}

const WORD_CHAR_AT_END = /[\p{L}\p{M}\p{N}]$/u;
const WORD_CHAR_AT_START = /^[\p{L}\p{M}\p{N}]/u;

/**
 * Vrai si `word` apparaît dans `haystack` comme mot entier : ni lettre, ni marque, ni chiffre juste
 * avant ou juste après. « CIA » est dans « la CIA's station », pas dans « sociale ». La comparaison
 * est littérale : à l'appelant de replier les deux côtés de la même façon.
 */
export function containsWord(haystack: string, word: string): boolean {
  if (word.length === 0) return false;
  for (let at = haystack.indexOf(word); at !== -1; at = haystack.indexOf(word, at + 1)) {
    // Deux unités de code de chaque côté : une lettre hors du plan de base en occupe deux.
    const before = haystack.slice(Math.max(0, at - 2), at);
    const after = haystack.slice(at + word.length, at + word.length + 2);
    if (!WORD_CHAR_AT_END.test(before) && !WORD_CHAR_AT_START.test(after)) return true;
  }
  return false;
}
