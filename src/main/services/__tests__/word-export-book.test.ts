import { describe, it, expect } from 'vitest';
import { splitIntoChapters } from '../word-export';

/**
 * Découpage d'un manuscrit assemblé en sections docx (une par chapitre).
 * La structure docx elle-même est vérifiée par le script d'inspection du
 * .docx produit (voir le rapport de Phase 4) ; ici on verrouille la règle
 * de découpage, qui est la partie sujette aux régressions.
 */
describe('splitIntoChapters', () => {
  it('coupe à chaque titre de niveau 1', () => {
    const md = '# Un\n\nTexte un.\n\n# Deux\n\nTexte deux.\n';
    const chunks = splitIntoChapters(md);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('# Un');
    expect(chunks[0]).not.toContain('# Deux');
    expect(chunks[1]).toContain('# Deux');
  });

  it('ne coupe pas sur les titres de niveau inférieur', () => {
    const md = '# Un\n\n## Section\n\nTexte.\n\n### Sous-section\n\nSuite.\n';
    expect(splitIntoChapters(md)).toHaveLength(1);
  });

  it('ignore un # dans un bloc de code (arbre Lezer, pas regex)', () => {
    const md = '# Un\n\n```md\n# pas un chapitre\n```\n\nSuite.\n';
    const chunks = splitIntoChapters(md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('# pas un chapitre');
  });

  it('garde ce qui précède le premier titre', () => {
    const md = 'Dédicace sans titre.\n\n# Un\n\nTexte.\n';
    const chunks = splitIntoChapters(md);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe('Dédicace sans titre.');
  });

  it('rend le document intact quand il n’a aucun titre', () => {
    // Aucun découpage possible : le document est rendu tel quel, sans
    // rognage — c'est un chemin de sortie, pas un nettoyage.
    const md = 'Juste du texte.\n';
    expect(splitIntoChapters(md)).toEqual([md]);
  });
});
