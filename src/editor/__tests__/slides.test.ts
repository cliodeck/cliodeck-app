import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  detectFrontmatterLines,
  parseSlides,
  slideIndexAtOffset,
  speakerNotesToPandoc,
  splitSlideParts,
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

/**
 * Parties d'une diapositive et notes du présentateur (S12-2-3) : une seule règle, sur l'arbre
 * Lezer, pour l'aperçu, les trois exports reveal.js et l'export beamer. Le contenu d'un bloc de
 * code n'est jamais un séparateur : un commentaire R (`## …`) ne coupe pas la diapositive, et un
 * `Note:` cité dans du code n'en fait pas des notes.
 */
describe('splitSlideParts — parties et notes, hors blocs de code', () => {
  it('un `## ` dans un bloc de code ne coupe pas une diapositive de niveau 1', () => {
    const segment = '# Analyse\n\n```r\n## Charger les données\nx <- read.csv("a.csv")\n```\n';
    const parts = splitSlideParts(segment);
    expect(parts).toHaveLength(1);
    expect(parts[0].markdown).toBe(segment.trim());
    expect(parts[0].notes).toBe('');
  });

  it('un `Note:` dans un bloc de code n’ouvre pas les notes', () => {
    const segment =
      '## Exemple de syntaxe\n\n```markdown\nNote: ceci est du code\nSuite du code\n```\n\nSuite du texte visible.\n';
    const parts = splitSlideParts(segment);
    expect(parts).toHaveLength(1);
    expect(parts[0].notesLineFrom).toBeNull();
    expect(parts[0].notes).toBe('');
    expect(parts[0].markdown).toBe(segment.trim());
  });

  it('la vraie note qui suit un bloc de code citant `---` et `Note:`', () => {
    const segment = '## Ex\n\n```markdown\n---\nNote: du code\n```\n\nVisible.\n\nNote:\nLa vraie note.\n';
    const [part] = splitSlideParts(segment);
    expect(part.markdown).toBe('## Ex\n\n```markdown\n---\nNote: du code\n```\n\nVisible.');
    expect(part.notes).toBe('La vraie note.');
    expect(segment.slice(part.notesLineFrom ?? 0)).toBe('Note:\nLa vraie note.\n');
  });

  it('`Note:` en première ligne : une partie faite de notes seules', () => {
    const segment = 'Note: rien à projeter\nsuite de la note\n';
    expect(splitSlideParts(segment)).toEqual([
      { from: 0, to: segment.length, notesLineFrom: 0, markdown: '', notes: 'rien à projeter\nsuite de la note' },
    ]);
  });

  it('`Notes:`, la casse et une indentation sont admis, comme dans l’aperçu', () => {
    expect(splitSlideParts('## A\n\ntexte\n\nNOTES: une\n')[0].notes).toBe('une');
    expect(splitSlideParts('## A\n\ntexte\n\n  note: deux\n')[0].notes).toBe('deux');
  });

  it('plusieurs parties sous un H1, chacune avec ses notes, bout à bout', () => {
    const segment = '# Section\n\nIntro\n\nNote: n1\n\n## V1\n\nUn\n\n## V2\n\nDeux\n\nNotes:\nn3\n';
    const parts = splitSlideParts(segment);
    expect(parts.map((p) => [p.markdown, p.notes])).toEqual([
      ['# Section\n\nIntro', 'n1'],
      ['## V1\n\nUn', ''],
      ['## V2\n\nDeux', 'n3'],
    ]);
    expect(parts.map((p) => [p.from, p.to])).toEqual([
      [0, segment.indexOf('## V1')],
      [segment.indexOf('## V1'), segment.indexOf('## V2')],
      [segment.indexOf('## V2'), segment.length],
    ]);
    expect(parts[0].notesLineFrom).toBe(segment.indexOf('Note: n1'));
  });

  it('hors diapositive de niveau 1, un `## ` ne coupe pas', () => {
    expect(splitSlideParts('## A\n\ntexte\n\n## B\n\nsuite\n')).toHaveLength(1);
  });

  it('segment vide : aucune partie', () => {
    expect(splitSlideParts('\n  \n')).toEqual([]);
  });
});

/**
 * Notes du présentateur pour beamer (S12-1-8) : pandoc ne connaît pas `Note:`, et imprimait ces
 * lignes sur la diapositive projetée. Un bloc `::: notes` devient `\note{…}`.
 */
describe('speakerNotesToPandoc — chaque note en `::: notes`, le reste intact', () => {
  it('balise chaque note, laisse le code, le frontmatter et les séparateurs', () => {
    const deck = [
      '---', 'title: Deck', '---', '',
      '## Titre', '', 'Auteur', '', 'Note: Bienvenue.', '',
      '---', '',
      '## Code', '', '```markdown', 'Note: du code', '---', '```', '', 'Visible.', '',
      'Note:', 'Vraie note,', 'sur deux lignes.', '',
      '---', '',
      '## Sans note', '', 'Fin.', '',
    ].join('\n');
    const expected = deck
      .replace('Note: Bienvenue.', '::: notes\nBienvenue.\n:::')
      .replace('Note:\nVraie note,\nsur deux lignes.', '::: notes\nVraie note,\nsur deux lignes.\n:::');
    expect(speakerNotesToPandoc(deck)).toBe(expected);
  });

  it('notes d’une partie de niveau 1 : jusqu’au titre de niveau 2 suivant', () => {
    expect(speakerNotesToPandoc('# H\n\nTexte\n\nNote: n1\n\n## Sous\n\nB\n')).toBe(
      '# H\n\nTexte\n\n::: notes\nn1\n:::\n\n## Sous\n\nB\n'
    );
  });

  it('une ligne vide avant le bloc quand la note suit un paragraphe : pandoc ne le lirait pas', () => {
    expect(speakerNotesToPandoc('## A\n\nTexte\nNote: n\n')).toBe('## A\n\nTexte\n\n::: notes\nn\n:::\n');
  });

  it('un `Note:` sans texte disparaît', () => {
    expect(speakerNotesToPandoc('## A\n\nTexte\n\nNote:\n\n---\n\n## B\n')).toBe('## A\n\nTexte\n\n\n\n---\n\n## B\n');
  });

  it('un deck sans note ressort octet pour octet', () => {
    const src = read('slides-sans-frontmatter.md');
    expect(speakerNotesToPandoc(src)).toBe(src);
  });
});
