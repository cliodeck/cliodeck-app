/**
 * Basculement des marques inline markdown (gras/italique) — #10 — et mise en
 * forme de la sélection (lien, citation, citation en bloc, tableau).
 *
 * L'ancien chemin (`insertFormatting`) remplaçait la sélection par un
 * placeholder : sélectionner un mot puis Cmd+B **écrasait** le mot. Ici la
 * sélection est entourée (wrap) ou débarrassée de ses marques (unwrap), et
 * une sélection vide insère les marques avec le placeholder sélectionné —
 * la frappe suivante le remplace.
 *
 * La logique est une fonction pure sur (doc, from, to) pour être testable
 * sous vitest node (pas d'EditorView hors DOM) ; le wrapper CM6 ne fait
 * que dispatcher le résultat. `doc` est `state.doc.toString()` : une fin de
 * ligne y vaut 1, comme dans les offsets de CM6, quel que soit le fichier.
 * Jamais `readDocText` ou `facade.getValue()`, qui rendent les CRLF.
 */
import { isolateHistory } from '@codemirror/commands';
import { Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { detectFrontmatterLines, parseSlides } from '../slides';
import { changeOrigin, type ChangeOrigin } from './change-origin';

export interface InlineToggleResult {
  /** Bornes du remplacement dans le document d'origine. */
  from: number;
  to: number;
  /** Texte inséré à la place de [from, to). */
  insert: string;
  /** Sélection résultante (offsets dans le document APRÈS remplacement). */
  selFrom: number;
  selTo: number;
}

/** Ce qu'une commande fait de la sélection principale : une fonction pure, en offsets du document. */
export type SelectionEdit = (doc: string, from: number, to: number) => InlineToggleResult;

/**
 * `markers` : la première entrée est la marque écrite au wrap ; toutes
 * sont reconnues à l'unwrap (`**` posé par ClioDeck, mais `__`, `*` ou
 * `_` peuvent venir d'un document externe).
 */
export function computeInlineToggle(
  doc: string,
  from: number,
  to: number,
  markers: readonly string[],
  placeholder: string
): InlineToggleResult {
  const primary = markers[0];

  // Sélection vide : insérer les marques avec le placeholder sélectionné.
  if (from === to) {
    return {
      from,
      to,
      insert: `${primary}${placeholder}${primary}`,
      selFrom: from + primary.length,
      selTo: from + primary.length + placeholder.length,
    };
  }

  const sel = doc.slice(from, to);

  for (const m of markers) {
    // Cas 1 : la sélection INCLUT les marques (« **mot** » sélectionné).
    if (
      sel.length >= 2 * m.length &&
      sel.startsWith(m) &&
      sel.endsWith(m) &&
      // `*` ne doit pas amputer une paire `**` : la marque simple n'est
      // reconnue que si le caractère suivant/précédent n'est pas aussi `*`.
      !(m.length === 1 && (sel[m.length] === m || sel[sel.length - m.length - 1] === m))
    ) {
      const inner = sel.slice(m.length, sel.length - m.length);
      return { from, to, insert: inner, selFrom: from, selTo: from + inner.length };
    }

    // Cas 2 : les marques ENTOURENT la sélection (« mot » sélectionné
    // dans « **mot** »).
    const before = doc.slice(Math.max(0, from - m.length), from);
    const after = doc.slice(to, to + m.length);
    if (
      before === m &&
      after === m &&
      !(m.length === 1 && (doc[from - 2] === m || doc[to + 1] === m))
    ) {
      return {
        from: from - m.length,
        to: to + m.length,
        insert: sel,
        selFrom: from - m.length,
        selTo: from - m.length + sel.length,
      };
    }
  }

  // Cas 3 : wrap.
  return {
    from,
    to,
    insert: `${primary}${sel}${primary}`,
    selFrom: from + primary.length,
    selTo: from + primary.length + sel.length,
  };
}

export const INLINE_MARKS = {
  bold: { markers: ['**', '__'] as const },
  italic: { markers: ['_', '*'] as const },
} as const;

export type InlineMarkType = keyof typeof INLINE_MARKS;

export type SelectionWrapType = 'link' | 'citation' | 'blockquote' | 'table';

/** Les gabarits à écrire dans le manuscrit, traduits par l'appelant : ce module ne lit aucun store. */
export interface SnippetTemplates {
  linkText: string;
  citationKey: string;
  /** Le bloc entier, sauts de ligne compris. */
  table: string;
  blockquote: string;
  boldText: string;
  italicText: string;
}

export interface SelectionWrapOptions {
  /** Un deck : `---` y est une frontière de diapositive. Ailleurs, un filet ou un titre Setext, donc du texte. */
  keepSlideSeparators?: boolean;
}

/**
 * Une clé par sa forme : ni espace ni saut de ligne, commence par une lettre, finit par une lettre ou
 * un chiffre, et porte un chiffre, un `:` ou un `_`, comme `Smith2020`. Un mot ordinaire n'en est
 * pas une : `histoire` ne doit pas devenir `[@histoire]`, ni `1914` ou `1er`. Une clé sans rien de
 * tout cela (`braudel`) reçoit le gabarit à côté d'elle : rien de perdu, et Cmd+Z la rend.
 */
export function looksLikeCitationKey(text: string): boolean {
  return /^\p{L}([\p{L}\p{N}_:.#$%&+?<>~-]*[\p{L}\p{N}_])?$/u.test(text) && /[\d:_]/.test(text);
}

/** Insère à cet endroit, le curseur derrière. */
function insertAt(at: number, insert: string): InlineToggleResult {
  return { from: at, to: at, insert, selFrom: at + insert.length, selTo: at + insert.length };
}

/** Pour une édition qui laisse la sélection intacte : un bouton de diapositive, un tableau. */
export function insertAfterSelection(insert: string): SelectionEdit {
  return (_doc, _from, to) => insertAt(to, insert);
}

/**
 * Préfixe les lignes touchées, en entier. Une ligne déjà préfixée se préfixe encore : le menu dit
 * « Insérer », et `> >` est du Markdown, qu'un Cmd+Z retire.
 *
 * Ce qui n'est pas du texte reste tel quel : le frontmatter, partout, et dans un deck les frontières
 * de diapositive, dont un `---` de bloc de code ne fait pas partie. Les lignes vides qui les bordent
 * restent vides, sélectionnées ou non : `---` suivi d'une ligne non vide peut ouvrir un frontmatter
 * (`detectFrontmatterLines`), et le deck y perdrait des diapositives.
 */
function quoteLines(doc: string, from: number, to: number, keepSlideSeparators: boolean): InlineToggleResult {
  const lineFrom = from === 0 ? 0 : doc.lastIndexOf('\n', from - 1) + 1;
  // Une sélection qui s'arrête en tête de ligne (triple clic, Maj+flèche) ne prend pas cette ligne.
  const nextBreak = doc.indexOf('\n', doc[to - 1] === '\n' ? to - 1 : to);
  const lineTo = nextBreak === -1 ? doc.length : nextBreak;

  const lines = doc.split('\n');
  const first = doc.slice(0, lineFrom).split('\n').length - 1;
  const count = doc.slice(lineFrom, lineTo).split('\n').length;
  const frontmatter = detectFrontmatterLines(lines);
  const separators = new Set(keepSlideSeparators ? parseSlides(doc).separatorLines : []);
  const isNotText = (index: number): boolean =>
    (frontmatter !== null && index <= frontmatter.closingLine) || separators.has(index);

  const insert = lines
    .slice(first, first + count)
    .map((line, offset) => {
      const index = first + offset;
      if (isNotText(index)) return line;
      if (line !== '') return `> ${line}`;
      return isNotText(index - 1) || isNotText(index + 1) ? line : '>';
    })
    .join('\n');
  return { from: lineFrom, to: lineTo, insert, selFrom: lineFrom, selTo: lineFrom + insert.length };
}

/**
 * Lien, citation, citation en bloc, tableau : la sélection est enveloppée ou laissée telle quelle,
 * jamais remplacée par le gabarit. Sélection vide : le gabarit, le curseur derrière.
 */
export function computeSelectionWrap(
  doc: string,
  from: number,
  to: number,
  type: SelectionWrapType,
  templates: SnippetTemplates,
  options: SelectionWrapOptions = {}
): InlineToggleResult {
  if (type === 'table') return insertAt(to, templates.table);
  if (type === 'blockquote') {
    return from === to
      ? insertAt(to, templates.blockquote)
      : quoteLines(doc, from, to, options.keepSlideSeparators === true);
  }

  // Un triple clic prend aussi la fin de ligne : elle reste hors de ce qu'on enveloppe.
  let end = to;
  while (end > from && doc[end - 1] === '\n') end -= 1;
  const sel = doc.slice(from, end);

  if (type === 'link') {
    if (sel === '') return insertAt(to, `[${templates.linkText}](url)`);
    const urlFrom = end + '[]('.length;
    return { from, to: end, insert: `[${sel}](url)`, selFrom: urlFrom, selTo: urlFrom + 'url'.length };
  }

  if (sel === '') return insertAt(to, `[@${templates.citationKey}]`);
  if (looksLikeCitationKey(doc.slice(from, to))) {
    const insert = `[@${sel}]`;
    return { from, to: end, insert, selFrom: from + insert.length, selTo: from + insert.length };
  }
  const keyFrom = end + ' [@'.length;
  return {
    from: end,
    to: end,
    insert: ` [@${templates.citationKey}]`,
    selFrom: keyFrom,
    selTo: keyFrom + templates.citationKey.length,
  };
}

/**
 * Applique une édition de la sélection, et rend faux si le document n'a pas changé : sur une vue en
 * lecture seule, où CM6 n'arrête que les commandes de l'auteur et pas un `dispatch` ; et quand le
 * texte calculé est celui qui est déjà là, que CM6 prendrait pour un changement (`isDirty`, une
 * écriture, et une étape vide que le Cmd+Z suivant consommerait sans rien faire). Le texte de `doc`
 * n'a que des `\n`, un `\r` n'y est jamais une fin de ligne : un `Text` coupé là reste juste dans un
 * fichier CRLF comme dans un fichier mixte. Sans `isolateHistory`, une transaction sans `userEvent`
 * se fondrait dans la frappe voisine, et Cmd+Z emporterait les deux.
 */
export function editSelection(view: EditorView, edit: SelectionEdit, origin: ChangeOrigin = 'programmatic'): boolean {
  if (view.state.readOnly) return false;
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc.toString();
  const r = edit(doc, from, to);
  if (r.insert === doc.slice(r.from, r.to)) {
    view.focus();
    return false;
  }
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: Text.of(r.insert.split('\n')) },
    selection: { anchor: r.selFrom, head: r.selTo },
    annotations: [changeOrigin.of(origin), isolateHistory.of('full')],
  });
  view.focus();
  return true;
}

/** Commande CM6 : bascule la marque sur la sélection principale. `placeholder` est traduit par l'appelant. */
export function toggleInlineMark(view: EditorView, type: InlineMarkType, placeholder: string): boolean {
  const { markers } = INLINE_MARKS[type];
  return editSelection(view, (doc, from, to) => computeInlineToggle(doc, from, to, markers, placeholder));
}
