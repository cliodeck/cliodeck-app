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
 * Les listes de mots vides s'appliquent toutes ensemble : la langue d'un
 * extrait n'est pas connue. Un mot n'y entre donc que s'il n'est, dans aucune
 * des trois langues, un nom ou un terme d'historien que l'on cherche par ce
 * seul mot : « war » (allemand) est « la guerre » en anglais, « Waren » des
 * marchandises, « l'Est » une région, « seine » la Seine, « durant » Will
 * Durant. Une majuscule initiale ne protège pas un mot, seules les capitales le
 * font. Ce qui est retiré des listes usuelles est dit à côté de chaque liste ;
 * les mots-outils qui sont aussi un nom propre sont dans
 * `FUNCTION_WORD_HOMONYMS`. Restent dans les listes : un homonyme que l'on
 * cherche avec un autre mot, qui reste (« An Lushan », « bin Laden », « Nur
 * Jahan »), et un mot-outil trop fréquent dans les questions ou dans sa propre
 * langue (« moi » de « Montre-moi », « mon », « autre », « other », « or »,
 * conjonction en français comme en anglais).
 *
 * Elles sont écrites en minuscules, accents compris, et un mot s'y cherche en
 * minuscules avant tout repli des accents : « mais » est un mot vide, « maïs »
 * non ; « wäre » en est un, « Ware » (la marchandise) non. Replié d'abord, un
 * mot tombait sur le mot vide de même graphie sans accents. Quand un mot vide
 * accentué s'écrit souvent sans accent (une question tapée vite) et que cette
 * graphie n'est pas un autre mot, elle y est aussi (« apres », « etre ») ;
 * sinon, non : « fur » (für, the fur trade), « ware » (wäre), « etes » (êtes,
 * mais « les étés »).
 *
 * Les mots-outils des questions y sont (« comment », « combien », « pendant »,
 * « plusieurs », « during », « regarding », « während », « wegen »), et les
 * consignes d'une question au chat (« explique », « disent ») : le bonus
 * « mot-clé exact » de `HybridSearch` vaut pour tout mot de cinq lettres ou plus
 * hors de ces listes, et « Comment la CIA… » doublait le score de chaque extrait
 * qui écrit « comment ». Une liste ne ferme pas la classe : un mot-outil oublié
 * revaut un bonus, et « sources », dans « Que disent mes sources… », est un mot
 * d'historien. Le bonus ne lit pas la rareté d'un mot dans l'index : le seuil
 * serait à mesurer sur un vrai corpus, et un mot central d'un corpus spécialisé
 * (« Italie » dans un corpus sur l'Italie) le perdrait.
 */

export type StopwordLanguage = 'fr' | 'en' | 'de';

/**
 * Français : la liste de la textométrie (`TextometricsService`), plus les
 * élisions, que le découpage sépare de leur mot (« l'État » → « l », « État »),
 * les pronoms, et les mots-outils des questions.
 *
 * Retirés de la liste usuelle : « est » (l'Est, le bloc de l'Est), « été »
 * (l'été 1914), « sommes » (les sommes versées), trois mots qui sont des noms
 * en anglais : « car », « son », « ton » (la tonne), et trois qui sont des noms
 * propres : « durant » (Will Durant, William C. Durant), « celle » (Celle, en
 * Basse-Saxe), « notre » (Notre-Dame). Laissés hors de la liste, bien que
 * mots-outils : « avant » (l'Avant, face à l'Arrière), « contre » (la
 * Contre-Réforme), « sous » (les sous), « vers » (les vers), « outre »
 * (l'outre-mer), « grâce » (la grâce).
 */
const FR = [
  'le', 'la', 'les', 'l', 'un', 'une', 'des', 'de', 'du', 'd', 'au', 'aux', 'à', 'a',
  'et', 'ou', 'où', 'mais', 'donc', 'ni', 'pour', 'dans', 'sur', 'avec', 'par', 'sans', 'en', 'y',
  'chez', 'dès', 'là',
  'ce', 'c', 'cet', 'cette', 'ces', 'cela', 'ceci', 'celui', 'celles', 'ceux',
  'qui', 'que', 'qu', 'quoi', 'dont', 'jusqu', 'lorsqu', 'puisqu', 'quelqu', 'aujourd',
  'je', 'j', 'tu', 'il', 'elle', 'on', 'nous', 'vous', 'ils', 'elles',
  'me', 'm', 'te', 't', 'se', 's', 'moi', 'toi', 'lui', 'eux',
  'sa', 'ses', 'leur', 'leurs', 'mon', 'ma', 'mes', 'ta', 'tes',
  'nos', 'votre', 'vos',
  'si', 'ne', 'n', 'pas', 'plus', 'très', 'tout', 'tous', 'toute', 'toutes', 'autre', 'autres',
  // Questions et mots-outils de cinq lettres ou plus.
  'comment', 'pourquoi', 'quand', 'combien', 'quel', 'quelle', 'quels', 'quelles',
  'lequel', 'laquelle', 'lesquels', 'lesquelles',
  'duquel', 'auquel', 'auxquels', 'auxquelles', 'desquels', 'desquelles',
  'pendant', 'depuis', 'entre', 'parmi', 'après', 'apres', 'comme', 'selon',
  'malgré', 'malgre', 'auprès', 'aupres', 'près', 'envers', 'hormis', 'autour', 'lors', 'afin',
  'concernant', 'quant',
  'ainsi', 'aussi', 'alors', 'encore', 'toujours', 'jamais',
  'lorsque', 'puisque', 'parce', 'jusque', 'tandis', 'quoique', 'sinon', 'voire', 'certes',
  'cependant', 'pourtant', 'toutefois', 'néanmoins', 'neanmoins', 'notamment', 'surtout',
  'seulement', 'également', 'egalement', 'ensuite', 'enfin', 'déjà', 'deja', 'ailleurs',
  'environ', 'presque', 'souvent', 'parfois', 'désormais', 'desormais', 'longtemps',
  'plutôt', 'plutot', 'maintenant', 'davantage', 'vraiment', 'ici', 'puis',
  // Quantités.
  'chaque', 'chacun', 'chacune', 'plusieurs', 'certain', 'certaine', 'certains', 'certaines',
  'aucun', 'aucune', 'quelque', 'quelques', 'beaucoup', 'nombreux', 'nombreuses',
  'même', 'mêmes', 'autant', 'tant', 'trop', 'moins', 'assez', 'rien',
  // Être et avoir, et les verbes des questions.
  'être', 'etre', 'avoir', 'faire', 'dit', 'peut', 'sont', 'était', 'etait', 'étaient', 'etaient',
  'ai', 'as', 'avons', 'avez', 'ont', 'avait', 'avaient', 'suis', 'es', 'êtes',
  'fut', 'furent', 'sera', 'seront', 'serait', 'seraient', 'aurait', 'auraient',
  'étant', 'etant', 'ayant', 'peuvent', 'pouvait', 'pouvaient', 'doit', 'doivent',
  'devait', 'devaient', 'faut', 'fallait', 'agit',
  // Les consignes d'une question au chat (« Explique… », « Que disent… »).
  'disent', 'explique', 'expliquer', 'expliquez', 'décris', 'décrire', 'décrivez',
  'résume', 'résumer', 'résumez',
];

/**
 * Anglais : la liste de la textométrie, plus les mots-outils des questions.
 * Retirés : « may » (le mois de mai : May 1968) et « will » (the general will,
 * un testament). Laissé hors de la liste : « still » (still life).
 */
const EN = [
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from',
  'as', 'is', 'was', 'are', 'were', 'been', 'be', 'have', 'has', 'had', 'do', 'does', 'did',
  'would', 'could', 'should', 'might', 'can', 'shall', 'must', 'ought', 'cannot',
  'being', 'having', 'doing',
  'this', 'that', 'these', 'those', 'it', 'its', 'he', 'she', 'they', 'we', 'you', 'i', 'me', 'my',
  'your', 'his', 'her', 'their', 'our', 'us', 'them', 'there',
  'itself', 'himself', 'herself', 'themselves', 'myself', 'ourselves', 'yourself',
  'which', 'who', 'whom', 'whose', 'what', 'where', 'when', 'why', 'how', 'whether',
  'whatever', 'whenever', 'wherever',
  'not', 'no', 'nor', 'so', 'than', 'then', 'too', 'very', 'also', 'only', 'just',
  // Questions et mots-outils de cinq lettres ou plus.
  'about', 'after', 'before', 'between', 'during', 'while', 'since', 'through', 'within', 'without',
  'because', 'against', 'among', 'amongst', 'into', 'over', 'under', 'other', 'others', 'another',
  'regarding', 'concerning', 'according', 'upon', 'across', 'along', 'around', 'above', 'below',
  'behind', 'beyond', 'besides', 'despite', 'except', 'throughout', 'towards', 'toward', 'until',
  'however', 'although', 'though', 'unless', 'whereas', 'whereby', 'indeed', 'thus', 'hence',
  'therefore', 'moreover', 'furthermore', 'nevertheless', 'otherwise', 'meanwhile',
  'rather', 'quite', 'almost', 'often', 'again', 'already', 'always', 'never', 'perhaps',
  // Quantités.
  'each', 'every', 'some', 'such', 'any', 'all', 'both', 'either', 'neither', 'few', 'many',
  'much', 'most', 'several', 'own', 'same',
  'anyone', 'anything', 'everyone', 'everything', 'someone', 'something', 'nothing', 'nobody',
  // Les consignes d'une question au chat.
  'explain', 'describe', 'summarize', 'summarise',
];

/**
 * Allemand : nouvelle liste, mots-outils seulement. Écartés des listes
 * usuelles : « war » (war, la guerre, en anglais), « waren » (die Waren, les
 * marchandises), « man », « nun » et « hat » (noms anglais : the Hat Act),
 * « will » (voir l'anglais), « mir » (le mir russe), « sein » (le sein, et das
 * Sein), et huit mots-outils qui sont aussi des noms propres : « seine » (la
 * Seine), « oder » (l'Oder), « weil » (Simone et Patrick Weil), « allen »
 * (Allen Dulles), « sind » (le Sind), « das » (Veena Das, C. R. Das), « ob »
 * (l'Ob), « wen » (Wen Jiabao). Laissés hors de la liste : « manche » (la
 * Manche), « falls » (Falls Road, Niagara Falls). « für », « über » et « wäre »
 * y sont, accentués : « fur » (the fur trade) et « Ware » restent cherchables.
 */
const DE = [
  'der', 'die', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'eines', 'einem', 'einen',
  'und', 'aber', 'denn', 'sondern', 'doch', 'noch', 'auch', 'nur', 'schon', 'sehr',
  'so', 'wie', 'als', 'wenn', 'dass', 'daß', 'also', 'jedoch', 'sowie', 'sowohl',
  'zu', 'zum', 'zur', 'im', 'in', 'ins', 'an', 'am', 'auf', 'aus', 'bei', 'beim', 'mit', 'nach',
  'von', 'vom', 'vor', 'über', 'für', 'unter', 'durch', 'gegen', 'ohne', 'um', 'bis', 'seit',
  'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'mich', 'dich', 'dir', 'uns', 'euch',
  'sich', 'ihm', 'ihn', 'ihnen',
  'seiner', 'seines', 'seinem', 'seinen',
  'ihre', 'ihrer', 'ihres', 'ihrem', 'ihren', 'unser', 'unsere', 'unserer', 'unseren',
  'ist', 'bin', 'haben', 'hatte', 'hatten', 'habe', 'hätte', 'hätten', 'gewesen',
  'wird', 'werden', 'wurde', 'wurden', 'worden', 'wäre', 'wären', 'würde', 'würden',
  'kann', 'können', 'konnen', 'konnte', 'konnten', 'könnte', 'könnten', 'soll', 'sollen',
  'sollte', 'sollten', 'muss', 'müssen', 'musste', 'mussten', 'dürfen', 'durfte', 'möchte',
  'nicht', 'nichts', 'kein', 'keine', 'keinen', 'keiner', 'keinem',
  'dies', 'diese', 'dieser', 'dieses', 'diesem', 'diesen',
  'welche', 'welcher', 'welches', 'welchen', 'welchem', 'alle', 'aller', 'alles',
  'andere', 'anderen', 'anderer', 'anderes', 'deren', 'dessen', 'denen',
  'da', 'dort', 'hier', 'dann', 'wo', 'was', 'wer', 'wem', 'damit', 'dabei', 'dazu',
  'darüber', 'dafür', 'dagegen', 'davon', 'dadurch', 'darauf', 'daraus', 'darin',
  // Questions et mots-outils de cinq lettres ou plus.
  'warum', 'wann', 'wieso', 'weshalb', 'woher', 'wohin', 'wodurch', 'wieviel', 'wieviele',
  'zwischen', 'während', 'wahrend', 'nachdem', 'bevor', 'seitdem', 'obwohl', 'obgleich',
  'wegen', 'trotz', 'statt', 'anstatt', 'neben', 'hinter', 'laut', 'gegenüber', 'bezüglich',
  'hinsichtlich', 'innerhalb', 'außerhalb', 'ausserhalb',
  'sodass', 'indem', 'sobald', 'solange', 'sofern',
  'immer', 'wieder', 'bereits', 'selbst', 'allerdings', 'außerdem', 'ausserdem', 'dennoch',
  'trotzdem', 'deshalb', 'deswegen', 'darum', 'daher', 'nämlich', 'etwa', 'eigentlich',
  'jedenfalls', 'überhaupt', 'vielleicht', 'bisher', 'damals',
  // Quantités.
  'viel', 'viele', 'vielen', 'vieler', 'einige', 'einigen', 'einiger', 'mehrere', 'mehreren',
  'jeder', 'jede', 'jedes', 'jedem', 'jeden', 'solche', 'solcher', 'solches', 'solchen',
  'etwas', 'jemand', 'niemand',
  // Les consignes d'une question au chat.
  'erkläre', 'erklären', 'erklärt', 'beschreibe', 'beschreiben', 'zusammenfassen',
];

/**
 * Mots-outils qui sont aussi un nom propre, dans l'une des trois langues : retirés des listes
 * (BM25 les garde, comme avant L07-3), mais le bonus « mot-clé exact » ne les prend que écrits
 * comme un nom, avec une capitale, hors début de phrase (`exactMatchKeywords`) : « la Seine »,
 * pas « seine Agenten » ; « Will Durant », pas « Durant la guerre froide… ». Un terme qui
 * s'écrit en minuscules (le mir, le sein) n'y est pas : la casse ne le distingue pas.
 */
export const FUNCTION_WORD_HOMONYMS: ReadonlySet<string> = new Set([
  'seine', 'oder', 'weil', 'allen', 'sind', 'das', 'ob', 'wen', // allemand
  'durant', 'celle', 'notre', // français
]);

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

/** `stripMarks` sur un mot en minuscules ; un mot ASCII, le cas le plus fréquent, revient tel quel. */
function stripWordMarks(lower: string): string {
  return /[^a-z0-9]/.test(lower) ? stripMarks(lower) : lower;
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
  const base = toNfc(text);
  // L'index BM25 passe par ici pour tout le corpus : le découpage en bigrammes ne s'essaie que
  // s'il y a lieu, et seul un mot qui a une lettre hors ASCII passe par NFD pour perdre ses accents.
  const hasCjk = CJK_RE.test(base);
  const tokens: string[] = [];
  for (const [word] of base.matchAll(WORD_RE)) {
    for (const piece of hasCjk ? cjkPieces(word) : [word]) {
      const lower = piece.toLowerCase();
      // Le mot vide se reconnaît en minuscules, accents compris, avant tout repli : « maïs »
      // replié d'abord tombait sur « mais », « Ware » sur le « wäre » replié.
      if (stopwords && ALL_STOPWORDS.has(lower) && !isAllCaps(piece)) continue;
      const token =
        fold === 'diacritics' ? stripWordMarks(lower) : fold === 'case' ? lower : piece;
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

/** Ce qui peut séparer une fin de phrase du mot suivant : blancs, guillemets, parenthèses ouvrantes. */
const BEFORE_SENTENCE_WORD = /[\s«"“‘'([]/u;
const SENTENCE_END = /[.!?…\n]/u;

/** Vrai si le mot qui commence à `at` ouvre le texte ou une phrase. */
function startsSentence(text: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0 && BEFORE_SENTENCE_WORD.test(text[i]) && text[i] !== '\n') i--;
  return i < 0 || SENTENCE_END.test(text[i]);
}

/** `containsWord`, sans compter une occurrence en début de phrase : une capitale n'y dit rien. */
function containsName(haystack: string, name: string): boolean {
  for (let at = haystack.indexOf(name); at !== -1; at = haystack.indexOf(name, at + 1)) {
    const before = haystack.slice(Math.max(0, at - 2), at);
    const after = haystack.slice(at + name.length, at + name.length + 2);
    if (WORD_CHAR_AT_END.test(before) || WORD_CHAR_AT_START.test(after)) continue;
    if (!startsSentence(haystack, at)) return true;
  }
  return false;
}

/** Un sigle : une capitale, puis une à cinq capitales ou chiffres (« CIA », « ÖVP », « G7 »). */
const ACRONYM_RE = /^\p{Lu}[\p{Lu}\p{N}]{1,5}$/u;
const STARTS_UPPER = /^\p{Lu}/u;
/** Longueur minimale d'un mot de la question, sigles exceptés, pour valoir un bonus. */
const KEYWORD_MIN_LENGTH = 5;

/** Les mots d'une question qui valent le bonus « mot-clé exact », et comment les chercher. */
export interface ExactMatchKeywords {
  /** Les sigles, cherchés tels qu'écrits, comme mots entiers. */
  acronyms: string[];
  /** Les noms homonymes d'un mot-outil (`FUNCTION_WORD_HOMONYMS`), cherchés tels qu'écrits, hors début de phrase. */
  names: string[];
  /** Les autres mots de cinq lettres ou plus, hors mots vides, cherchés repliés (`foldDiacritics`). */
  words: string[];
}

/**
 * Choisit les mots d'une question qui valent le bonus « mot-clé exact ». Les sigles d'abord, tels
 * qu'écrits : « CIA » ne doit pas trouver « cia » dans « sociale ». Puis les mots de cinq lettres
 * ou plus, hors mots vides : un mot vide se reconnaît comme dans `tokenize`, en minuscules et
 * avant le repli des accents. Un mot-outil qui est aussi un nom (« Seine », « Durant ») ne compte
 * qu'écrit comme un nom : avec une capitale, et pas en tête de phrase, où la capitale ne dit rien.
 * Une question d'un seul mot n'est pas une phrase : « Seine », c'est la Seine.
 */
export function exactMatchKeywords(query: string): ExactMatchKeywords {
  const text = toNfc(query);
  const hasCjk = CJK_RE.test(text);
  const acronyms = new Set<string>();
  const names = new Set<string>();
  const words = new Set<string>();
  const matches = [...text.matchAll(WORD_RE)];
  const singleWord = matches.length === 1;
  for (const match of matches) {
    const at = match.index ?? 0;
    for (const piece of hasCjk ? cjkPieces(match[0]) : [match[0]]) {
      // Un sigle de cinq ou six lettres vaut aussi comme mot : « UNESCO » trouve « l'Unesco ».
      const acronym = ACRONYM_RE.test(piece);
      if (acronym) acronyms.add(piece);
      const lower = piece.toLowerCase();
      if (ALL_STOPWORDS.has(lower)) continue;
      if (FUNCTION_WORD_HOMONYMS.has(lower)) {
        const asName =
          !acronym &&
          piece.length >= KEYWORD_MIN_LENGTH &&
          STARTS_UPPER.test(piece) &&
          (singleWord || !startsSentence(text, at));
        if (asName) names.add(piece);
        continue;
      }
      const folded = stripWordMarks(lower);
      if (folded.length >= KEYWORD_MIN_LENGTH) words.add(folded);
    }
  }
  return { acronyms: [...acronyms], names: [...names], words: [...words] };
}

/** Vrai si `text` contient l'un des mots choisis par `exactMatchKeywords`, chacun cherché à sa façon. */
export function hasExactMatch(text: string, keywords: ExactMatchKeywords): boolean {
  const { acronyms, names, words } = keywords;
  if (acronyms.length === 0 && names.length === 0 && words.length === 0) return false;
  const nfc = toNfc(text);
  if (acronyms.some((acronym) => containsWord(nfc, acronym))) return true;
  if (names.some((name) => containsName(nfc, name))) return true;
  if (words.length === 0) return false;
  const folded = foldDiacritics(nfc);
  return words.some((word) => containsWord(folded, word));
}
