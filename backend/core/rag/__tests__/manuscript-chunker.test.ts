import { describe, expect, it } from 'vitest';
import {
  CHUNK_CHAR_TARGET,
  chunkManuscriptChapter,
} from '../manuscript-chunker.js';

describe('chunkManuscriptChapter — découpage du manuscrit', () => {
  it('coupe sur les titres et garde le titre de section', () => {
    const md = [
      '# Le Volkstag',
      '',
      'Les élections de 1932 marquent une rupture.',
      '',
      '## Contexte européen',
      '',
      'La Société des Nations hésite.',
    ].join('\n');

    const chunks = chunkManuscriptChapter(md);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].sectionTitle).toBe('Le Volkstag');
    expect(chunks[0].content).toContain('élections de 1932');
    expect(chunks[1].sectionTitle).toBe('Contexte européen');
    expect(chunks[1].content).toContain('Société des Nations');
  });

  it('épure la syntaxe : ni citation, ni marqueur de note dans le texte indexé', () => {
    const md = [
      '# Danzig',
      '',
      'Le port est disputé [@lester1932] et surveillé[^1].',
      '',
      '[^1]: Rapport du haut-commissaire.',
    ].join('\n');

    const [chunk] = chunkManuscriptChapter(md);
    // Un embedding de « [@lester1932] » n'apprend rien : la clé disparaît.
    expect(chunk.content).not.toContain('[@lester1932]');
    expect(chunk.content).not.toContain('[^1]');
    expect(chunk.content).toContain('Le port est disputé');
    // En revanche le CORPS de la note est du texte de l'auteur : il reste.
    expect(chunk.content).toContain('Rapport du haut-commissaire');
  });

  it('ignore un titre situé dans un bloc de code', () => {
    const md = [
      '# Vrai titre',
      '',
      'Corps.',
      '',
      '```md',
      '# faux titre',
      '```',
    ].join('\n');

    const chunks = chunkManuscriptChapter(md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].sectionTitle).toBe('Vrai titre');
    expect(chunks[0].content).not.toContain('faux titre');
  });

  it('découpe une longue section en plusieurs chunks', () => {
    const phrase = 'Le Volkstag délibère longuement sur la question portuaire. ';
    const md = `# Chapitre\n\n${phrase.repeat(120)}`;

    const chunks = chunkManuscriptChapter(md);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(CHUNK_CHAR_TARGET + 200);
      expect(c.sectionTitle).toBe('Chapitre');
    }
    // Index continus, sans trou.
    expect(chunks.map((c) => c.chunkIndex)).toEqual(
      chunks.map((_, i) => i)
    );
  });

  it('ne produit rien pour un chapitre vide ou purement syntaxique', () => {
    expect(chunkManuscriptChapter('')).toEqual([]);
    expect(chunkManuscriptChapter('# Titre seul')).toEqual([]);
    expect(chunkManuscriptChapter('```js\nconst a = 1;\n```')).toEqual([]);
  });

  it('garde le préambule situé avant le premier titre', () => {
    const md = 'Une phrase liminaire.\n\n# Titre\n\nCorps.';
    const chunks = chunkManuscriptChapter(md);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].sectionTitle).toBeUndefined();
    expect(chunks[0].content).toContain('phrase liminaire');
  });

  it('porte la ligne de section, pour rouvrir au bon endroit', () => {
    const md = '# Un\n\nAlpha.\n\n## Deux\n\nBeta.';
    const chunks = chunkManuscriptChapter(md);
    expect(chunks[0].line).toBe(1);
    expect(chunks[1].line).toBe(5);
  });
});
