import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import {
  computeLiveDecorations,
  findImages,
  type LiveDeco,
} from '../cm/live-render';

/**
 * Tests de la partie pure du rendu live (Phase 2) : étant donné un document
 * et une sélection, quels marqueurs sont masqués, quelles lignes stylées,
 * quels widgets posés. Aucun DOM.
 */

function compute(doc: string, cursor = 0, to = cursor): LiveDeco[] {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  });
  const tree = ensureSyntaxTree(state, doc.length, 10_000);
  if (!tree) throw new Error('parse timeout');
  return computeLiveDecorations(
    state,
    tree,
    [{ from: 0, to: doc.length }],
    [{ from: cursor, to }]
  );
}

const hides = (d: LiveDeco[]) => d.filter((x) => x.kind === 'hide');
const kind = <K extends LiveDeco['kind']>(d: LiveDeco[], k: K) =>
  d.filter((x): x is Extract<LiveDeco, { kind: K }> => x.kind === k);

describe('rendu live — titres', () => {
  const doc = '# Titre\n\ntexte';

  it('masque `# ` quand le curseur est ailleurs', () => {
    const d = compute(doc, doc.length);
    expect(hides(d)).toContainEqual({ kind: 'hide', from: 0, to: 2 });
    expect(kind(d, 'line').some((l) => l.class.includes('cm-live-h1'))).toBe(true);
  });

  it('révèle `# ` quand le curseur est dans le titre (style conservé)', () => {
    const d = compute(doc, 3);
    expect(hides(d)).toHaveLength(0);
    expect(kind(d, 'line').some((l) => l.class.includes('cm-live-h1'))).toBe(true);
  });
});

describe('rendu live — inline', () => {
  it('masque les marqueurs de gras/italique/barré hors sélection', () => {
    const doc = 'Un **gras** et _ital_ et ~~barre~~.';
    const d = compute(doc, doc.length);
    // ** ** _ _ ~~ ~~ : six paires de marqueurs masquées
    expect(hides(d)).toHaveLength(6);
  });

  it('révèle les marqueurs quand la sélection touche le nœud', () => {
    const doc = 'Un **gras** ici';
    const d = compute(doc, 6); // dans "gras"
    expect(hides(d)).toHaveLength(0);
  });

  it('code inline : backticks masqués + fond stylé', () => {
    const doc = 'du `code` la';
    const d = compute(doc, 0);
    expect(hides(d)).toHaveLength(2);
    expect(
      kind(d, 'mark').some((m) => m.class === 'cm-live-inline-code')
    ).toBe(true);
  });
});

describe('rendu live — liens', () => {
  it('affiche le texte seul, URL masquée, avec attribut url', () => {
    const doc = 'voir [lien](https://ex.org) ici';
    const d = compute(doc, 0);
    const mark = kind(d, 'mark').find((m) => m.class === 'cm-live-link');
    expect(mark?.url).toBe('https://ex.org');
    // `[` masqué + `](https://ex.org)` masqué
    expect(hides(d)).toHaveLength(2);
  });

  it('révèle la syntaxe quand le curseur est dans le lien', () => {
    const doc = 'voir [lien](https://ex.org) ici';
    const d = compute(doc, 7);
    expect(hides(d)).toHaveLength(0);
    expect(kind(d, 'mark').some((m) => m.class === 'cm-live-link')).toBe(true);
  });

  it("ne touche PAS aux footnotes [^1] ni aux citations [@clef] (périmètre 3a)", () => {
    const d = compute('note[^1] et [@lester1932, p. 12] la', 40);
    expect(d).toHaveLength(0);
  });
});

describe('rendu live — blocs', () => {
  it('blockquote : `> ` masqué, lignes stylées', () => {
    const doc = '> une\n> deux\n\nfin';
    const d = compute(doc, doc.length);
    expect(hides(d)).toHaveLength(2);
    expect(kind(d, 'line').filter((l) => l.class === 'cm-live-quote')).toHaveLength(2);
  });

  it('blockquote : ligne active révélée, l’autre masquée', () => {
    const doc = '> une\n> deux';
    const d = compute(doc, 3); // dans "une"
    expect(hides(d)).toHaveLength(1); // seul le `>` de "deux" reste masqué
  });

  it('règle horizontale rendue hors ligne active, pas en début de doc (frontmatter)', () => {
    const hr = compute('texte\n\n---\n\nsuite', 0);
    expect(kind(hr, 'hr')).toHaveLength(1);

    const fm = compute('---\ntitle: "X"\n---\n\ntexte', 25);
    expect(kind(fm, 'hr')).toHaveLength(0);
  });

  it('case à cocher : widget avec état, sauf ligne active', () => {
    const doc = '- [ ] a\n- [x] b';
    const away = compute(doc + '\n\nfin', 17);
    const boxes = kind(away, 'checkbox');
    expect(boxes.map((b) => b.checked)).toEqual([false, true]);

    const active = compute(doc, 3); // ligne 1 active
    expect(kind(active, 'checkbox')).toHaveLength(1); // seule la ligne 2
  });
});

