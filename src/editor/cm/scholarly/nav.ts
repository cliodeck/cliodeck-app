import { EditorSelection, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  findDefinition,
  findFirstReference,
  footnoteAt,
} from './footnote-lookup';
import { openFootnotePopup } from './footnote-popup';

/**
 * Navigation bidirectionnelle des notes (Phase 3b, parité Milkdown) :
 * clic sur un exposant → définition ; clic sur l'en-tête `[^id]:` d'une
 * définition → premier appel ; Cmd/Ctrl+clic sur un exposant → popup
 * d'édition en place.
 */

function jumpTo(view: EditorView, pos: number): void {
  view.dispatch({
    selection: EditorSelection.cursor(pos),
    effects: EditorView.scrollIntoView(pos, { y: 'center' }),
  });
  view.focus();
}

export function scholarlyNav(): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = event.target as HTMLElement;
      const el = target.closest?.(
        '.cm-live-footnote-ref, .cm-live-footnote-def'
      );
      if (!el) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const fn = footnoteAt(view.state, pos);
      if (!fn) return false;

      if (fn.kind === 'reference') {
        if (event.metaKey || event.ctrlKey) {
          view.dispatch({
            effects: openFootnotePopup.of({ label: fn.label, at: fn.to }),
          });
        } else {
          const def = findDefinition(view.state, fn.label);
          if (def) jumpTo(view, def.contentFrom);
          else {
            // Pas de définition : le popup permet de la créer.
            view.dispatch({
              effects: openFootnotePopup.of({ label: fn.label, at: fn.to }),
            });
          }
        }
        event.preventDefault();
        return true;
      }

      // Définition → retour au premier appel.
      const ref = findFirstReference(view.state, fn.label);
      if (ref) {
        jumpTo(view, ref.from);
        event.preventDefault();
        return true;
      }
      return false;
    },
  });
}
