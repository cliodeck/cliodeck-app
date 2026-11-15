import { describe, expect, it } from 'vitest';
import { nodes, texts } from './helpers';

describe('PandocCitation — bracketed', () => {
  it('parses a simple citation with exact positions', () => {
    const doc = 'Fin de proposition [@lester1932].';
    const [cit] = nodes(doc, 'PandocCitation');
    expect(cit).toMatchObject({ from: 19, to: 32, text: '[@lester1932]' });
    expect(texts(doc, 'CitationKey')).toEqual(['lester1932']);
    expect(texts(doc, 'CitationMark')).toEqual(['[', '@', ']']);
  });

  it('parses a locator as CitationSuffix', () => {
    const doc = 'Voir [@lester1932, p. 12].';
    expect(texts(doc, 'CitationKey')).toEqual(['lester1932']);
    expect(texts(doc, 'CitationSuffix')).toEqual([', p. 12']);
  });

  it('parses clusters, with and without locators', () => {
    const doc = 'Un cluster [@lester1932; @clavert2013].';
    expect(nodes(doc, 'PandocCitation')).toHaveLength(1);
    expect(texts(doc, 'CitationKey')).toEqual(['lester1932', 'clavert2013']);

    const doc2 = '[@lester1932, p. 7; @schmidt1988, pp. 101-103]';
    expect(nodes(doc2, 'PandocCitation')).toHaveLength(1);
    expect(texts(doc2, 'CitationKey')).toEqual(['lester1932', 'schmidt1988']);
    expect(texts(doc2, 'CitationSuffix')).toEqual([', p. 7', ', pp. 101-103']);
  });

  it('parses prefix and suffix text', () => {
    const doc = 'Comparer [voir @lester1932, p. 33].';
    expect(texts(doc, 'CitationPrefix')).toEqual(['voir ']);
    expect(texts(doc, 'CitationSuffix')).toEqual([', p. 33']);

    const doc2 = '[@clavert2013, p. 9, pour la discussion]';
    expect(texts(doc2, 'CitationSuffix')).toEqual([
      ', p. 9, pour la discussion',
    ]);
  });

  it('accepts keys with hyphens, digits, colon, underscore', () => {
    expect(texts('[@cle-inexistante-1999]', 'CitationKey')).toEqual([
      'cle-inexistante-1999',
    ]);
    expect(texts('[@a_b:c-d]', 'CitationKey')).toEqual(['a_b:c-d']);
  });

  it('spans a line break inside a paragraph', () => {
    const doc = 'Une citation [@lester1932,\np. 12] coupée.';
    expect(nodes(doc, 'PandocCitation')).toHaveLength(1);
    const doc2 = 'Cluster [@lester1932;\n@clavert2013] coupé.';
    expect(texts(doc2, 'CitationKey')).toEqual(['lester1932', 'clavert2013']);
  });

  it('rejects brackets without @, segments without key, emails in brackets', () => {
    expect(nodes('Des crochets [pas une citation].', 'PandocCitation')).toHaveLength(0);
    expect(nodes('[@]', 'PandocCitation')).toHaveLength(0);
    expect(nodes('[@a; sans-cle]', 'PandocCitation')).toHaveLength(0);
    expect(nodes('[contact frederic.clavert@uni.lu]', 'PandocCitation')).toHaveLength(0);
  });

  it('leaves markdown links and reference definitions alone', () => {
    const doc = 'Un [lien](https://example.org) et [ref][].\n\n[ref]: https://example.org\n';
    expect(nodes(doc, 'PandocCitation')).toHaveLength(0);
    expect(nodes(doc, 'Link').length).toBeGreaterThan(0);
  });
});

