/**
 * Ce que le parseur a laissé d'un `.bib` : à vérifier avant de réécrire le fichier.
 *
 * `BibTeXParser.lastRejected` ne voit que les entrées sans titre. Une accolade qui ne se ferme pas
 * fait sauter l'entrée sans rien noter, une accolade fermante de trop la coupe en route, une
 * entrée entre parenthèses ne se lit pas, et une définition `@string` n'est rendue nulle part. La
 * synchronisation Zotero réécrivait le fichier à partir de ce que le parseur avait rendu : tout le
 * reste disparaissait, sans un mot (S07-1-2).
 *
 * Ce n'est pas un second lecteur de `.bib` : on compte les entrées du texte, une par `@type{clé`
 * en début de ligne, contre celles que le parseur a rendues. Limite assumée : une valeur qui
 * contient `@x{y,` en début de ligne compte pour une entrée, et la clé `y` est signalée à tort.
 */
import type { Citation } from '../../types/citation';

export interface BibAudit {
  /** Clés des entrées du texte que le parseur n'a pas rendues, ou pas en entier. */
  unreadKeys: string[];
  /** Le fichier définit des `@string`, qu'une réécriture perdrait. */
  hasStringMacros: boolean;
}

/** Un `@type{` ou `@type(` en début de ligne, BOM et indentation permis. */
const ENTRY_START = /^[ \t\uFEFF]*@[ \t]*([A-Za-z][\w-]*)[ \t]*([{(])/gm;

/** Ce que le parseur saute : ce ne sont pas des références. */
const NOT_REFERENCES = new Set(['comment', 'string', 'preamble']);

/**
 * L'entrée ouverte à `open` se ferme-t-elle avant `end`, sans accolade orpheline derrière elle ?
 * Les accolades se comptent comme le fait le parseur, échappées comprises : c'est ce qu'il a lu
 * qu'on contrôle. Derrière la fermeture, on s'arrête au premier `@` : une autre entrée sur la
 * même ligne, ou une adresse dans un commentaire, n'est pas une accolade de trop.
 */
function closesCleanly(text: string, open: number, end: number): boolean {
  let depth = 0;
  for (let i = open; i < end; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) {
      const after = text.slice(i + 1, end);
      const at = after.indexOf('@');
      return !/[{}]/.test(at === -1 ? after : after.slice(0, at));
    }
  }
  return false;
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
  let hasStringMacros = false;

  starts.forEach((match, i) => {
    const type = match[1].toLowerCase();
    if (type === 'string') hasStringMacros = true;
    if (NOT_REFERENCES.has(type)) return;

    const open = match.index + match[0].length - 1;
    const end = i + 1 < starts.length ? starts[i + 1].index : rawBib.length;
    const comma = rawBib.indexOf(',', open + 1);
    const key = comma === -1 ? '' : rawBib.slice(open + 1, comma).trim();
    // Une clé qui déborde (virgule oubliée) ne se montre pas telle quelle : son premier mot suffit.
    const label = /^[^\s{}(),=]+$/.test(key) ? key : rawBib.slice(open + 1, end).trim().split(/[\s,{}()=]/)[0] || `@${type}`;

    const remaining = left.get(key) ?? 0;
    if (remaining > 0) left.set(key, remaining - 1);
    // Le parseur ne lit que les accolades : une entrée entre parenthèses n'est jamais rendue.
    const whole = match[2] === '{' && closesCleanly(rawBib, open, end);
    if (remaining === 0 || !whole) unreadKeys.push(label);
  });

  return { unreadKeys, hasStringMacros };
}
