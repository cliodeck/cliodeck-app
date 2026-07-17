import { describe, expect, it } from 'vitest';
import { EditorState, Text } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import {
  computeLiveDecorations,
  type LiveDeco,
  type ResolvedCitation,
} from '../cm/live-render';
import { scholarlyMarkdown } from '../lezer-extensions';
import {
  citationAt,
  detectFrontmatter,
  findDefinition,
  findFirstReference,
  footnoteAt,
} from '../cm/scholarly';

/**
 * Tests node des parties pures de la Phase 3b : descripteurs de rendu des
 * notes/citations, recherches dans l'arbre, détection du frontmatter.
 */

function makeState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage, extensions: scholarlyMarkdown }),
    ],
  });
}

function compute(
  doc: string,
  cursor = 0,
  resolveCitation?: (key: string) => ResolvedCitation | null
): LiveDeco[] {
  const state = makeState(doc);
  const tree = ensureSyntaxTree(state, doc.length, 10_000);
  if (!tree) throw new Error('parse timeout');
  return computeLiveDecorations(
    state,
    tree,
    [{ from: 0, to: doc.length }],
    [{ from: cursor, to: cursor }],
    { resolveCitation }
  );
}

const marks = (d: LiveDeco[], cls: string) =>
  d.filter(
    (x): x is Extract<LiveDeco, { kind: 'mark' }> =>
      x.kind === 'mark' && x.class.includes(cls)
  );
const hides = (d: LiveDeco[]) => d.filter((x) => x.kind === 'hide');

describe('rendu live — notes de bas de page', () => {
  const doc = 'Un appel[^1] ici.\n\n[^1]: La note.\n';

  it('exposant + marqueurs masqués hors nœud actif', () => {
    const d = compute(doc, doc.length);
    expect(marks(d, 'cm-live-footnote-ref')).toHaveLength(1);
    // `[^` (8-10) et `]` (11-12) masqués
    expect(hides(d)).toContainEqual({ kind: 'hide', from: 8, to: 10 });
    expect(hides(d)).toContainEqual({ kind: 'hide', from: 11, to: 12 });
    // En-tête de définition stylé, jamais masqué
    expect(marks(d, 'cm-live-footnote-def')).toHaveLength(1);
  });

  it('révèle les marqueurs quand le curseur est dans l’appel', () => {
    const d = compute(doc, 10);
    const hiddenInRef = hides(d).filter((h) => h.from >= 8 && h.to <= 12);
    expect(hiddenInRef).toHaveLength(0);
  });
});

describe('rendu live — citations pandoc', () => {
  const doc = 'Voir [@lester1932; @clavert2013, p. 9] et @nu2020.\n';

  it('pastille sur le cluster, `[` `]` `@` masqués, `;` conservé', () => {
    const d = compute(doc, doc.length);
    expect(marks(d, 'cm-live-citation')).toHaveLength(2); // cluster + nue
    const hidden = hides(d).map((h) => doc.slice(h.from, h.to));
    expect(hidden).toContain('[');
    expect(hidden).toContain(']');
    expect(hidden).toContain('@');
    expect(hidden).not.toContain(';');
  });

  it('souligne les clés non résolues, pas les résolues', () => {
    const resolve = (key: string): ResolvedCitation | null =>
      key === 'lester1932'
        ? { author: 'Lester', year: '1932', title: 'Danzig' }
        : null;
    const d = compute(doc, doc.length, resolve);
    const unresolved = marks(d, 'cm-live-citation-unresolved');
    expect(unresolved).toHaveLength(2); // clavert2013 + nu2020
    const texts = unresolved.map((m) => doc.slice(m.from, m.to));
    expect(texts).toEqual(['clavert2013', 'nu2020']);
  });

  it('sans resolveCitation, aucune clé n’est soulignée', () => {
    const d = compute(doc, doc.length);
    expect(marks(d, 'cm-live-citation-unresolved')).toHaveLength(0);
  });
});

describe('footnote-lookup', () => {
  const doc =
    'Premier[^a] et second[^a] appels.\n\n[^a]: Contenu de la note.\n\nSuite.\n';
  const state = makeState(doc);

  it('footnoteAt trouve l’appel sous le curseur', () => {
    const hit = footnoteAt(state, doc.indexOf('[^a]') + 2);
    expect(hit).toMatchObject({ kind: 'reference', label: 'a' });
  });

  it('footnoteAt réagit sur l’en-tête de définition, pas sur son corps', () => {
    const defPos = doc.indexOf('[^a]:');
    expect(footnoteAt(state, defPos + 2)).toMatchObject({ kind: 'definition' });
    expect(footnoteAt(state, doc.indexOf('Contenu') + 3)).toBeNull();
  });

  it('findDefinition retourne la plage exacte du corps', () => {
    const def = findDefinition(state, 'a');
    expect(def).not.toBeNull();
    expect(doc.slice(def!.contentFrom, def!.contentTo)).toBe(
      'Contenu de la note.'
    );
  });

  it('findFirstReference retourne le premier appel', () => {
    const ref = findFirstReference(state, 'a');
    expect(ref?.from).toBe(doc.indexOf('[^a]'));
  });

  it('citationAt liste les clés du cluster', () => {
    const cdoc = 'Un [@x2020; voir @y2021, p. 3] ok.\n';
    const cstate = makeState(cdoc);
    const hit = citationAt(cstate, cdoc.indexOf('@x') + 1);
    expect(hit?.keys).toEqual(['x2020', 'y2021']);
  });
});

describe('detectFrontmatter', () => {
  it('détecte un frontmatter en tête de document', () => {
    const doc = Text.of('---\ntitle: X\nlang: fr\n---\n\n# Corps'.split('\n'));
    const fm = detectFrontmatter(doc);
    expect(fm).not.toBeNull();
    expect(fm!.from).toBe(0);
    expect(doc.sliceString(fm!.to - 3, fm!.to)).toBe('---');
    expect(fm!.preview).toContain('title: X');
  });

  it('ignore un document sans frontmatter ou avec --- ailleurs', () => {
    expect(detectFrontmatter(Text.of(['# Titre', '', '---', 'x']))).toBeNull();
    expect(detectFrontmatter(Text.of(['---'])) /* jamais fermé */).toBeNull();
  });

  it('tolère le \\r résiduel des fichiers mixtes', () => {
    expect(
      detectFrontmatter(Text.of(['---\r', 'a: b\r', '---\r', 'corps']))
    ).not.toBeNull();
  });
});
