import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toggleComment } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';

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

  it('une diapositive commentée par Cmd+/ : pas de notes, rien n’est déplacé', () => {
    const segment = commentOut(CONTEXTE, 0, CONTEXTE.trimEnd().length);
    expect(segment).toBe(`<!-- ${CONTEXTE.trimEnd()} -->\n`);
    expect(splitSlideParts(segment)).toEqual([
      { from: 0, to: segment.length, notesLineFrom: null, markdown: segment.trim(), notes: '' },
    ]);
  });

  it.each([
    ['un commentaire', '<!--\nNote: dans le commentaire\n-->'],
    ['un commentaire en ligne', 'Avant <!--\nNote: dans le commentaire\n--> après.'],
    ['un bloc HTML', '<div>\nNote: dans le bloc HTML\n</div>'],
    ['un élément HTML encore ouvert', '<p class="small">\nNote: dans le paragraphe HTML\n</p>'],
    ['un élément dont un attribut contient `>`', '<div title="a > b">\nNote: dans le bloc HTML\n</div>'],
    ['un bloc `<pre>`', '<pre>\nNote: dans le pre\n</pre>'],
    ['un commentaire au milieu d’un bloc HTML', '<img src="a.png">\n<!--\nNote: dans le commentaire\n-->'],
    ['un bloc de code indenté, dès sa première ligne', '    Note: dans le code\n    x <- 1'],
  ])('un `Note:` dans %s n’ouvre pas les notes, et la suite reste projetée', (_, raw) => {
    const segment = `## T\n\nTexte.\n\n${raw}\n\nTexte après, projeté.\n`;
    const [part] = splitSlideParts(segment);
    expect(part.notesLineFrom).toBeNull();
    expect(part.markdown).toBe(segment.trim());
  });

  /**
   * Revue de L10-3 (seconde passe). En CommonMark, un bloc HTML ouvert par `<img …>`, `</div>` ou
   * `<p>…</p>` ne s'arrête qu'à la ligne vide : un `Note:` tapé juste dessous tombait dans le bloc,
   * et la note s'affichait sur la diapositive projetée, alors que main la cachait. Seul ce qui est
   * dans un élément encore ouvert est brut.
   */
  it.each([
    ['une image', '<img src="figure.png" width="600">'],
    ['un élément refermé sur sa ligne', '<p class="small">Petit texte</p>'],
    ['un cadre', '<iframe src="https://example.org/carte"></iframe>'],
    ['un saut de ligne', '<br>'],
    ['la fermeture d’un div ouvert plus haut', '<div class="colonnes">\n\nTexte en colonnes.\n\n</div>'],
  ])('un `Note:` juste sous %s ouvre les notes', (_, html) => {
    const [part] = splitSlideParts(`## T\n\n${html}\nNote: Commenter la figure.\n`);
    expect(part.markdown).toBe(`## T\n\n${html}`);
    expect(part.notes).toBe('Commenter la figure.');
  });

  it('la vraie note qui suit un commentaire', () => {
    const [part] = splitSlideParts('## T\n\n<!--\nNote: ancienne\n-->\n\nNote: la vraie\n');
    expect(part.markdown).toBe('## T\n\n<!--\nNote: ancienne\n-->');
    expect(part.notes).toBe('la vraie');
  });

  /**
   * Une note court jusqu'à la fin de sa partie, au sens de reveal.js : le prochain `---`, ou le
   * prochain `## ` sous un `# ` d'ouverture. Un titre `# ` venu après la note, sans `---`, est donc
   * dans la note, dans l'aperçu comme dans le PDF (où `--slide-level=1` en aurait fait un cadre).
   * Comportement fixé ici ; le changer est une décision de l'auteur (revue de L10-3).
   */
  it('un `# ` après la note, sans `---`, reste dans la note', () => {
    const segment = '# Cadre un\n\nTexte un.\n\nNote: note un\n\n# Cadre deux\n\nTexte deux.\n';
    expect(splitSlideParts(segment).map((p) => [p.markdown, p.notes])).toEqual([
      ['# Cadre un\n\nTexte un.', 'note un\n\n# Cadre deux\n\nTexte deux.'],
    ]);
  });
});

