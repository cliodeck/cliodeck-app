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

/** Les lignes vides du début d'un texte ; la fin de ligne et les lignes vides de sa fin. */
const LEADING_BLANK_LINES = /^(?:[ \t]*\r?\n)+/;
const TRAILING_BLANK_LINES = /(?:\r?\n[ \t]*)+$/;

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
 */
function entrySpans(bib: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const blockStart = new RegExp(BLOCK_START);
  for (let match = blockStart.exec(bib); match; match = blockStart.exec(bib)) {
    const open = match.index + match[0].length - 1;
    const close = match[2] === '{' ? findMatchingBrace(bib, open) : findMatchingParen(bib, open);
    if (close === -1) continue;
    if (match[2] === '{' && !NOT_REFERENCES.has(match[1].toLowerCase())) {
      spans.push({ start: match.index, end: close + 1 });
    }
    blockStart.lastIndex = close + 1;
  }
  return spans;
}

/**
 * Le texte composé se relit-il comme les seules entrées réécrites : mêmes citations, mêmes entrées
 * non lues ? Le parseur cherche des entrées jusque dans un `@comment`, et prend pour type d'une
 * entrée tout ce qui suit un `@` qui la précède (une adresse dans l'en-tête) : là, un bloc gardé
 * changerait la relecture, et une entrée écrite dans un commentaire se doublerait à chaque
 * réécriture.
 */
function readsAlike(composed: string, rewritten: string): boolean {
  const parser = new BibTeXParser();
  const expected = parser.parse(rewritten);
  const reread = parser.parse(composed);
  return (
    JSON.stringify(reread) === JSON.stringify(expected) &&
    JSON.stringify(auditParsedBib(composed, reread).unreadKeys) === JSON.stringify(auditParsedBib(rewritten, expected).unreadKeys)
  );
}

/**
 * `rewritten`, les entrées réécrites, avec ce que `previous`, l'ancien fichier, portait hors de
 * ses entrées. Rien hors des entrées que des blancs : `rewritten` tel quel, sans un octet de plus.
 * Si ce qu'on garde changeait la relecture des entrées, `rewritten` seul, comme avant : la copie de
 * sécurité du fichier d'avant le garde.
 */
export function keepOutsideEntries(previous: string, rewritten: string): string {
  const spans = entrySpans(previous);
  const head = spans.length === 0 ? previous : previous.slice(0, spans[0].start);
  // Ce qui suit chaque entrée, jusqu'à la suivante ou à la fin du fichier.
  const after = spans.map((span, i) => previous.slice(span.end, i + 1 < spans.length ? spans[i + 1].start : previous.length));

  const top = BLANK.test(head) ? [] : [head.replace(TRAILING_BLANK_LINES, '')];
  const bottom = after
    .filter((text) => !BLANK.test(text))
    .map((text) => text.replace(LEADING_BLANK_LINES, '').replace(TRAILING_BLANK_LINES, ''));
  if (top.length === 0 && bottom.length === 0) return rewritten;

  const entries = BLANK.test(rewritten) ? [] : [rewritten.replace(TRAILING_BLANK_LINES, '')];
  const composed = [...top, ...entries, ...bottom].join('\n\n') + '\n';
  if (readsAlike(composed, rewritten)) return composed;

  console.warn('⚠️ Ce que le .bib portait hors de ses entrées change leur relecture : il n’est pas repris (la copie de sécurité le garde).');
  return rewritten;
}
