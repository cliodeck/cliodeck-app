// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { scholarlyMarkdown } from '../lezer-extensions';
import { nodes } from '../lezer-extensions/__tests__/helpers';
import { openFootnotePopup, scholarly } from '../cm/scholarly';
import { createDocState, readDocText } from '../cm/fidelity';
import { extractManualFootnotes } from '../../main/services/word-footnotes';

/**
 * La popup d'édition d'une note et ses paragraphes (S14-1-7).
 *
 * Comme chez Pandoc, une définition ne garde un paragraphe suivant que s'il est indenté de quatre
 * colonnes. La popup écrivait le texte tapé tel quel : un second paragraphe sortait de la note et
 * devenait du corps de texte, en fin de chapitre. À l'inverse, une note à deux paragraphes
 * s'affichait avec son retrait brut, et l'enlever faisait sortir le paragraphe.
 */

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

const TWO_PARAGRAPHS = 'Voir X.\n\nSecond paragraphe de la note.';

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

function makeView(doc: string): EditorView {
  const view = new EditorView({
    state: createDocState(doc, [
      markdown({ base: markdownLanguage, extensions: scholarlyMarkdown }),
      scholarly(),
    ]),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function openPopup(view: EditorView, label: string): HTMLTextAreaElement {
  view.dispatch({ effects: openFootnotePopup.of({ label, at: 0 }) });
  const textarea = view.dom.querySelector<HTMLTextAreaElement>('.cm-scholarly-popup textarea');
  if (!textarea) throw new Error('Popup de note absente');
  return textarea;
}

function save(view: EditorView): void {
  const button = view.dom.querySelector<HTMLButtonElement>('.cm-scholarly-popup-save');
  if (!button) throw new Error('Bouton d’enregistrement absent');
  button.click();
}

function saveInPopup(view: EditorView, label: string, text: string): string {
  openPopup(view, label).value = text;
  save(view);
  return readDocText(view.state);
}

/** Le texte de l'unique définition de note du document. */
function definitionText(doc: string): string {
  const defs = nodes(doc, 'FootnoteDefinition');
  expect(defs).toHaveLength(1);
  return defs[0].text;
}

describe('popup de note : un second paragraphe reste dans la note', () => {
  it('à la création, en fin de document', () => {
    const view = makeView('Un mot[^3].\n');

    const doc = saveInPopup(view, '3', TWO_PARAGRAPHS);

    expect(doc).toBe('Un mot[^3].\n\n[^3]: Voir X.\n\n    Second paragraphe de la note.');
    expect(definitionText(doc)).toContain('Second paragraphe de la note.');
  });

  it('en remplaçant une définition existante', () => {
    const view = makeView('Un mot[^3].\n\n[^3]: Déjà là.\n\nSuite du texte.\n');

    const doc = saveInPopup(view, '3', TWO_PARAGRAPHS);

    expect(doc).toBe('Un mot[^3].\n\n[^3]: Voir X.\n\n    Second paragraphe de la note.\n\nSuite du texte.\n');
    expect(definitionText(doc)).toContain('Second paragraphe de la note.');
    expect(definitionText(doc)).not.toContain('Suite du texte.');
  });

  it('une note existante à deux paragraphes s’affiche sans son retrait, et revient octet pour octet', () => {
    const source = 'Un mot[^3].\n\n[^3]: Voir X.\n\n    Second paragraphe de la note.\n\nSuite du texte.\n';
    const view = makeView(source);

    const textarea = openPopup(view, '3');
    expect(textarea.value).toBe(TWO_PARAGRAPHS);
    save(view);

    expect(readDocText(view.state)).toBe(source);
  });

  it('dans un fichier CRLF, le second paragraphe s’écrit en CRLF et se relit sans retrait', () => {
    const view = makeView('Un mot[^3].\r\n\r\n[^3]: Déjà là.\r\n');

    const doc = saveInPopup(view, '3', TWO_PARAGRAPHS);

    expect(doc).toBe('Un mot[^3].\r\n\r\n[^3]: Voir X.\r\n\r\n    Second paragraphe de la note.\r\n');
    expect(doc.replace(/\r\n/g, '')).not.toContain('\n');
    expect(openPopup(view, '3').value).toBe(TWO_PARAGRAPHS);
  });

  it('l’export Word interne relit les deux paragraphes écrits par la popup', () => {
    const view = makeView('Un mot[^3].\n');

    const doc = saveInPopup(view, '3', TWO_PARAGRAPHS);

    expect(extractManualFootnotes(doc).footnotes.map((f) => f.text)).toEqual([TWO_PARAGRAPHS]);
  });
});
