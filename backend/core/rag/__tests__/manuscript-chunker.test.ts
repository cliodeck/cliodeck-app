import { describe, expect, it } from 'vitest';
import {
  CHUNK_CHAR_TARGET,
  CHUNKER_VERSION,
  FOOTNOTE_MIN_WORDS,
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
    // Sans option (notes de lecture), le CORPS de la note reste : c'est du
    // texte de l'auteur.
    expect(chunk.content).toContain('Rapport du haut-commissaire');
  });

  it('n’embarque que ce que l’auteur a écrit : citations en bloc et notes de référence sortent', () => {
    // Palier 3 (docs/poids-du-manuscrit.md) : un passage cité d'une source
    // revenait comme source [N] et comme manuscrit [M], et une note de
    // référence renvoyait les noms et titres de la bibliographie dans le
    // corpus du manuscrit.
    const longNote = Array.from({ length: FOOTNOTE_MIN_WORDS + 5 }, (_, i) => `mot${i}`).join(' ');
    const md = [
      '# Danzig',
      '',
      'Le port est disputé[^1], et pourtant la Ville libre résiste[^2].',
      '',
      '> La Société des Nations ne saurait tolérer une telle atteinte à ses prérogatives.',
      '',
      'Ma lecture diverge de celle de Lester.',
      '',
      '[^1]: Lester, *Rapport annuel* (Genève, 1932), p. 45.',
      `[^2]: ${longNote}`,
    ].join('\n');

    const [chunk] = chunkManuscriptChapter(md, { dropQuotations: true });
    expect(chunk.content).toContain('Le port est disputé');
    expect(chunk.content).toContain('Ma lecture diverge');
    expect(chunk.content).not.toContain('ne saurait tolérer');
    expect(chunk.content).not.toContain('Rapport annuel');
    // Une note longue est un argument : elle reste.
    expect(chunk.content).toContain('mot0');

    // Sans l'option, tout reste (notes de lecture).
    const [kept] = chunkManuscriptChapter(md);
    expect(kept.content).toContain('ne saurait tolérer');
    expect(kept.content).toContain('Rapport annuel');
  });

  it('porte une version de découpage que l’indexeur mêle à l’empreinte', () => {
    expect(CHUNKER_VERSION).toBeGreaterThanOrEqual(2);
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