// S14-1-9 : `[-@clef]` supprime le nom de l'auteur chez Pandoc (SuppressAuthor,
// mesuré avec pandoc 3.13). Le `-` collé à un mot reste du texte.
describe('PandocCitation — suppressed author (-@key)', () => {
  it('parses [-@key, p. 4], the `-` being a mark', () => {
    const doc = 'Smith le montre [-@smith2020, p. 4].';
    const [cit] = nodes(doc, 'PandocCitation');
    expect(cit?.text).toBe('[-@smith2020, p. 4]');
    expect(texts(doc, 'CitationKey')).toEqual(['smith2020']);
    expect(texts(doc, 'CitationMark')).toEqual(['[', '-', '@', ']']);
    expect(texts(doc, 'CitationPrefix')).toEqual([]);
    expect(texts(doc, 'CitationSuffix')).toEqual([', p. 4']);
  });

  it('after a prefix and in a cluster, the prefix stops before the `-`', () => {
    const doc = '[voir -@a; @b]';
    expect(nodes(doc, 'PandocCitation')).toHaveLength(1);
    expect(texts(doc, 'CitationKey')).toEqual(['a', 'b']);
    expect(texts(doc, 'CitationPrefix')).toEqual(['voir ']);
    expect(texts('[@a;-@b]', 'CitationKey')).toEqual(['a', 'b']);
  });

  it('parses a bare -@key', () => {
    const doc = '-@smith2020 le dit, et Nue -@lester1932 aussi.';
    expect(texts(doc, 'CitationKey')).toEqual(['smith2020', 'lester1932']);
    expect(texts(doc, 'PandocCitation')).toEqual(['-@smith2020', '-@lester1932']);
  });

  it('a `-` glued to a word stays text, in and out of brackets', () => {
    expect(nodes('foo-@bar', 'PandocCitation')).toHaveLength(0);
    expect(nodes('a.b-@c', 'PandocCitation')).toHaveLength(0);
    expect(nodes('[foo-@bar]', 'PandocCitation')).toHaveLength(0);
    expect(nodes('[a.b-@c]', 'PandocCitation')).toHaveLength(0);
  });

  it('a `-` followed by a blank stays in the prefix, as in Pandoc', () => {
    const doc = '[voir - @a]';
    expect(texts(doc, 'CitationKey')).toEqual(['a']);
    expect(texts(doc, 'CitationPrefix')).toEqual(['voir - ']);
    expect(texts(doc, 'CitationMark')).toEqual(['[', '@', ']']);
  });
});

describe('PandocCitation — bare', () => {
  it('parses at start of text and after a delimiter', () => {
    expect(texts('@lester1932 en début.', 'CitationKey')).toEqual(['lester1932']);
    expect(texts('Comme (@clavert2013) le montre.', 'CitationKey')).toEqual([
      'clavert2013',
    ]);
    expect(texts('nue @lester1932 au milieu.', 'CitationKey')).toEqual([
      'lester1932',
    ]);
  });

  it('a following plain bracket is not attached (documented v1 limit)', () => {
    const doc = '@clavert2013 [p. 15] avec locator hors crochets.';
    expect(texts(doc, 'CitationKey')).toEqual(['clavert2013']);
    const [cit] = nodes(doc, 'PandocCitation');
    expect(cit.text).toBe('@clavert2013');
  });

  it('never matches e-mail addresses or a lone @', () => {
    expect(nodes('Écrire à frederic.clavert@uni.lu.', 'PandocCitation')).toHaveLength(0);
    expect(nodes('arobase sans clé @ isolée.', 'PandocCitation')).toHaveLength(0);
    expect(nodes('code@host', 'PandocCitation')).toHaveLength(0);
  });

  it('does not fire inside escaped brackets (Milkdown artifacts)', () => {
    expect(nodes('Une citation échappée \\[@lester1932\\] au fil.', 'PandocCitation')).toHaveLength(0);
    expect(nodes('\\[@clavert2013, p. 12\\]', 'PandocCitation')).toHaveLength(0);
  });

  it('does not parse inside inline code or fenced code', () => {
    expect(nodes('Du `code avec [@clef] dedans`.', 'PandocCitation')).toHaveLength(0);
    expect(nodes('```\n[@une-fausse-citation]\n@nue\n```\n', 'PandocCitation')).toHaveLength(0);
  });
});

describe('PandocCitation — nesting', () => {
  it('parses inside a GFM table cell', () => {
    const doc = [
      '| Clé            | Note |',
      '|:---------------|:-----|',
      '| [@schmidt1988] | x    |',
      '',
    ].join('\n');
    expect(texts(doc, 'CitationKey')).toEqual(['schmidt1988']);
    expect(nodes(doc, 'Table')).toHaveLength(1);
  });

  it('parses inside blockquotes and task lists', () => {
    expect(texts('> Bloc avec [@clavert2013].', 'CitationKey')).toEqual([
      'clavert2013',
    ]);
    expect(
      texts('- [ ] Tâche contenant [@lester1932]', 'CitationKey')
    ).toEqual(['lester1932']);
  });

  it('coexists with footnote references in the same sentence', () => {
    const doc = 'Note[^1] et citation [@lester1932, p. 12] ensemble.';
    expect(texts(doc, 'FootnoteLabel')).toEqual(['1']);
    expect(texts(doc, 'CitationKey')).toEqual(['lester1932']);
  });
});
