import { describe, it, expect } from 'vitest';
import { yamlQuote } from '../word-export';

// Reliquat de l'audit post-fusion (#57, point 1) : title/author/date
// étaient interpolés bruts dans le frontmatter pandoc.
describe('yamlQuote', () => {
  it('échappe les guillemets', () => {
    expect(yamlQuote('Un "titre" cité')).toBe('"Un \\"titre\\" cité"');
  });

  it('échappe les antislashs avant les guillemets', () => {
    expect(yamlQuote('a\\"b')).toBe('"a\\\\\\"b"');
  });

  it('aplatit les retours à la ligne (pas d’injection de clés)', () => {
    expect(yamlQuote('Titre\nauteur: pirate')).toBe('"Titre auteur: pirate"');
    expect(yamlQuote('a\r\nb')).toBe('"a b"');
  });

  it('laisse une valeur simple intacte', () => {
    expect(yamlQuote('Mémoires de guerre')).toBe('"Mémoires de guerre"');
  });
});
