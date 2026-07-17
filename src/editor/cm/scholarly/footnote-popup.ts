import {
  EditorView,
  showTooltip,
  type Tooltip,
  type TooltipView,
} from '@codemirror/view';
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { findDefinition } from './footnote-lookup';
import type { ScholarlyLabels } from './types';

/**
 * Popup d'édition en place d'une note (Phase 3b — comportement Zettlr) :
 * Cmd/Ctrl+clic sur un appel ouvre un éditeur ancré de la définition ;
 * valider dispatch UNE transaction remplaçant le corps de la définition
 * dans le source (ou la créant en fin de document) ; Échap / clic hors du
 * popup annule. Le popup ne touche jamais au DOM du document.
 */

export const openFootnotePopup = StateEffect.define<{
  label: string;
  at: number;
}>();
export const closeFootnotePopup = StateEffect.define<null>();

interface PopupState {
  label: string;
  at: number;
}

function popupTooltip(value: PopupState, labels: ScholarlyLabels): Tooltip {
  return {
    pos: value.at,
    above: false,
    arrow: true,
    create: (view: EditorView): TooltipView => {
      const dom = document.createElement('div');
      dom.className = 'cm-scholarly-popup';

      const def = findDefinition(view.state, value.label);
      const initial = def
        ? view.state.sliceDoc(def.contentFrom, def.contentTo)
        : '';

      const title = document.createElement('div');
      title.className = 'cm-scholarly-popup-title';
      title.textContent = `[^${value.label}]`;
      dom.appendChild(title);

      const textarea = document.createElement('textarea');
      textarea.rows = 4;
      textarea.value = initial;
      dom.appendChild(textarea);

      const actions = document.createElement('div');
      actions.className = 'cm-scholarly-popup-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.textContent = labels.cancel;
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'cm-scholarly-popup-save';
      saveBtn.textContent = labels.save;
      actions.append(cancelBtn, saveBtn);
      dom.appendChild(actions);

      const close = () => {
        view.dispatch({ effects: closeFootnotePopup.of(null) });
        view.focus();
      };

      const save = () => {
        const text = textarea.value;
        // Relocaliser la définition au moment du save : le document a pu
        // bouger pendant que le popup était ouvert.
        const current = findDefinition(view.state, value.label);
        if (current) {
          view.dispatch({
            changes: {
              from: current.contentFrom,
              to: current.contentTo,
              insert: text,
            },
          });
        } else {
          const doc = view.state.doc;
          const tail = doc.sliceString(Math.max(0, doc.length - 2));
          const sep =
            doc.length === 0 ? '' : tail.endsWith('\n\n') ? '' : tail.endsWith('\n') ? '\n' : '\n\n';
          view.dispatch({
            changes: {
              from: doc.length,
              insert: `${sep}[^${value.label}]: ${text}`,
            },
          });
        }
        close();
      };

      cancelBtn.addEventListener('click', close);
      saveBtn.addEventListener('click', save);
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          save();
        }
      });
      // Clic hors du popup → annule (focusout couvre clic + Tab).
      dom.addEventListener('focusout', (e) => {
        if (!dom.contains(e.relatedTarget as Node | null)) close();
      });

      return {
        dom,
        mount: () => {
          textarea.focus();
          textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        },
      };
    },
  };
}

export function footnotePopup(labels: ScholarlyLabels): Extension {
  const field = StateField.define<PopupState | null>({
    create: () => null,
    update(value, tr) {
      for (const e of tr.effects) {
        if (e.is(openFootnotePopup)) value = e.value;
        else if (e.is(closeFootnotePopup)) value = null;
      }
      if (value && tr.docChanged) {
        value = { ...value, at: tr.changes.mapPos(value.at) };
      }
      return value;
    },
    provide: (f) =>
      showTooltip.compute([f], (state) => {
        const value = state.field(f);
        return value ? popupTooltip(value, labels) : null;
      }),
  });
  return field;
}
