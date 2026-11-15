// @vitest-environment jsdom
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { copyLineDown } from '@codemirror/commands';
import { SearchQuery, replaceAll, search, setSearchQuery } from '@codemirror/search';
import { afterEach, describe, expect, it } from 'vitest';

import { createDocState, readDocText } from '../cm/fidelity';

/**
 * Les commandes de CM6 elles-mêmes, sur une vraie vue : elles insèrent des chaînes, pas des `Text`.
 * Dans un fichier CRLF qui déclarait `\r\n` comme séparateur, leurs `\n` restaient à l'intérieur
 * d'une « ligne », et le fichier devenait mixte (S14-1-24). Ni le filtre du collage ni la façade ne
 * passent par là.
 */

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

const views: EditorView[] = [];

function viewOf(doc: string): EditorView {
  const view = new EditorView({ state: createDocState(doc, [search()]), parent: document.body });
  views.push(view);
  return view;
}

const bareLf = (text: string) => (text.match(/(^|[^\r])\n/g) ?? []).length;

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

describe('les commandes de CM6 dans un fichier CRLF', () => {
  const CRLF = 'Un\r\nDeux\r\nTrois\r\n';

  it('copier deux lignes vers le bas (Maj+Alt+Bas) : le fichier reste CRLF uniforme', () => {
    const view = viewOf(CRLF);
    view.dispatch({ selection: EditorSelection.range(0, view.state.doc.line(2).to) });

    expect(copyLineDown(view)).toBe(true);

    expect(readDocText(view.state)).toBe('Un\r\nDeux\r\nUn\r\nDeux\r\nTrois\r\n');
    expect(bareLf(readDocText(view.state))).toBe(0);
    expect(view.state.doc.lines).toBe(6);
  });

  it('remplacer par `\\n` dans la recherche : le fichier reste CRLF uniforme', () => {
    const view = viewOf(CRLF);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'Deux', replace: 'Deux\\nbis' })) });

    expect(replaceAll(view)).toBe(true);

    expect(readDocText(view.state)).toBe('Un\r\nDeux\r\nbis\r\nTrois\r\n');
    expect(view.state.doc.line(3).text).toBe('bis');
  });

  it('témoin : dans un fichier LF, les mêmes commandes écrivent du LF', () => {
    const view = viewOf('Un\nDeux\n');
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'Deux', replace: 'Deux\\nbis' })) });

    replaceAll(view);

    expect(readDocText(view.state)).toBe('Un\nDeux\nbis\n');
  });
});
