import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  detectFrontmatterLines,
  parseSlides,
  slideIndexAtOffset,
} from '../slides';

const CORPUS = fileURLToPath(new URL('../../../test-fixtures/editor/', import.meta.url));
const read = (name: string) => readFileSync(path.join(CORPUS, name), 'utf-8');

describe('detectFrontmatterLines — règle de désambiguïsation', () => {
  it('frontmatter YAML classique', () => {
    expect(detectFrontmatterLines(['---', 'title: x', '---', ''])).toEqual({
      closingLine: 2,
    });
  });

  it("ligne vide après l'ouverture → séparateur, pas frontmatter", () => {
    expect(detectFrontmatterLines(['---', '', '# Slide', '---'])).toBeNull();
  });

  it('corps sans clé YAML → pas frontmatter', () => {
    expect(detectFrontmatterLines(['---', 'juste de la prose', '---'])).toBeNull();
  });

  it('bloc vide (`---` puis `---`) → pas frontmatter', () => {
    expect(detectFrontmatterLines(['---', '---', 'texte'])).toBeNull();
  });

  it('pas de clôture → pas frontmatter', () => {
    expect(detectFrontmatterLines(['---', 'title: x', 'body'])).toBeNull();
  });

  it('tolère le \\r final des fichiers mixtes', () => {
    expect(detectFrontmatterLines(['---\r', 'title: x\r', '---\r'])).toEqual({
      closingLine: 2,
    });
  });
});

describe('parseSlides — découpage', () => {
  it('deck simple : offsets, titres, niveaux, lignes', () => {
    const src = '# Un\n\ncontenu\n\n---\n\n## Deux\n\nfin\n';
    const deck = parseSlides(src);
    expect(deck.frontmatter).toBeNull();
    expect(deck.slides).toHaveLength(2);

    const [s1, s2] = deck.slides;
    expect(src.slice(s1.from, s1.to)).toBe('# Un\n\ncontenu\n');
    expect(s1).toMatchObject({ index: 0, line: 1, title: 'Un', level: 1 });
    expect(src.slice(s2.from, s2.to)).toBe('\n## Deux\n\nfin\n');
    expect(s2).toMatchObject({ index: 1, title: 'Deux', level: 2 });
    // Première ligne NON VIDE du segment.
    expect(s2.line).toBe(7);
  });

  it('un `---` dans un bloc de code ne sépare pas', () => {
    const src = '# S1\n\n```js\n---\n```\n\ntexte\n\n---\n\n# S2\n';
    const deck = parseSlides(src);
    expect(deck.slides).toHaveLength(2);
    expect(deck.slides[0].title).toBe('S1');
    expect(deck.slides[1].title).toBe('S2');
  });

  it('frontmatter détecté : yaml exposé, exclu des slides', () => {
    const src = '---\ntitle: Deck\ntheme: night\n---\n\n# Première\n';
    const deck = parseSlides(src);
    expect(deck.frontmatter).not.toBeNull();
    expect(deck.frontmatter?.yaml).toBe('title: Deck\ntheme: night\n');
    expect(deck.frontmatter?.from).toBe(0);
    expect(deck.slides).toHaveLength(1);
    expect(deck.slides[0].title).toBe('Première');
  });

  it('deck ouvrant sur un séparateur : première slide vide, pas de frontmatter', () => {
    const src = '---\n\n# Vraie première\n';
    const deck = parseSlides(src);
    expect(deck.frontmatter).toBeNull();
    expect(deck.slides).toHaveLength(2);
    expect(deck.slides[0].from).toBe(deck.slides[0].to); // slide vide
    expect(deck.slides[1].title).toBe('Vraie première');
  });

  it('séparateurs consécutifs : slide vide intentionnelle conservée', () => {
    const deck = parseSlides('# A\n\n---\n---\n\n# B\n');
    expect(deck.slides).toHaveLength(3);
    expect(deck.slides[1].title).toBeNull();
  });

  it('fixture slides-deck.md : frontmatter + 5 slides, piège du code ignoré', () => {
    const src = read('slides-deck.md');
    const deck = parseSlides(src);
    expect(deck.frontmatter?.yaml).toContain('title: "Danzig 1932');
    expect(deck.slides.map((s) => s.title)).toEqual([
      'Danzig, 1932',
      'Le Volkstag',
      'Un bloc de code piégé',
      'Section suivante',
      'Verticale de la section',
    ]);
    expect(deck.slides.map((s) => s.level)).toEqual([1, 2, 2, 1, 2]);
  });

  it('fixture slides-sans-frontmatter.md : pas de frontmatter, 3 slides', () => {
    const deck = parseSlides(read('slides-sans-frontmatter.md'));
    expect(deck.frontmatter).toBeNull();
    expect(deck.slides).toHaveLength(3);
    expect(deck.slides[1].title).toBe('Deck ouvrant sur un séparateur');
  });
});

describe('slideIndexAtOffset', () => {
  const src = '---\ntitle: x\n---\n\n# Un\n\n---\n\n# Deux\n';
  const deck = parseSlides(src);

  it('zone frontmatter → première slide', () => {
    expect(slideIndexAtOffset(deck, 0)).toBe(0);
  });

  it('dans une slide → son index', () => {
    const inTwo = src.indexOf('# Deux') + 2;
    expect(slideIndexAtOffset(deck, inTwo)).toBe(1);
  });

  it('sur un séparateur → la slide qui suit', () => {
    const sep = src.indexOf('\n---\n\n# Deux') + 1;
    expect(slideIndexAtOffset(deck, sep)).toBe(1);
  });

  it('au-delà de la fin → dernière slide ; deck vide → 0', () => {
    expect(slideIndexAtOffset(deck, src.length + 50)).toBe(deck.slides.length - 1);
    expect(slideIndexAtOffset(parseSlides(''), 3)).toBe(0);
  });
});
