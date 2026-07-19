import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Text,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from '@codemirror/view';
import { detectFrontmatterLines } from '../../slides';
import type { ScholarlyLabels } from './types';

/**
 * Frontmatter YAML replié (Phase 3b) : si le document commence par un bloc
 * `---` … `---`, il est replié au chargement en un widget d'une ligne ;
 * clic → dépliage en source éditable ; un bouton en fin de première ligne
 * permet de le replier. État de pli dans un StateField — le pli ne modifie
 * JAMAIS le document.
 */

const MAX_SCAN_LINES = 100;

export const setFrontmatterFolded = StateEffect.define<boolean>();

interface FrontmatterRange {
  /** Toujours 0. */
  from: number;
  /** Fin de la ligne `---` de clôture (sans son saut de ligne). */
  to: number;
  preview: string;
}

export function detectFrontmatter(doc: Text): FrontmatterRange | null {
  if (doc.lines < 2) return null;
  // Règle partagée avec parseSlides (src/editor/slides.ts) : un deck qui
  // ouvre sur un séparateur `---` (ligne vide ensuite, ou aucun corps
  // YAML) n'est PAS un frontmatter — le repli aveugle transformait la
  // première slide en faux frontmatter (état des lieux slides §2).
  const last = Math.min(doc.lines, MAX_SCAN_LINES);
  const lines: string[] = [];
  for (let n = 1; n <= last; n++) lines.push(doc.line(n).text);
  const fm = detectFrontmatterLines(lines);
  if (!fm) return null;
  const closing = doc.line(fm.closingLine + 1); // closingLine est 0-based
  const body = doc.sliceString(doc.line(1).to, closing.from).trim();
  return {
    from: 0,
    to: closing.to,
    preview: body.length > 200 ? `${body.slice(0, 200)}…` : body,
  };
}

class FoldedFrontmatterWidget extends WidgetType {
  constructor(
    private preview: string,
    private label: string
  ) {
    super();
  }

  override eq(other: FoldedFrontmatterWidget): boolean {
    return other.preview === this.preview && other.label === this.label;
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement('div');
    dom.className = 'cm-scholarly-frontmatter-folded';
    dom.textContent = '⋯ frontmatter';
    dom.title = this.preview ? `${this.label}\n\n${this.preview}` : this.label;
    dom.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ effects: setFrontmatterFolded.of(false) });
    });
    return dom;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class FoldButtonWidget extends WidgetType {
  constructor(private label: string) {
    super();
  }

  override eq(other: FoldButtonWidget): boolean {
    return other.label === this.label;
  }

  toDOM(view: EditorView): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-scholarly-frontmatter-fold-btn';
    btn.textContent = '⌃';
    btn.title = this.label;
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ effects: setFrontmatterFolded.of(true) });
    });
    return btn;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

function buildDecorations(
  state: EditorState,
  folded: boolean,
  labels: ScholarlyLabels
): DecorationSet {
  const fm = detectFrontmatter(state.doc);
  if (!fm) return Decoration.none;

  if (folded) {
    return Decoration.set([
      Decoration.replace({
        widget: new FoldedFrontmatterWidget(fm.preview, labels.frontmatterFolded),
        block: true,
      }).range(fm.from, fm.to),
    ]);
  }

  // Déplié : lignes teintées + bouton de repli en fin de première ligne.
  const ranges = [];
  const firstLine = state.doc.line(1);
  ranges.push(
    Decoration.widget({
      widget: new FoldButtonWidget(labels.frontmatterFold),
      side: 1,
    }).range(firstLine.to)
  );
  const lastLine = state.doc.lineAt(fm.to);
  for (let n = 1; n <= lastLine.number; n++) {
    ranges.push(
      Decoration.line({ class: 'cm-scholarly-frontmatter-line' }).range(
        state.doc.line(n).from
      )
    );
  }
  return Decoration.set(ranges, true);
}

export function frontmatterFold(labels: ScholarlyLabels): Extension {
  const field = StateField.define<{ folded: boolean; deco: DecorationSet }>({
    create(state) {
      const folded = detectFrontmatter(state.doc) !== null;
      return { folded, deco: buildDecorations(state, folded, labels) };
    },
    update(value, tr) {
      let folded = value.folded;
      for (const e of tr.effects) {
        if (e.is(setFrontmatterFolded)) folded = e.value;
      }
      if (!tr.docChanged && folded === value.folded) return value;
      return { folded, deco: buildDecorations(tr.state, folded, labels) };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });
  return field;
}