describe('rendu live — blocs de code', () => {
  const doc = 'avant\n\n```python\nx = 1\n```\n\napres';

  it('fences masquées et lignes stylées hors sélection', () => {
    const d = compute(doc, 0);
    expect(hides(d)).toHaveLength(2); // ligne ``` python et ligne ```
    expect(
      kind(d, 'line').filter((l) => l.class === 'cm-live-code').length
    ).toBe(3);
  });

  it('fences révélées quand le curseur est dans le bloc', () => {
    const d = compute(doc, 18); // dans x = 1
    expect(hides(d)).toHaveLength(0);
    expect(kind(d, 'line').filter((l) => l.class === 'cm-live-code').length).toBe(3);
  });
});

describe('rendu live — échappements et images', () => {
  it('masque le backslash des échappements Milkdown', () => {
    const doc = 'un \\[@clef\\] echappe';
    const d = compute(doc, doc.length);
    expect(hides(d)).toEqual([
      { kind: 'hide', from: 3, to: 4 },
      { kind: 'hide', from: 10, to: 11 },
    ]);
  });

  it('findImages : extrait src/alt et la position du widget', () => {
    const doc = 'texte\n\n![une carte](images/carte.png)\n\nfin';
    const state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage })],
    });
    const tree = ensureSyntaxTree(state, doc.length, 10_000);
    if (!tree) throw new Error('parse timeout');
    const specs = findImages(state, tree, 0, doc.length);
    expect(specs).toHaveLength(1);
    expect(specs[0].src).toBe('images/carte.png');
    expect(specs[0].alt).toBe('une carte');
    expect(specs[0].widgetPos).toBe(doc.indexOf(')') + 1); // fin de la ligne
  });

  it("l'image en source est réduite à sa légende hors sélection", () => {
    const doc = '![alt](a.png)';
    const d = compute(doc + '\n\nfin', doc.length + 3);
    expect(kind(d, 'mark').some((m) => m.class === 'cm-live-image-alt')).toBe(true);
    expect(hides(d)).toHaveLength(2); // `![` et `](a.png)`
  });
});

describe('rendu live — frontières de slides (mode presentation)', () => {
  const computeSlides = (doc: string, cursor = 0): LiveDeco[] => {
    const state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage })],
    });
    const tree = ensureSyntaxTree(state, doc.length, 10_000);
    if (!tree) throw new Error('parse timeout');
    return computeLiveDecorations(
      state,
      tree,
      [{ from: 0, to: doc.length }],
      [{ from: cursor, to: cursor }],
      { slideSeparators: true }
    );
  };

  const DECK = '# Un\n\n---\n\n# Deux\n';

  it('un séparateur devient une frontière numérotée, pas une hr', () => {
    const d = computeSlides(DECK, DECK.length);
    const boundaries = kind(d, 'slide-boundary');
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0].number).toBe(2); // la slide qui COMMENCE après
    expect(kind(d, 'hr')).toHaveLength(0);
  });

  it('révélée quand le curseur est sur la ligne du séparateur', () => {
    const d = computeSlides(DECK, DECK.indexOf('---') + 1);
    expect(kind(d, 'slide-boundary')).toHaveLength(0);
    expect(kind(d, 'hr')).toHaveLength(0); // pas de repli en hr non plus
  });

  it('`***` reste une règle horizontale ordinaire', () => {
    const doc = 'texte\n\n***\n\nsuite\n';
    const d = computeSlides(doc, doc.length);
    expect(kind(d, 'hr')).toHaveLength(1);
    expect(kind(d, 'slide-boundary')).toHaveLength(0);
  });

  it('un `---` dans un bloc de code : ni frontière ni hr', () => {
    const doc = '# S\n\n```js\n---\n```\n\nfin\n';
    const d = computeSlides(doc, doc.length);
    expect(kind(d, 'slide-boundary')).toHaveLength(0);
    expect(kind(d, 'hr')).toHaveLength(0);
  });

  it('la numérotation ignore le frontmatter et ses clôtures', () => {
    const doc = '---\ntitle: x\n---\n\n# Un\n\n---\n\n# Deux\n';
    const d = computeSlides(doc, doc.length);
    const boundaries = kind(d, 'slide-boundary');
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0].number).toBe(2);
  });

  it('option absente : comportement hr historique inchangé', () => {
    const d = compute(DECK, DECK.length);
    expect(kind(d, 'hr')).toHaveLength(1);
    expect(kind(d, 'slide-boundary')).toHaveLength(0);
  });
});
