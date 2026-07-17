import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import type { Range } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { computeLiveDecorations } from './model';
import { CheckboxWidget, HrWidget } from './widgets';

/**
 * Rendu live — ViewPlugin (plan CM6, Phase 2).
 *
 * Traduit les descripteurs purs de model.ts en décorations CM6, recalculées
 * incrémentalement sur le viewport uniquement (docChanged / selectionSet /
 * viewportChanged). Lezer est incrémental par conception : syntaxTree(state)
 * ne re-parse pas le document à la frappe.
 *
 * Les widgets BLOC (aperçus d'images) ne peuvent pas venir d'un ViewPlugin
 * (interdiction CM6 d'influencer la mise en page verticale) : ils vivent
 * dans le StateField d'images.ts.
 */

function buildDecorations(view: EditorView): DecorationSet {
  const decos = computeLiveDecorations(
    view.state,
    syntaxTree(view.state),
    view.visibleRanges,
    view.state.selection.ranges
  );
  const ranges: Range<Decoration>[] = [];
  for (const d of decos) {
    switch (d.kind) {
      case 'hide':
        ranges.push(Decoration.replace({}).range(d.from, d.to));
        break;
      case 'line':
        ranges.push(Decoration.line({ class: d.class }).range(d.at));
        break;
      case 'mark':
        if (d.to > d.from) {
          ranges.push(
            Decoration.mark({
              class: d.class,
              attributes: d.url
                ? { 'data-live-url': d.url, title: d.url }
                : undefined,
            }).range(d.from, d.to)
          );
        }
        break;
      case 'checkbox':
        ranges.push(
          Decoration.replace({ widget: new CheckboxWidget(d.checked) }).range(
            d.from,
            d.to
          )
        );
        break;
      case 'hr':
        ranges.push(
          Decoration.replace({ widget: new HrWidget() }).range(d.from, d.to)
        );
        break;
    }
  }
  return Decoration.set(ranges, true);
}

function openExternal(url: string): void {
  // Canal IPC existant (validation de protocole côté main) ; cast prudent
  // car les types du contextBridge ne sont pas visibles depuis src/editor.
  const api = (
    window as unknown as {
      electron?: { shell?: { openExternal?: (u: string) => unknown } };
    }
  ).electron;
  api?.shell?.openExternal?.(url);
}

export const liveRenderPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(event, view) {
        const target = event.target as HTMLElement;

        // Case à cocher : le clic édite le SOURCE via une transaction,
        // jamais le DOM. TODO Phase 4 : annotation changeOrigin.
        if (
          target instanceof HTMLInputElement &&
          target.classList.contains('cm-live-task')
        ) {
          const pos = view.posAtDOM(target);
          const marker = view.state.sliceDoc(pos, pos + 3);
          if (/^\[[ xX]\]$/.test(marker)) {
            view.dispatch({
              changes: {
                from: pos,
                to: pos + 3,
                insert: /[xX]/.test(marker) ? '[ ]' : '[x]',
              },
            });
            event.preventDefault();
            return true;
          }
          return false;
        }

        // Cmd/Ctrl+clic sur un lien : ouverture externe.
        if (event.metaKey || event.ctrlKey) {
          const link = target.closest?.('.cm-live-link');
          const url = link?.getAttribute('data-live-url');
          if (url) {
            openExternal(url);
            event.preventDefault();
            return true;
          }
        }
        return false;
      },
    },
  }
);
