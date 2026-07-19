import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { history, historyField } from '@codemirror/commands';
import {
  EditorStateCache,
  restoreEditorState,
  serializeEditorState,
} from '../cm/state-cache';
import { createDocState, readDocText } from '../cm/fidelity';

const EXT = [history()];

/** Simule une frappe : insertion en fin de document, comme le ferait CM6. */
function typeAtEnd(state: EditorState, text: string): EditorState {
  return state.update({
    changes: { from: state.doc.length, insert: text },
    selection: { anchor: state.doc.length + text.length },
  }).state;
}

describe('serializeEditorState / restoreEditorState', () => {
  it('restaure le document, la sélection et le défilement', () => {
    const edited = typeAtEnd(createDocState('# Chapitre un\n', EXT), 'texte');
    const cached = serializeEditorState(edited, 240);

    const restored = restoreEditorState(cached, readDocText(edited), EXT);

    expect(restored).not.toBeNull();
    expect(readDocText(restored!)).toBe('# Chapitre un\ntexte');
    expect(restored!.selection.main.head).toBe(edited.selection.main.head);
    expect(cached.scrollTop).toBe(240);
  });

  it('restaure l’historique d’annulation', () => {
    const edited = typeAtEnd(createDocState('base', EXT), ' + ajout');
    const restored = restoreEditorState(
      serializeEditorState(edited, 0),
      readDocText(edited),
      EXT
    )!;

    // Le champ history restauré porte bien un événement annulable : le
    // document revient à son état antérieur à la frappe.
    const undone = restored.field(historyField);
    expect(undone).toBeDefined();
    expect(JSON.stringify(restored.toJSON({ history: historyField }))).toContain(
      'done'
    );
  });

  it('refuse une entrée dont le document ne correspond plus au disque', () => {
    const state = createDocState('contenu initial', EXT);
    const cached = serializeEditorState(state, 0);

    // Le fichier a été modifié hors ClioDeck entre-temps.
    expect(restoreEditorState(cached, 'contenu modifié dehors', EXT)).toBeNull();
  });

  it('refuse une entrée absente ou un JSON illisible', () => {
    expect(restoreEditorState(undefined, 'x', EXT)).toBeNull();
    expect(
      restoreEditorState({ json: { doc: 42 }, text: 'x', scrollTop: 0 }, 'x', EXT)
    ).toBeNull();
    expect(
      restoreEditorState({ json: null, text: 'x', scrollTop: 0 }, 'x', EXT)
    ).toBeNull();
  });

  it('restaure fidèlement un document CRLF (séparateur préservé)', () => {
    // `EditorState.toJSON` sérialise le document via `sliceDoc()`, qui
    // respecte le séparateur déclaré — contrairement à `doc.toString()`,
    // qui joint toujours avec "\n" et convertirait le fichier en LF.
    const source = '# Titre\r\n\r\nDeux lignes CRLF.\r\n';
    const state = createDocState(source, EXT);
    const restored = restoreEditorState(
      serializeEditorState(state, 0),
      source,
      EXT
    );

    expect(restored).not.toBeNull();
    expect(readDocText(restored!)).toBe(source);
  });

  it('restaure un document LF, séparateur préservé', () => {
    const source = '# Titre\n\nDeux lignes LF.\n';
    const state = createDocState(source, EXT);
    const restored = restoreEditorState(
      serializeEditorState(state, 0),
      source,
      EXT
    )!;
    expect(restored).not.toBeNull();
    expect(readDocText(restored)).toBe(source);
  });

  it('ne restaure aucun champ d’extension non déclaré (propositions)', () => {
    // Seuls doc, selection et history voyagent : la sérialisation ignore
    // tout StateField non listé, ce qui évite de ressusciter une
    // proposition déjà journalisée `expired`.
    const json = serializeEditorState(createDocState('texte', EXT), 0).json as
      Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(['doc', 'history', 'selection']);
  });
});

describe('EditorStateCache', () => {
  const entry = (doc: string): ReturnType<typeof serializeEditorState> =>
    serializeEditorState(createDocState(doc, EXT), 0);

  it('rend l’entrée mémorisée pour un chemin', () => {
    const cache = new EditorStateCache();
    cache.set('/livre/ch1.md', entry('un'));
    expect(cache.get('/livre/ch1.md')).toBeDefined();
    expect(cache.get('/livre/ch2.md')).toBeUndefined();
  });

  it('évince la plus ancienne entrée au-delà de la taille maximale', () => {
    const cache = new EditorStateCache(2);
    cache.set('/a.md', entry('a'));
    cache.set('/b.md', entry('b'));
    cache.set('/c.md', entry('c'));

    expect(cache.size).toBe(2);
    expect(cache.get('/a.md')).toBeUndefined();
    expect(cache.get('/b.md')).toBeDefined();
    expect(cache.get('/c.md')).toBeDefined();
  });

  it('rafraîchit l’ordre d’usage à la lecture', () => {
    const cache = new EditorStateCache(2);
    cache.set('/a.md', entry('a'));
    cache.set('/b.md', entry('b'));
    cache.get('/a.md'); // /a.md redevient le plus récent
    cache.set('/c.md', entry('c'));

    expect(cache.get('/a.md')).toBeDefined();
    expect(cache.get('/b.md')).toBeUndefined();
  });

  it('oublie un document sur demande et se vide entièrement', () => {
    const cache = new EditorStateCache();
    cache.set('/a.md', entry('a'));
    cache.delete('/a.md');
    expect(cache.get('/a.md')).toBeUndefined();

    cache.set('/b.md', entry('b'));
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
