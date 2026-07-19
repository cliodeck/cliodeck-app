import type { EditorState, Text } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';
import { detectFrontmatterLines, isSeparatorLine } from '../../slides';

/**
 * Rendu live — partie pure (plan CM6, Phase 2).
 *
 * Calcule, à partir de l'arbre Lezer et de la sélection, des DESCRIPTEURS de
 * décorations : quels marqueurs masquer, quelles lignes styler, quels widgets
 * poser. Aucune dépendance DOM — testable en node. La traduction en
 * `Decoration` CM6 vit dans plugin.ts.
 *
 * Règle de révélation : un marqueur est masqué SAUF si une sélection
 * intersecte la portée de révélation de sa construction — le nœud pour
 * l'inline (emphase, lien...), la ligne pour les constructions de ligne
 * (titres, quotes, tâches, règles), le bloc entier pour les fences.
 * Le document n'est JAMAIS modifié : uniquement des décorations.
 */

export type LiveDeco =
  | { kind: 'hide'; from: number; to: number }
  | { kind: 'line'; at: number; class: string }
  | { kind: 'mark'; from: number; to: number; class: string; url?: string }
  | { kind: 'checkbox'; from: number; to: number; checked: boolean }
  | { kind: 'hr'; from: number; to: number }
  /** Frontière de slide numérotée (mode presentation) : `number` = ordinal
   *  de la slide qui COMMENCE après ce séparateur (la 1re slide n'a pas de
   *  frontière). */
  | { kind: 'slide-boundary'; from: number; to: number; number: number };

/** Référence bibliographique résolue (Phase 3b). */
export interface ResolvedCitation {
  author: string;
  year: string;
  title: string;
}

export interface LiveModelOptions {
  /**
   * Résolution d'une clé de citation vers la bibliographie. `null` → clé
   * inconnue, signalée visuellement (soulignement ondulé) sans bloquer.
   * Absent → aucune vérification (les clés ne sont pas soulignées).
   */
  resolveCitation?: (key: string) => ResolvedCitation | null;

  /**
   * Mode presentation (chantier « même éditeur ») : les lignes `---`
   * séparatrices de slides (au sens de src/editor/slides.ts : hors blocs
   * de code, hors frontmatter) sont rendues comme des frontières
   * numérotées au lieu de règles horizontales. Les autres HR (`***`, `___`)
   * gardent leur rendu. Coût : un balayage des lignes du document par
   * recalcul — réservé aux decks (petits par nature), ne pas activer pour
   * la prose.
   */
  slideSeparators?: boolean;

  /** Libellé de la frontière (i18n, câblé par le wrapper). Défaut `Slide n`. */
  slideLabel?: (n: number) => string;
}

export interface ImageSpec {
  /** Fin de la ligne contenant l'image (position du widget bloc). */
  widgetPos: number;
  from: number;
  to: number;
  src: string;
  alt: string;
}

interface Span {
  from: number;
  to: number;
}

/** Intersection large : un curseur posé à la frontière révèle aussi. */
function touches(ranges: readonly Span[], from: number, to: number): boolean {
  for (const r of ranges) {
    if (r.from <= to && r.to >= from) return true;
  }
  return false;
}

/**
 * Séparateurs de slides du document : offset de début de ligne → ordinal de
 * la slide qui suit (1-based ; premier séparateur → slide 2). Balayage des
 * lignes + exclusion des blocs de code via l'arbre et du frontmatter via la
 * règle partagée. Utilisé seulement quand `slideSeparators` est actif.
 */
export function computeSlideSeparators(
  doc: Text,
  tree: Tree
): Map<number, { from: number; to: number; number: number }> {
  const out = new Map<number, { from: number; to: number; number: number }>();

  const scan = Math.min(doc.lines, 100);
  const headLines: string[] = [];
  for (let n = 1; n <= scan; n++) headLines.push(doc.line(n).text);
  const fm = detectFrontmatterLines(headLines);
  const firstLine = fm ? fm.closingLine + 2 : 1; // closingLine 0-based → 1-based +1

  const inCode = (pos: number): boolean => {
    for (
      let node: SyntaxNode | null = tree.resolveInner(pos, 1);
      node;
      node = node.parent
    ) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') return true;
    }
    return false;
  };

  let ordinal = 0;
  for (let n = firstLine; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (isSeparatorLine(line.text) && !inCode(line.from)) {
      ordinal++;
      out.set(line.from, { from: line.from, to: line.to, number: ordinal + 1 });
    }
  }
  return out;
}

const ATX_HEADING = /^ATXHeading(\d)$/;
const INLINE_WRAPPERS = new Set([
  'Emphasis',
  'StrongEmphasis',
  'Strikethrough',
  'InlineCode',
]);
const INLINE_MARKS = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark']);

