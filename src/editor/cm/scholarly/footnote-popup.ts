import {
  EditorView,
  showTooltip,
  type Tooltip,
  type TooltipView,
} from '@codemirror/view';
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { findDefinition } from './footnote-lookup';
import { changeOrigin } from '../change-origin';
import { toDocText } from '../fidelity';
import type { ScholarlyLabels } from './types';

/**
 * Popup d'édition en place d'une note (Phase 3b — comportement Zettlr) :
 * Cmd/Ctrl+clic sur un appel ouvre un éditeur ancré de la définition ;
 * valider dispatch UNE transaction remplaçant le corps de la définition
 * dans le source (ou la créant en fin de document) ; Échap / clic hors du
 * popup annule. Le popup ne touche jamais au DOM du document.
 */

/**
 * Retrait des lignes qui suivent la première dans une définition : comme chez Pandoc, un
 * paragraphe suivant n'appartient à la note que s'il est indenté de quatre colonnes (S14-1-7).
 * La popup montre le corps sans ce retrait et le remet à l'enregistrement : un second paragraphe
 * tapé reste dans la note, et une note qui en a deux revient octet pour octet. Une tabulation
 * vaut quatre colonnes : elle s'ôte, et revient en quatre espaces.
 *
 * Cela ne vaut qu'au niveau du document (`DefinitionRange.topLevel`). Dans une citation en bloc ou
 * une liste, le retrait se compte depuis le conteneur (`>` puis quatre colonnes, ou le retrait de
 * l'élément plus quatre) : quatre espaces posés devant un `>` feraient sortir le paragraphe de la
 * note et de la citation. La popup écrit alors le corps tel quel, comme avant.
 */
const CONTINUATION = '    ';

function bodyToPopup(body: string): string {
  return body
    .split('\n')
    .map((line, i) => (i === 0 ? line : line.replace(/^(?: {0,3}\t| {1,4})/, '')))
    .join('\n');
}

function popupToBody(text: string): string {
  return text
    .split(/\r\n?|\n/)
    .map((line, i) => (i > 0 && /\S/.test(line) ? CONTINUATION + line : line))
    .join('\n');
}

export const openFootnotePopup = StateEffect.define<{
  label: string;
  at: number;
}>();
export const closeFootnotePopup = StateEffect.define<null>();

interface PopupState {
  label: string;
  at: number;
}

function popupTooltip(
  value: PopupState,
  labels: ScholarlyLabels,
  field: StateField<PopupState | null>
): Tooltip {
  return {
    pos: value.at,
    above: false,
    arrow: true,
    create: (view: EditorView): TooltipView => {
      const dom = document.createElement('div');
      dom.className = 'cm-scholarly-popup';

      const def = findDefinition(view.state, value.label);
      const body = def ? view.state.sliceDoc(def.contentFrom, def.contentTo) : '';
      const initial = def?.topLevel ? bodyToPopup(body) : body;

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
        // Relocaliser la définition au moment du save : le document a pu
        // bouger pendant que le popup était ouvert.
        const current = findDefinition(view.state, value.label);
        if (current) {
          const text = current.topLevel ? popupToBody(textarea.value) : textarea.value;
          view.dispatch({
            changes: {
              from: current.contentFrom,
              to: current.contentTo,
              insert: toDocText(text),
            },
            annotations: changeOrigin.of('programmatic'),
          });
        } else {
          // Créée en fin de document, après une ligne vide et en colonne 0 : au niveau du document.
          const text = popupToBody(textarea.value);
          const doc = view.state.doc;
          const tail = doc.sliceString(Math.max(0, doc.length - 2));
          const sep =
            doc.length === 0 ? '' : tail.endsWith('\n\n') ? '' : tail.endsWith('\n') ? '\n' : '\n\n';
          view.dispatch({
            changes: {
              from: doc.length,
              insert: toDocText(`${sep}[^${value.label}]: ${text}`),
            },
            annotations: changeOrigin.of('programmatic'),
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
      // Clic hors du popup → annule (focusout couvre clic + Tab). Le retirer du document lui prend
      // aussi le focus, en pleine mise à jour de la vue : il n'y a alors plus rien à fermer, et un
      // `dispatch` lèverait.
      dom.addEventListener('focusout', (e) => {
        if (view.state.field(field) === value && !dom.contains(e.relatedTarget as Node | null)) close();
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
        return value ? popupTooltip(value, labels, f) : null;
      }),
  });
  return field;
}
