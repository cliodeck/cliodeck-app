// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';

import { createDocState, readDocText } from '../cm/fidelity';
import { proposals } from '../proposals';

/**
 * Accepter une proposition dans un fichier CRLF y mettait des LF nus : CM6 ne découpe une chaîne
 * que sur le séparateur déclaré, le `\n` restait à l'intérieur d'une « ligne ». Le fichier devenait
 * mixte, et au rechargement ses `\r` s'affichaient comme des caractères spéciaux.
 */

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

const LABELS = {
  heading: 'proposition IA',
  accept: 'accepter',
  reject: 'rejeter',
  modify: 'modifier',
  acceptShort: 'accepter',
  rejectShort: 'rejeter',
  modifyShort: 'modifier',
  rejectionPrompt: 'pourquoi ?',
  apply: 'appliquer',
  cancel: 'annuler',
};

const views: EditorView[] = [];

function viewOf(doc: string) {
  const instance = proposals({ onEvent: () => undefined, labels: LABELS });
  const view = new EditorView({
    state: createDocState(doc, [instance.extension]),
    parent: document.body,
  });
  views.push(view);
  return { view, instance };
}

const bareLf = (text: string) => (text.match(/(^|[^\r])\n/g) ?? []).length;

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

describe('les fins de ligne d’une proposition', () => {
  const CRLF = 'Un\r\n\r\nDeux\r\n';

  it('acceptée dans un fichier CRLF : aucun LF nu, le fichier reste CRLF', () => {
    const { view, instance } = viewOf(CRLF);
    const { id } = instance.inject(view, { range: { from: 2, to: 2 }, proposed: '\n\nA\n\nB' });

    expect(instance.accept(view, id)).toBe(true);

    expect(readDocText(view.state)).toBe('Un\r\n\r\nA\r\n\r\nB\r\n\r\nDeux\r\n');
    expect(bareLf(readDocText(view.state))).toBe(0);
    expect(view.state.doc.line(5).text).toBe('B');
  });

  it('modifiée dans un fichier CRLF : aucun LF nu non plus', () => {
    const { view, instance } = viewOf(CRLF);
    const { id } = instance.inject(view, { range: { from: 2, to: 2 }, proposed: 'x' });

    expect(instance.applyModified(view, id, '\n\nA\nB')).toBe(true);

    expect(readDocText(view.state)).toBe('Un\r\n\r\nA\r\nB\r\n\r\nDeux\r\n');
  });

  it('le curseur suit le texte accepté, en offsets du document', () => {
    const { view, instance } = viewOf(CRLF);
    const { id } = instance.inject(view, { range: { from: 2, to: 2 }, proposed: '\nA\nB' });

    instance.accept(view, id);

    expect(view.state.selection.main.head).toBe(2 + '\nA\nB'.length);
    expect(view.state.sliceDoc(0, view.state.selection.main.head)).toBe('Un\r\nA\r\nB');
  });

  it('un texte en CRLF accepté tout au bout du document ne fait pas sortir le curseur', () => {
    const { view, instance } = viewOf('Un\r\n');
    const end = view.state.doc.length;
    const { id } = instance.inject(view, { range: { from: end, to: end }, proposed: 'A\r\nB' });

    expect(instance.accept(view, id)).toBe(true);

    expect(readDocText(view.state)).toBe('Un\r\nA\r\nB');
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });

  it('dans un fichier LF, un texte en CRLF n’y laisse aucun \\r', () => {
    const { view, instance } = viewOf('Un\n');
    const { id } = instance.inject(view, { range: { from: 3, to: 3 }, proposed: 'A\r\nB' });

    instance.accept(view, id);

    expect(readDocText(view.state)).toBe('Un\nA\nB');
  });

  it('dans un fichier LF ordinaire, rien ne change', () => {
    const { view, instance } = viewOf('Un\n\nDeux\n');
    const { id } = instance.inject(view, { range: { from: 2, to: 2 }, proposed: '\n\nA\n\nB' });

    instance.accept(view, id);

    expect(readDocText(view.state)).toBe('Un\n\nA\n\nB\n\nDeux\n');
    expect(view.state.selection.main.head).toBe(2 + '\n\nA\n\nB'.length);
  });
});
