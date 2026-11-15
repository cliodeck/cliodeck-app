// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView, keymap } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { defaultKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import {
  acceptCompletion,
  autocompletion,
  completionStatus,
  selectedCompletion,
  startCompletion,
} from '@codemirror/autocomplete';
import { scholarlyMarkdown } from '../lezer-extensions';
import { scholarly, type CitationCandidate } from '../cm/scholarly';
import { createDocState, readDocText } from '../cm/fidelity';

/**
 * L'autocomplétion `@` dans une vraie vue, avec l'extension de l'app (S14-2-1, S14-2-5).
 *
 * Choisir une clé à l'intérieur d'une citation existante ne remplaçait que la partie de la clé
 * avant le curseur, et ajoutait un `]` dès que le caractère suivant n'en était pas un : le
 * locator sortait du crochet (« [@jones1990], p. 4] »), ce qui ne se voyait qu'à l'export.
 * Bibliographie vide : l'entrée informative de la liste prenait la touche Entrée.
 */

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

const BIBLIOGRAPHY: CitationCandidate[] = [
  { id: 'smith2020', author: 'Smith', year: '2020', title: 'Un livre' },
  { id: 'jones1990', author: 'Jones', year: '1990', title: 'Un autre livre' },
];

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

/** `|` marque le curseur. */
function makeView(docWithCursor: string, citations: CitationCandidate[] = BIBLIOGRAPHY): EditorView {
  const at = docWithCursor.indexOf('|');
  const view = new EditorView({
    state: createDocState(docWithCursor.replace('|', ''), [
      markdown({ base: markdownLanguage, extensions: scholarlyMarkdown }),
      scholarly({ getCitations: () => citations }),
      // Entrée accepte dès l'ouverture de la liste ; dans l'app, 75 ms après. Rien d'autre ne change.
      autocompletion({ interactionDelay: 0 }),
      keymap.of(defaultKeymap),
    ]),
    parent: document.body,
  });
  views.push(view);
  view.dispatch({ selection: EditorSelection.cursor(at) });
  view.focus();
  return view;
}

async function listOpen(view: EditorView): Promise<void> {
  await vi.waitFor(() => expect(completionStatus(view.state)).toBe('active'), { timeout: 3000 });
}

/** Ouvre la liste au curseur, choisit `id` et rend le document. */
async function choose(docWithCursor: string, id: string): Promise<string> {
  const view = makeView(docWithCursor);
  startCompletion(view);
  await listOpen(view);
  expect(selectedCompletion(view.state)?.label).toBe(`@${id}`);
  expect(acceptCompletion(view)).toBe(true);
  return readDocText(view.state);
}

function type(view: EditorView, text: string): void {
  for (const ch of text) {
    view.dispatch(view.state.replaceSelection(ch), { userEvent: 'input.type', scrollIntoView: true });
  }
}

function pressEnter(view: EditorView): void {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true })
  );
}

describe('autocomplétion @ : la clé choisie remplace la clé entière, et le crochet ne se double pas', () => {
  it('le locator reste dans la citation', async () => {
    expect(await choose('Voir [@jo|, p. 4].', 'jones1990')).toBe('Voir [@jones1990, p. 4].');
  });

  it('le reste de l’ancienne clé part', async () => {
    expect(await choose('Voir [@jo|smith2020].', 'jones1990')).toBe('Voir [@jones1990].');
  });

  it('en tête d’un cluster, le cluster reste entier', async () => {
    expect(await choose('[@jo|; @smith2020, p. 4]', 'jones1990')).toBe('[@jones1990; @smith2020, p. 4]');
  });

  it('après un préfixe, le crochet se ferme', async () => {
    expect(await choose('[see @jo|', 'jones1990')).toBe('[see @jones1990]');
  });

  it('une citation à auteur supprimé se complète aussi', async () => {
    expect(await choose('Voir [-@jo|', 'jones1990')).toBe('Voir [-@jones1990]');
  });

  it('le geste réel : sélectionner la clé, taper le début d’une autre, accepter', async () => {
    const doc = 'Voir [@smith2020, p. 4].';
    const view = makeView(`${doc}|`);
    const from = doc.indexOf('smith2020');
    view.dispatch({ selection: EditorSelection.range(from, from + 'smith2020'.length) });
    type(view, 'jo');
    await listOpen(view);
    expect(acceptCompletion(view)).toBe(true);
    expect(readDocText(view.state)).toBe('Voir [@jones1990, p. 4].');
  });

  it.each([
    ['Voir [@jo| et la suite.', 'Voir [@jones1990] et la suite.'],
    ['Voir [@jo|].', 'Voir [@jones1990].'],
    ['Voir [@jo|', 'Voir [@jones1990]'],
    ['[@smith2020; @jo|]', '[@smith2020; @jones1990]'],
    ['[@smith2020; @jo|, p. 3]', '[@smith2020; @jones1990, p. 3]'],
    ['Selon @jo| la suite.', 'Selon @jones1990 la suite.'],
    ['Voir [@smith2020] et @jo|', 'Voir [@smith2020] et @jones1990'],
  ])('cas sain : %s', async (doc, expected) => {
    expect(await choose(doc, 'jones1990')).toBe(expected);
  });

  it('cas sain : reprendre la même clé ne change rien', async () => {
    expect(await choose('Voir [@smith2020|].', 'smith2020')).toBe('Voir [@smith2020].');
  });

  // Une clé tapée collée devant du texte : rien ne dit que la suite est la fin d'une clé.
  // Remplacer jusqu'au bout des caractères de clé effaçait le mot de l'historienne.
  it.each([
    ['Voir @jo|Smith a écrit.', 'Voir @jones1990Smith a écrit.'],
    ['[@jo|p. 4]', '[@jones1990p. 4]'],
    ['Voir (@jo|p. 4).', 'Voir (@jones1990p. 4).'],
    ['[@jo|smith2020 p. 4]', '[@jones1990smith2020 p. 4]'],
  ])('le texte qui suit reste : %s', async (doc, expected) => {
    expect(await choose(doc, 'jones1990')).toBe(expected);
  });
});

describe('autocomplétion @ : bibliographie vide', () => {
  it('Entrée fait un saut de ligne au premier appui', async () => {
    const view = makeView('Il faut suivre |', []);
    type(view, '@AFP');
    // La source a répondu : la liste est ouverte ou n'existe pas.
    await vi.waitFor(() => expect(completionStatus(view.state)).not.toBe('pending'), { timeout: 3000 });

    pressEnter(view);

    expect(readDocText(view.state)).toBe('Il faut suivre @AFP\n');
  });
});
