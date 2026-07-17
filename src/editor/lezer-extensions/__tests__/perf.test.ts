import { describe, expect, it } from 'vitest';
import { parser } from './helpers';

describe('performance smoke', () => {
  it('parses a ~50k-word document with citations and notes in reasonable time', () => {
    const para =
      'Le Volkstag de Danzig[^1] discute [@lester1932, p. 12] puis ' +
      '[@lester1932; @clavert2013] tandis que @schmidt1988 objecte. '.repeat(40) +
      '\n\n';
    const doc = para.repeat(120) + '[^1]: Une note.\n';
    const start = performance.now();
    const tree = parser.parse(doc);
    const ms = performance.now() - start;
    expect(tree.length).toBe(doc.length);
    // ~1,4 Mo de markdown dense : la barre est large, le test ne doit
    // détecter que les régressions catastrophiques (backtracking).
    expect(ms).toBeLessThan(2000);
  });
});
