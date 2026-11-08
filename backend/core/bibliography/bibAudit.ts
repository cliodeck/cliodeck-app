/**
 * Ce que le parseur a laissé d'un `.bib` : à vérifier avant de réécrire le fichier.
 *
 * `BibTeXParser.lastRejected` ne voit que les entrées sans titre. Une accolade qui ne se ferme pas
 * fait sauter l'entrée sans rien noter, une accolade fermante de trop la coupe en route, et une
 * entrée entre parenthèses ne se lit pas. La synchronisation Zotero réécrivait le fichier à partir
 * de ce que le parseur avait rendu : tout le reste disparaissait, sans un mot (S07-1-2).
 *
 * Ce n'est pas un second lecteur de `.bib` : on compte les entrées du texte, une par `@type{clé`
 * en début de ligne, contre celles que le parseur a rendues. Limites assumées : une valeur qui
 * contient `@x{y,` en début de ligne compte pour une entrée, et la clé `y` est signalée à tort ;
 * entre deux entrées, une accolade dans un texte libre qui n'est pas une ligne de commentaire `%`
 * fait signaler à tort l'entrée qui précède ; un champ lu à moitié dans une entrée rendue ne se
 * voit pas — on contrôle les entrées, pas les champs.
 */
import type { Citation } from '../../types/citation';
import { findMatchingBrace } from './BibTeXParser';

export interface BibAudit {
  /** Clés des entrées du texte que le parseur n'a pas rendues, ou pas en entier. */
  unreadKeys: string[];
  /**
   * Parmi elles, celles qui portent un champ `zoterokey` : venues de Zotero, elles se corrigent
   * dans le `.bib` sans être supprimées, sinon elles reviendraient comme des références
   * nouvelles, sans le PDF déjà téléchargé.
   */
  unreadFromZotero: string[];
  /**
   * Le fichier définit des `@string`. Pour information : le parseur les développe, et une
   * réécriture écrit les valeurs développées, sans les définitions. Une définition qu'il n'a pas
   * lue (entre parenthèses, accolade non refermée) est dans `unreadKeys`, sous le nom `string`.
   */
  hasStringMacros: boolean;
}

/** Un `@type{` ou `@type(` en début de ligne, BOM et indentation permis. */
const ENTRY_START = /^[ \t\uFEFF]*@[ \t]*([A-Za-z][\w-]*)[ \t]*([{(])/gm;

/** Ce que le parseur saute : ce ne sont pas des références, et rien n'en est relu. */
const NOT_REFERENCES = new Set(['comment', 'preamble']);

/** Un champ `zoterokey` en début de ligne : l'entrée vient d'une notice Zotero. */
const ZOTERO_KEY_FIELD = /^[ \t]*zoterokey[ \t]*=/im;

/** Une ligne de commentaire `%`, hors de toute entrée : BibTeX et le parseur l'ignorent. */
const COMMENT_LINE = /^[ \t]*%.*$/gm;

/**
 * L'entrée ouverte à `open` se ferme-t-elle avant `end`, sans accolade orpheline derrière elle ?
 * Les accolades se comptent avec la fonction du parseur (`\{` et `\}` ne comptent pas) : c'est ce
 * qu'il a lu qu'on contrôle. Derrière la fermeture, on s'arrête au premier `@` : une autre entrée
 * sur la même ligne, ou une adresse dans un commentaire, n'est pas une accolade de trop ; une
 * ligne de commentaire `%` non plus.
 */
function closesCleanly(text: string, open: number, end: number): boolean {
  const close = findMatchingBrace(text, open);
  if (close === -1 || close >= end) return false;
  const after = text.slice(close + 1, end);
  const at = after.indexOf('@');
  return !/[{}]/.test((at === -1 ? after : after.slice(0, at)).replace(COMMENT_LINE, ''));
}

/**
 * Compare le texte d'un `.bib` à ce que le parseur en a rendu. La clé d'une entrée se lit comme
 * le parseur la lit (jusqu'à la première virgule, sans les blancs), pour ne rien signaler à tort.
 */
export function auditParsedBib(rawBib: string, parsed: readonly Citation[]): BibAudit {
  const left = new Map<string, number>();
  for (const citation of parsed) left.set(citation.id, (left.get(citation.id) ?? 0) + 1);

  const starts = [...rawBib.matchAll(ENTRY_START)];
  const unreadKeys: string[] = [];
  const unreadFromZotero: string[] = [];
  let hasStringMacros = false;

  starts.forEach((match, i) => {
    const type = match[1].toLowerCase();
    if (NOT_REFERENCES.has(type)) return;

    const open = match.index + match[0].length - 1;
    const end = i + 1 < starts.length ? starts[i + 1].index : rawBib.length;
    // Le parseur ne lit que les accolades : une entrée entre parenthèses n'est jamais rendue.
    const whole = match[2] === '{' && closesCleanly(rawBib, open, end);

    // Une définition @string que le parseur n'a pas lue : les valeurs qui la citent seraient
    // réécrites avec l'abréviation à la place du texte, et la définition perdue.
    if (type === 'string') {
      hasStringMacros = true;
      if (!whole) unreadKeys.push('string');
      return;
    }

    const comma = rawBib.indexOf(',', open + 1);
    const key = comma === -1 ? '' : rawBib.slice(open + 1, comma).trim();
    // Une clé qui déborde (virgule oubliée) ne se montre pas telle quelle : son premier mot suffit.
    const label = /^[^\s{}(),=]+$/.test(key) ? key : rawBib.slice(open + 1, end).trim().split(/[\s,{}()=]/)[0] || `@${type}`;

    const remaining = left.get(key) ?? 0;
    if (remaining > 0) left.set(key, remaining - 1);
    if (remaining === 0 || !whole) {
      unreadKeys.push(label);
      if (ZOTERO_KEY_FIELD.test(rawBib.slice(open, end))) unreadFromZotero.push(label);
    }
  });

  return { unreadKeys, unreadFromZotero, hasStringMacros };
}
