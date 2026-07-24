/**
 * Basculement des marques inline markdown (gras/italique) — #10.
 *
 * L'ancien chemin (`insertFormatting`) remplaçait la sélection par un
 * placeholder : sélectionner un mot puis Cmd+B **écrasait** le mot. Ici la
 * sélection est entourée (wrap) ou débarrassée de ses marques (unwrap), et
 * une sélection vide insère les marques avec le placeholder sélectionné —
 * la frappe suivante le remplace.
 *
 * La logique est une fonction pure sur (doc, from, to) pour être testable
 * sous vitest node (pas d'EditorView hors DOM) ; le wrapper CM6 ne fait
 * que dispatcher le résultat.
 */
import type { EditorView } from '@codemirror/view';
import { changeOrigin } from './change-origin';

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
  bold: { markers: ['**', '__'] as const, placeholder: 'texte en gras' },
  italic: { markers: ['_', '*'] as const, placeholder: 'texte en italique' },
} as const;

export type InlineMarkType = keyof typeof INLINE_MARKS;

/** Commande CM6 : bascule la marque sur la sélection principale. */
export function toggleInlineMark(view: EditorView, type: InlineMarkType): boolean {
  const { markers, placeholder } = INLINE_MARKS[type];
  const { from, to } = view.state.selection.main;
  const r = computeInlineToggle(
    view.state.doc.toString(),
    from,
    to,
    markers,
    placeholder
  );
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: r.insert },
    selection: { anchor: r.selFrom, head: r.selTo },
    annotations: changeOrigin.of('programmatic'),
  });
  view.focus();
  return true;
}
