/**
 * Ce qu'un `.bib` porte hors de ses entrées : en-tête, `@comment`, `@preamble`, `@string`, texte
 * libre. Le parseur n'en fait pas de citation, et l'exporteur n'écrit que des entrées : la
 * synchronisation Zotero et « Fusionner », qui réécrivent le fichier depuis ses citations,
 * effaçaient les groupes de BibDesk (`@comment{BibDesk Static Groups{…}}`) et de JabRef
 * (`@Comment{jabref-meta: grouping:…}`), leurs réglages et les commentaires de l'historien (H2).
 *
 * On les reprend de l'ancien fichier, à l'octet ; seules les lignes vides qui les séparent des
 * entrées sont refaites. Ce qui précède la première entrée reste en tête : l'en-tête, le
 * `@preamble`. Le reste va en fin, dans l'ordre d'origine : ce qui suit la dernière entrée, où
 * BibDesk et JabRef écrivent leurs groupes, et ce qui séparait deux entrées. Un commentaire placé
 * devant une entrée la quitte donc : la réécriture peut retirer l'entrée ou en changer l'ordre, et
 * le rattacher à une entrée par sa clé ne serait plus simple ni sûr.
 *
 * Une arobase hors des entrées (« % voir aussi @Garde2000 », une adresse, un `@comment(…)`) : le
 * parseur colle au type de l'entrée qui suit tout ce qui va de cette arobase à l'accolade de
 * l'entrée, et l'exporteur l'écrit avec elle. Ce texte reste donc avec l'entrée (`parserStart`) ;
 * seul ce qui le précède est repris hors des entrées. Une ligne ainsi coupée en deux garde ses
 * octets, une fois chacun.
 *
 * Les `@string` restent tels quels, mais la réécriture écrit toujours les valeurs développées
 * (L05-7) : la définition est gardée, plus rien ne la cite.
 */
import { BibTeXParser, findMatchingBrace } from './BibTeXParser';
import { auditParsedBib } from './bibAudit';

/** Un `@type{` ou `@type(` : des blancs permis autour du type, comme pour BibTeX. */
const BLOCK_START = /@\s*([A-Za-z][\w-]*)\s*([{(])/g;

/** Ces blocs ne sont pas des références : le parseur n'en fait pas de citation. */
const NOT_REFERENCES = new Set(['comment', 'preamble', 'string']);

/** Des blancs seulement (un BOM compris). */
const BLANK = /^\s*$/;

/**
 * Les lignes vides du début d'un texte ; la fin de ligne et les lignes vides de sa fin. Fins de
 * ligne LF, CRLF ou CR seul (Mac OS classique) : refaites en LF, elles doivent se retrouver au
 * redécoupage, sinon le fichier composé ne serait pas le même à la réécriture suivante. Un CRLF ne
 * se lit que d'une façon (`\r(?!\n)`) : lu aussi comme CR puis LF, une suite de lignes vides
 * suivie de texte faisait essayer au moteur 2^n découpages (22 lignes : 145 ms, mesuré).
 */
const EOL = String.raw`(?:\r\n|\r(?!\n)|\n)`;
const LEADING_BLANK_LINES = new RegExp(String.raw`^(?:[ \t]*${EOL})+`);
const TRAILING_BLANK_LINES = new RegExp(String.raw`(?:${EOL}[ \t]*)+$`);

/**
 * Parenthèse qui ferme celle ouverte en `open` (`@comment(…)`), hors accolades, ou -1. Les
 * accolades se comptent comme le fait le parseur : `\{` et `\}` ne comptent pas.
 */
function findMatchingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open + 1; i < text.length; i++) {
    const char = text[i];
    if (char === '\\') {
      i++;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      if (depth > 0) depth--;
    } else if (char === ')' && depth === 0) {
      return i;
    }
  }
  return -1;
}

/**
 * Début et fin (exclue) de chaque entrée du texte, dans l'ordre. Une entrée se referme comme le
 * parseur la referme (`findMatchingBrace`) : les accolades imbriquées d'une valeur, ou de la liste
 * de propriétés d'un bloc de groupes BibDesk, ne coupent rien. Un bloc qui ne se referme pas n'est
 * que du texte, et l'on cherche plus loin, comme le parseur. Une entrée entre parenthèses, qu'il ne
 * lit pas, reste du texte : la synchronisation et la fusion refusent d'ailleurs un tel fichier.
 *
 * Une entrée commence là où le parseur la commence (`parserStart`). Un bloc entre parenthèses ne
 * compte pas pour cela : le parseur ne le referme pas, il cherche l'accolade qui suit son arobase.
 */
function entrySpans(bib: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const blockStart = new RegExp(BLOCK_START);
  // Où le parseur reprend sa lecture : après le dernier bloc entre accolades.
  let resume = 0;
  for (let match = blockStart.exec(bib); match; match = blockStart.exec(bib)) {
    const open = match.index + match[0].length - 1;
    const braces = match[2] === '{';
    const close = braces ? findMatchingBrace(bib, open) : findMatchingParen(bib, open);
    if (close === -1) continue;
    if (braces && !NOT_REFERENCES.has(match[1].toLowerCase())) {
      spans.push({ start: parserStart(bib, resume, match.index), end: close + 1 });
    }
    if (braces) resume = close + 1;
    blockStart.lastIndex = close + 1;
  }
  return spans;
}

