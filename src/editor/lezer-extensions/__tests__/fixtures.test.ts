import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nodes, texts } from './helpers';

const CORPUS = fileURLToPath(
  new URL('../../../../test-fixtures/editor/', import.meta.url)
);
const read = (name: string): string =>
  readFileSync(path.join(CORPUS, name), 'utf-8');

describe('corpus réel — footnotes.md', () => {
  const doc = read('footnotes.md');

  it('finds the five references, including free-form ids', () => {
    expect(texts(doc, 'FootnoteReference').sort()).toEqual(
      ['[^1]', '[^2]', '[^3]', '[^4]', '[^lester-danzig]'].sort()
    );
  });

  it('finds the five definitions, multi-paragraph included', () => {
    const defs = nodes(doc, 'FootnoteDefinition');
    expect(defs).toHaveLength(5);
    const third = defs.find((d) => d.text.includes('Troisième'));
    expect(third?.text).toContain('second paragraphe dans la même note');
  });
});

describe('corpus réel — citations.md', () => {
  const doc = read('citations.md');

  it('finds every citation cluster and none of the traps', () => {
    const citations = nodes(doc, 'PandocCitation');
    expect(citations).toHaveLength(11);
    // Pièges : email, @ isolée, crochets sans arobase.
    for (const c of citations) {
      expect(c.text).not.toContain('uni.lu');
      expect(c.text).not.toBe('@');
    }
    expect(texts(doc, 'CitationKey')).toEqual([
      'lester1932',
      'lester1932',
      'clavert2013',
      'schmidt1988',
      'lester1932',
      'clavert2013',
      'lester1932',
      'schmidt1988',
      'lester1932',
      'clavert2013',
      'lester1932',
      'clavert2013',
      'cle-inexistante-1999',
    ]);
  });

  it('keeps prefix and long suffix intact', () => {
    expect(texts(doc, 'CitationPrefix')).toEqual(['voir ']);
    expect(texts(doc, 'CitationSuffix')).toContain(', p. 9, pour la discussion');
  });
});

describe('corpus réel — kitchen-sink.md', () => {
  const doc = read('kitchen-sink.md');

  it('references and definitions, code block excluded', () => {
    expect(texts(doc, 'FootnoteReference').sort()).toEqual(
      ['[^1]', '[^2]', '[^3]', '[^4]'].sort()
    );
    expect(nodes(doc, 'FootnoteDefinition')).toHaveLength(4);
    // [^99] vit dans le bloc de code : aucun nœud.
    for (const label of texts(doc, 'FootnoteLabel')) {
      expect(label).not.toBe('99');
    }
  });

  it('citations across line breaks, in table, quote and task — not in code', () => {
    const citations = nodes(doc, 'PandocCitation');
    expect(citations).toHaveLength(5);
    for (const c of citations) {
      expect(c.text).not.toContain('fausse');
    }
    expect(texts(doc, 'CitationKey')).toEqual([
      'lester1932', // [@lester1932,\np. 12]
      'lester1932', // cluster, clé 1
      'clavert2013', // cluster, clé 2
      'schmidt1988', // cellule de table
      'clavert2013', // blockquote
      'lester1932', // tâche
    ]);
  });
});