export function computeLiveDecorations(
  state: EditorState,
  tree: Tree,
  visible: readonly Span[],
  selection: readonly Span[],
  options: LiveModelOptions = {}
): LiveDeco[] {
  const out: LiveDeco[] = [];
  const doc = state.doc;
  const lineClasses = new Set<string>(); // dédup "at:class"

  const addLine = (at: number, cls: string) => {
    const key = `${at}:${cls}`;
    if (lineClasses.has(key)) return;
    lineClasses.add(key);
    out.push({ kind: 'line', at, class: cls });
  };

  const hide = (from: number, to: number) => {
    if (to > from) out.push({ kind: 'hide', from, to });
  };

  /** Masque un marqueur en absorbant l'espace qui le suit (`# `, `> `). */
  const hideWithTrailingSpace = (from: number, to: number) => {
    hide(from, doc.sliceString(to, to + 1) === ' ' ? to + 1 : to);
  };

  const lineTouched = (pos: number): boolean => {
    const line = doc.lineAt(pos);
    return touches(selection, line.from, line.to);
  };

  // Frontières de slides (mode presentation) — émises HORS de l'itération
  // d'arbre : un `---` collé sous un paragraphe parse en SetextHeading,
  // pas en HorizontalRule, mais reste un séparateur de deck (sémantique
  // partagée de src/editor/slides.ts).
  const separators = options.slideSeparators
    ? computeSlideSeparators(doc, tree)
    : null;
  if (separators) {
    for (const sep of separators.values()) {
      if (
        touches(visible, sep.from, sep.to) &&
        !lineTouched(sep.from) &&
        sep.to > sep.from
      ) {
        out.push({
          kind: 'slide-boundary',
          from: sep.from,
          to: sep.to,
          number: sep.number,
        });
      }
    }
  }

  for (const range of visible) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (node) => {
        const name = node.name;

        // ---- Titres ATX -------------------------------------------------
        const h = ATX_HEADING.exec(name);
        if (h) {
          addLine(doc.lineAt(node.from).from, `cm-live-h cm-live-h${h[1]}`);
          if (!touches(selection, node.from, node.to)) {
            for (const mark of node.node.getChildren('HeaderMark')) {
              hideWithTrailingSpace(mark.from, mark.to);
            }
          }
          return;
        }

        // ---- Emphase / gras / barré / code inline -----------------------
        if (INLINE_WRAPPERS.has(name)) {
          if (name === 'InlineCode') {
            out.push({
              kind: 'mark',
              from: node.from,
              to: node.to,
              class: 'cm-live-inline-code',
            });
          }
          if (!touches(selection, node.from, node.to)) {
            const cursor = node.node.cursor();
            if (cursor.firstChild()) {
              do {
                if (INLINE_MARKS.has(cursor.name)) hide(cursor.from, cursor.to);
              } while (cursor.nextSibling());
            }
          }
          return;
        }

        // ---- Notes de bas de page (Phase 3b) -----------------------------
        // Appel : label en exposant, marqueurs `[^` / `]` masqués hors nœud
        // actif. Le span cliquable (navigation, popup Cmd+clic) est le nœud
        // entier — les handlers vivent dans scholarly/.
        if (name === 'FootnoteReference') {
          const label = node.node.getChild('FootnoteLabel');
          if (!label) return false;
          out.push({
            kind: 'mark',
            from: node.from,
            to: node.to,
            class: 'cm-live-footnote-ref',
          });
          if (!touches(selection, node.from, node.to)) {
            hide(node.from, label.from); // `[^`
            hide(label.to, node.to); // `]`
          }
          return false;
        }

        // Définition : `[^id]:` stylé, contenu normal (jamais masqué —
        // c'est le texte de la note).
        if (name === 'FootnoteDefinition') {
          const label = node.node.getChild('FootnoteLabel');
          const marks = node.node.getChildren('FootnoteMark');
          if (label && marks.length >= 2) {
            out.push({
              kind: 'mark',
              from: marks[0].from,
              to: marks[marks.length - 1].to,
              class: 'cm-live-footnote-def',
            });
          }
          return; // le corps (paragraphes enfants) se rend normalement
        }

        // ---- Citations pandoc (Phase 3b) ---------------------------------
        // Pastille sur le cluster ; `[`, `]`, `@` masqués hors nœud actif
        // (les `;` restent : ils séparent les clés d'un cluster). Clé non
        // résolue → soulignement ondulé, sans bloquer.
        if (name === 'PandocCitation') {
          out.push({
            kind: 'mark',
            from: node.from,
            to: node.to,
            class: 'cm-live-citation',
          });
          const revealed = touches(selection, node.from, node.to);
          const cursor = node.node.cursor();
          if (cursor.firstChild()) {
            do {
              if (cursor.name === 'CitationMark' && !revealed) {
                const ch = doc.sliceString(cursor.from, cursor.to);
                if (ch !== ';') hide(cursor.from, cursor.to);
              } else if (
                cursor.name === 'CitationKey' &&
                options.resolveCitation &&
                options.resolveCitation(
                  doc.sliceString(cursor.from, cursor.to)
                ) === null
              ) {
                out.push({
                  kind: 'mark',
                  from: cursor.from,
                  to: cursor.to,
                  class: 'cm-live-citation-unresolved',
                });
              }
            } while (cursor.nextSibling());
          }
          return false;
        }

        // ---- Liens ------------------------------------------------------
        if (name === 'Link') {
          const url = node.node.getChild('URL');
          if (!url) return;
          const marks = node.node.getChildren('LinkMark');
          if (marks.length < 2) return;
          const textFrom = marks[0].to;
          const textTo = marks[1].from;
          out.push({
            kind: 'mark',
            from: textFrom,
            to: textTo,
            class: 'cm-live-link',
            url: doc.sliceString(url.from, url.to),
          });
          if (!touches(selection, node.from, node.to)) {
            hide(node.from, textFrom);
            hide(textTo, node.to);
          }
          return false;
        }

        if (name === 'Autolink') {
          const url = node.node.getChild('URL');
          if (!url) return;
          out.push({
            kind: 'mark',
            from: url.from,
            to: url.to,
            class: 'cm-live-link',
            url: doc.sliceString(url.from, url.to),
          });
          if (!touches(selection, node.from, node.to)) {
            for (const mark of node.node.getChildren('LinkMark')) {
              hide(mark.from, mark.to);
            }
          }
          return false;
        }

        // ---- Images : la source devient une légende, le visuel est un
        // widget bloc posé par le StateField (images.ts) ------------------
        if (name === 'Image') {
          const url = node.node.getChild('URL');
          const marks = node.node.getChildren('LinkMark');
          if (!url || marks.length < 2) return;
          const altFrom = marks[0].to;
          const altTo = marks[1].from;
          out.push({
            kind: 'mark',
            from: altFrom,
            to: altTo,
            class: 'cm-live-image-alt',
          });
          if (!touches(selection, node.from, node.to)) {
            hide(node.from, altFrom);
            hide(altTo, node.to);
          }
          return false;
        }

        // ---- Échappements Milkdown (`\[`) : masquer le backslash --------
        if (name === 'Escape') {
          if (!touches(selection, node.from, node.to)) {
            hide(node.from, node.from + 1);
          }
          return;
        }

        // ---- Blockquotes -------------------------------------------------
        if (name === 'Blockquote') {
          const first = doc.lineAt(node.from).number;
          const last = doc.lineAt(node.to).number;
          for (let n = first; n <= last; n++) {
            addLine(doc.line(n).from, 'cm-live-quote');
          }
          return; // les QuoteMark sont des descendants, traités ci-dessous
        }

        if (name === 'QuoteMark') {
          if (!lineTouched(node.from)) {
            hideWithTrailingSpace(node.from, node.to);
          }
          return;
        }

        // ---- Règles horizontales -----------------------------------------
        if (name === 'HorizontalRule') {
          // Un `---` en tout début de document ouvre un frontmatter YAML
          // (P3b) : ne pas le rendre comme une règle.
          if (node.from === 0) return;
          // Mode presentation : les séparateurs de slides sont des
          // frontières numérotées (émises plus haut), pas des HR.
          if (separators?.has(doc.lineAt(node.from).from)) return;
          if (!lineTouched(node.from)) {
            out.push({ kind: 'hr', from: node.from, to: node.to });
          }
          return;
        }

        // ---- Cases à cocher ----------------------------------------------
        if (name === 'TaskMarker') {
          if (!lineTouched(node.from)) {
            const text = doc.sliceString(node.from, node.to);
            out.push({
              kind: 'checkbox',
              from: node.from,
              to: node.to,
              checked: /[xX]/.test(text),
            });
          }
          return;
        }

        // ---- Blocs de code -----------------------------------------------
        if (name === 'FencedCode') {
          const firstLine = doc.lineAt(node.from);
          const lastLine = doc.lineAt(node.to);
          for (let n = firstLine.number; n <= lastLine.number; n++) {
            addLine(doc.line(n).from, 'cm-live-code');
          }
          if (!touches(selection, node.from, node.to)) {
            const marks = node.node.getChildren('CodeMark');
            const closing = marks.length >= 2 ? marks[marks.length - 1] : null;
            if (closing && doc.lineAt(closing.from).number > firstLine.number) {
              hide(firstLine.from, firstLine.to);
              const closingLine = doc.lineAt(closing.from);
              hide(closingLine.from, closingLine.to);
            }
          }
          // La coloration interne (CodeText) est faite par le parseur de la
          // langue (codeLanguages), pas par le rendu live.
          return false;
        }

        return;
      },
    });
  }

  return out;
}

/**
 * Localise les images d'une plage du document (pour les widgets bloc).
 * Pure ; utilisée par le StateField avec l'arbre complet.
 */
export function findImages(
  state: EditorState,
  tree: Tree,
  from: number,
  to: number
): ImageSpec[] {
  const out: ImageSpec[] = [];
  const doc = state.doc;
  tree.iterate({
    from,
    to,
    enter: (node) => {
      if (node.name !== 'Image') return;
      const url = node.node.getChild('URL');
      const marks = node.node.getChildren('LinkMark');
      if (!url || marks.length < 2) return false;
      out.push({
        widgetPos: doc.lineAt(node.from).to,
        from: node.from,
        to: node.to,
        src: doc.sliceString(url.from, url.to),
        alt: doc.sliceString(marks[0].to, marks[1].from),
      });
      return false;
    },
  });
  return out;
}