/**
 * Où le parseur fait commencer l'entrée dont l'arobase est en `at`, quand il reprend sa lecture en
 * `resume` : à la première arobase qu'aucune accolade ouvrante ne sépare de celle de l'entrée. Il
 * prend pour type tout ce qui va de là à l'accolade (« % voir aussi @Garde2000 » ou une adresse
 * juste avant l'entrée, un `@comment(…)`), et l'exporteur l'écrit avec l'entrée. Ce texte est donc
 * de l'entrée : compté aussi hors des entrées, il revenait en fin de fichier à chaque réécriture,
 * une fois de plus. Une arobase dans un `@comment{…}` qui précède l'entrée reste au bloc, gardé
 * entier : le texte que le parseur en colle au type s'écrit alors deux fois, sans s'ajouter
 * d'une réécriture à l'autre.
 */
function parserStart(bib: string, resume: number, at: number): number {
  const brace = at === 0 ? -1 : bib.lastIndexOf('{', at - 1);
  const first = bib.indexOf('@', Math.max(resume, brace + 1));
  return first === -1 ? at : Math.min(first, at);
}

/** Ce que `bib` porte hors de ses entrées : ce qui précède la première, ce qui suit chacune. */
interface Outside {
  top: string[];
  bottom: string[];
}

function outsideOf(bib: string): Outside {
  const spans = entrySpans(bib);
  const head = spans.length === 0 ? bib : bib.slice(0, spans[0].start);
  // Ce qui suit chaque entrée, jusqu'à la suivante ou à la fin du fichier.
  const after = spans.map((span, i) => bib.slice(span.end, i + 1 < spans.length ? spans[i + 1].start : bib.length));
  return {
    top: BLANK.test(head) ? [] : [head.replace(TRAILING_BLANK_LINES, '')],
    bottom: after
      .filter((text) => !BLANK.test(text))
      .map((text) => text.replace(LEADING_BLANK_LINES, '').replace(TRAILING_BLANK_LINES, '')),
  };
}

/** `rewritten` entre `top` et `bottom`, une ligne vide entre chaque morceau. */
function compose({ top, bottom }: Outside, rewritten: string): string {
  if (top.length === 0 && bottom.length === 0) return rewritten;
  const entries = BLANK.test(rewritten) ? [] : [rewritten.replace(TRAILING_BLANK_LINES, '')];
  return [...top, ...entries, ...bottom].join('\n\n') + '\n';
}

/** Ce que le parseur lit d'un texte, et les entrées qu'il n'en lit pas. */
function readingOf(bib: string): string {
  const citations = new BibTeXParser().parse(bib);
  return JSON.stringify([citations, auditParsedBib(bib, citations).unreadKeys]);
}

/**
 * `rewritten`, les entrées réécrites, avec ce que `previous`, l'ancien fichier, portait hors de
 * ses entrées. Rien hors des entrées que des blancs : `rewritten` tel quel, sans un octet de plus.
 *
 * Le fichier composé doit se relire comme `rewritten` seul (mêmes citations, mêmes entrées non
 * lues) : le parseur cherche des entrées jusque dans un `@comment`, et une entrée écrite dans un
 * commentaire se doublerait à chaque réécriture. Il doit aussi se redécouper à l'identique : la
 * réécriture suivante rend alors le même fichier, au lieu d'y ajouter quelque chose. Sinon, on
 * essaie la fin seule, puis la tête seule — un en-tête qui change la relecture n'emporte pas les
 * groupes de la fin —, et en dernier `rewritten` seul, comme avant. La copie de sécurité garde le
 * fichier d'avant.
 */
export function keepOutsideEntries(previous: string, rewritten: string): string {
  const { top, bottom } = outsideOf(previous);
  if (top.length === 0 && bottom.length === 0) return rewritten;

  const candidates: Outside[] = [{ top, bottom }];
  if (top.length > 0 && bottom.length > 0) candidates.push({ top: [], bottom }, { top, bottom: [] });

  const expected = readingOf(rewritten);
  for (const kept of candidates) {
    const composed = compose(kept, rewritten);
    if (compose(outsideOf(composed), rewritten) !== composed || readingOf(composed) !== expected) continue;
    if (kept !== candidates[0]) {
      const lost = kept.top.length === 0 ? 'l’en-tête' : 'ce qui suivait ses entrées ou les séparait';
      console.warn(`⚠️ Ce que le .bib portait hors de ses entrées change leur relecture : ${lost} n’est pas repris (la copie de sécurité le garde).`);
    }
    return composed;
  }

  console.warn('⚠️ Ce que le .bib portait hors de ses entrées change leur relecture : il n’est pas repris (la copie de sécurité le garde).');
  return rewritten;
}