/** La diapositive « Contexte » du gabarit de présentation (`slidesTemplate`, project-manager.ts). */
const CONTEXTE = [
  '## Contexte',
  '',
  '- Point important 1',
  '- Point important 2',
  '- Point important 3',
  '',
  'Note: Détaillez ici le contexte de votre recherche.',
  '',
].join('\n');

/** Le geste de l'éditeur : Cmd+/ (`toggleComment`, `defaultKeymap`) sur `from`–`to`. */
function commentOut(doc: string, from: number, to: number): string {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.range(from, to),
    extensions: [markdown({ base: markdownLanguage })],
  });
  toggleComment({ state, dispatch: (tr) => (state = tr.state) });
  return state.doc.toString();
}

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

  /**
   * Revue de L10-3 : `::: notes` ouvert dans un commentaire laissait le `:::` de clôture hors du
   * commentaire, et pandoc l'imprimait sur la diapositive projetée.
   */
  it('une diapositive commentée par Cmd+/ ressort intacte, les autres notes balisées', () => {
    const deck = `## Garde\n\nNote: n1\n\n---\n\n${CONTEXTE}\n---\n\n## Fin\n`;
    const start = deck.indexOf('## Contexte');
    const commented = commentOut(deck, start, start + CONTEXTE.trimEnd().length);
    expect(commented).toContain(`<!-- ${CONTEXTE.trimEnd()} -->`);
    expect(speakerNotesToPandoc(commented)).toBe(commented.replace('Note: n1', '::: notes\nn1\n:::'));
  });

  it('un commentaire à cheval sur un `---` (Cmd+/ sur deux diapositives) : rien n’est balisé dedans', () => {
    const deck = `## Garde\n\nNote: n1\n\n---\n\n${CONTEXTE}\n---\n\n${CONTEXTE.replace('Contexte', 'Méthode')}\n---\n\n## Fin\n`;
    const start = deck.indexOf('## Contexte');
    const end = deck.indexOf('---\n\n## Fin') - 2;
    const commented = commentOut(deck, start, end);
    expect(commented.slice(start, end + 9)).toMatch(/^<!-- ## Contexte[\s\S]*\n---\n[\s\S]*recherche\. -->$/);
    expect(speakerNotesToPandoc(commented)).toBe(commented.replace('Note: n1', '::: notes\nn1\n:::'));
  });

  /**
   * Mesuré avec pandoc 3.13 : un `:::` de clôture avalé par le commentaire laisse le bloc de notes
   * ouvert jusqu'à la fin du deck, et toutes les diapositives suivantes passent dans la note.
   * Laissée telle quelle, la note s'imprime comme avant L10-3, et rien ne disparaît.
   */
  it('une note qui ouvre un commentaire fermé dans une diapositive suivante reste telle quelle', () => {
    const deck = '## A\n\nTexte A.\n\nNote: n\n<!--\nbrouillon\n\n---\n\n## B\n\nfin -->\n\n---\n\n## C\n\nNote: c\n';
    expect(speakerNotesToPandoc(deck)).toBe(deck.replace('Note: c', '::: notes\nc\n:::'));
  });

  /**
   * Revue de L10-3 (seconde passe). La garde du bloc fermé dans du brut comparait la fin de la note
   * sans ses blancs à la plage brute de Lezer, qui garde les blancs de fin de ligne et le `\r` des
   * fichiers CRLF (que l'éditeur conserve) : la note restait telle quelle et pandoc l'imprimait sur
   * la diapositive, sans message.
   */
  it.each([
    ['LF', '\n', '', '<!-- ancienne version -->'],
    ['CRLF', '\r\n', '', '<!-- ancienne version -->'],
    ['des blancs après le commentaire', '\n', '  ', '<!-- ancienne version -->'],
    ['des blancs après un bloc de code', '\n', '  ', '```r\nx <- 1\n```'],
  ])('une note qui finit par du brut, en %s : balisée', (_, eol, trailing, raw) => {
    const deck = `## A\n\nTexte\n\nNote: NOTEUN\n\n${raw}${trailing}\n\n---\n\n## B\n\nTexte B\n\nNote: NOTEDEUX\n`.replace(
      /\n/g,
      eol
    );
    const out = speakerNotesToPandoc(deck);
    expect(out).not.toMatch(/Note: NOTE/);
    expect(out).toContain(`::: notes\nNOTEUN${eol}${eol}${raw.replace(/\n/g, eol)}\n:::`);
    expect(out).toContain('::: notes\nNOTEDEUX\n:::');
  });

  it('un `Note:` juste sous une image ou sous un `</div>` : balisé, comme dans l’aperçu', () => {
    const deck =
      '## F\n\n<img src="f.png" width="600">\nNote: n1\n\n---\n\n## C\n\n<div class="x">\n\nTexte\n\n</div>\nNote: n2\n';
    expect(speakerNotesToPandoc(deck)).toBe(
      '## F\n\n<img src="f.png" width="600">\n\n::: notes\nn1\n:::\n\n---\n\n' +
        '## C\n\n<div class="x">\n\nTexte\n\n</div>\n\n::: notes\nn2\n:::\n'
    );
  });

  /**
   * Pour pandoc, `<div>` est une structure (div natif), et non du brut. Mesuré avec pandoc 3.13 :
   * un bloc `::: notes` qui referme un `<div>` ouvert avant lui, ou en laisse un ouvert, laisse ce
   * div ouvert jusqu'à la fin du deck, et la diapositive suivante tombe dans le même cadre, sans
   * message. Laissée telle quelle, la note s'imprime comme avant L10-3, et le deck garde ses cadres.
   */
  it.each([
    ['referme un `<div>` ouvert avant elle', '## C\n\n<div class="x">\n\nTexte\n\nNote: n\n\n</div>\n'],
    ['ouvre un `<div>` sans le refermer', '## C\n\nTexte\n\nNote: n\n\n<div class="x">\n\nSuite\n'],
  ])('une note qui %s reste telle quelle', (_, slide) => {
    const deck = `${slide}\n---\n\n## Suite\n\nNote: s\n`;
    expect(speakerNotesToPandoc(deck)).toBe(deck.replace('Note: s', '::: notes\ns\n:::'));
  });

  it('une note qui contient un `<div>` refermé est balisée', () => {
    expect(speakerNotesToPandoc('## C\n\nTexte\n\nNote: n\n\n<div class="a">\n\ny\n\n</div>\n')).toBe(
      '## C\n\nTexte\n\n::: notes\nn\n\n<div class="a">\n\ny\n\n</div>\n:::\n'
    );
  });

  it('un `<!--` dans une valeur du frontmatter, du YAML pour pandoc, n’arrête rien', () => {
    const deck = '---\ntitle: Deck\nabstract: |\n  <!-- brouillon\n---\n\n## A\n\nTexte\n\nNote: n\n';
    expect(speakerNotesToPandoc(deck)).toBe(deck.replace('Note: n', '::: notes\nn\n:::'));
  });

  it('un `# ` après la note, sans `---`, entre dans le bloc de notes (règle de l’aperçu)', () => {
    expect(speakerNotesToPandoc('# Cadre un\n\nTexte un.\n\nNote: note un\n\n# Cadre deux\n\nTexte deux.\n')).toBe(
      '# Cadre un\n\nTexte un.\n\n::: notes\nnote un\n\n# Cadre deux\n\nTexte deux.\n:::\n'
    );
  });
});
