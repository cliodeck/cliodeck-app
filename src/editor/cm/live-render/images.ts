import { StateField, type EditorState } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { findImages } from './model';
import { ImageWidget } from './widgets';

/**
 * Aperçus d'images en widgets BLOC sous la ligne (plan CM6, P2 incrément 2).
 *
 * StateField et non ViewPlugin : CM6 interdit aux plugins les décorations
 * qui influencent la mise en page verticale. Toujours visibles (comme
 * Obsidian) — la révélation ne concerne que la source `![alt](url)`,
 * gérée par le ViewPlugin.
 *
 * Incrémental : les widgets sont mappés à travers les changements ; on ne
 * rescanne l'arbre que si l'édition peut concerner une image (insertion
 * contenant `![`, ligne touchée contenant `![`, ou widget existant dans la
 * plage modifiée).
 */

export interface LiveRenderOptions {
  /**
   * Résout la source d'une image vers une URL chargeable (les chemins
   * relatifs dépendent du projet ouvert). `null` → placeholder.
   */
  resolveImageSrc?: (src: string) => string | null;
}

function computeAll(
  state: EditorState,
  options: LiveRenderOptions,
  eager: boolean
): DecorationSet {
  const tree = eager
    ? (ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state))
    : syntaxTree(state);
  const ranges = findImages(state, tree, 0, state.doc.length).map((spec) =>
    Decoration.widget({
      widget: new ImageWidget(spec.src, spec.alt, options.resolveImageSrc),
      block: true,
      side: 1,
    }).range(spec.widgetPos)
  );
  return Decoration.set(ranges, true);
}

export function imageWidgets(options: LiveRenderOptions) {
  return StateField.define<DecorationSet>({
    create: (state) => computeAll(state, options, true),

    update: (value, tr) => {
      if (!tr.docChanged) return value;
      const mapped = value.map(tr.changes);
      let needs = false;
      tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
        if (needs) return;
        if (inserted.toString().includes('![')) {
          needs = true;
          return;
        }
        const doc = tr.state.doc;
        const start = doc.lineAt(Math.min(fromB, doc.length));
        const end = doc.lineAt(Math.min(toB, doc.length));
        for (let n = start.number; n <= end.number; n++) {
          if (doc.line(n).text.includes('![')) {
            needs = true;
            return;
          }
        }
        // Une image existante a-t-elle été touchée (suppression) ?
        value.between(fromA, toA, () => {
          needs = true;
          return false;
        });
      });
      return needs ? computeAll(tr.state, options, false) : mapped;
    },

    provide: (field) => EditorView.decorations.from(field),
  });
}
