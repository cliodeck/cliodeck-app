import { describe, expect, it } from 'vitest';
import {
  computeInlineToggle,
  computeSelectionWrap,
  INLINE_MARKS,
  looksLikeCitationKey,
  type SelectionWrapOptions,
  type SelectionWrapType,
  type SnippetTemplates,
} from '../cm/inline-formatting';
import { parseSlides } from '../slides';

const BOLD = INLINE_MARKS.bold.markers;
const ITALIC = INLINE_MARKS.italic.markers;

/** Applique le résultat au document pour vérifier le texte final. */
function apply(doc: string, from: number, to: number, markers: readonly string[], ph: string) {
  const r = computeInlineToggle(doc, from, to, markers, ph);
  const out = doc.slice(0, r.from) + r.insert + doc.slice(r.to);
  return { out, sel: out.slice(r.selFrom, r.selTo), r };
}

describe('computeInlineToggle — régression #10 (la sélection était écrasée)', () => {
  it('entoure la sélection au lieu de la remplacer', () => {
    const doc = 'un mot important';
    const { out, sel } = apply(doc, 3, 6, BOLD, 'x');
    expect(out).toBe('un **mot** important');
    expect(sel).toBe('mot');
  });

  it('retire les marques quand la sélection est déjà entourée (toggle off)', () => {
    const doc = 'un **mot** important';
    // « mot » sélectionné entre les marques
    const { out, sel } = apply(doc, 5, 8, BOLD, 'x');
    expect(out).toBe('un mot important');
    expect(sel).toBe('mot');
  });

  it('retire les marques quand la sélection les inclut', () => {
    const doc = 'un **mot** important';
    const { out, sel } = apply(doc, 3, 10, BOLD, 'x');
    expect(out).toBe('un mot important');
    expect(sel).toBe('mot');
  });

  it("reconnaît l'alias __ au unwrap mais écrit ** au wrap", () => {
    const inc = apply('du __gras__ ici', 3, 11, BOLD, 'x');
    expect(inc.out).toBe('du gras ici');

    const wrap = apply('du gras ici', 3, 7, BOLD, 'x');
    expect(wrap.out).toBe('du **gras** ici');
  });

  it('sélection vide : insère les marques avec le placeholder sélectionné', () => {
    const { out, sel } = apply('début ', 6, 6, BOLD, 'texte en gras');
    expect(out).toBe('début **texte en gras**');
    expect(sel).toBe('texte en gras');
  });

  it("l'italique dans du gras s'imbrique sans amputer la paire **", () => {
    const doc = 'un **mot** important';
    // « mot » sélectionné : entouré de « * » côté doc, mais ce sont les
    // moitiés d'une paire ** — l'italique doit imbriquer, pas amputer.
    const { out } = apply(doc, 5, 8, ITALIC, 'x');
    expect(out).toBe('un **_mot_** important');
  });

  it("l'italique se retire proprement (_mot_ sélectionné avec marques)", () => {
    const { out, sel } = apply('en _italique_ ici', 3, 13, ITALIC, 'x');
    expect(out).toBe('en italique ici');
    expect(sel).toBe('italique');
  });

  it('en début de document, pas de lecture hors bornes', () => {
    const { out } = apply('mot', 0, 3, BOLD, 'x');
    expect(out).toBe('**mot**');
  });
});

const TEMPLATES: SnippetTemplates = {
  linkText: 'texte du lien',
  citationKey: 'clé',
  table: '\n| A | B |\n|---|---|\n| 1 | 2 |\n',
  blockquote: '\n> Première\n> Seconde\n',
  boldText: 'gras',
  italicText: 'italique',
};

/** Le résultat appliqué au document : le texte final, et ce que la sélection y désigne. */
function wrap(
  doc: string,
  selected: string | [number, number],
  type: SelectionWrapType,
  options?: SelectionWrapOptions
) {
  const [from, to] =
    typeof selected === 'string' ? [doc.indexOf(selected), doc.indexOf(selected) + selected.length] : selected;
  const r = computeSelectionWrap(doc, from, to, type, TEMPLATES, options);
  const out = doc.slice(0, r.from) + r.insert + doc.slice(r.to);
  return { out, sel: out.slice(r.selFrom, r.selTo), r };
}

describe('computeSelectionWrap — la sélection n’est plus écrasée', () => {
  describe('lien', () => {
    it('enveloppe la sélection, et `url` reste à remplacer', () => {
      const { out, sel } = wrap('Les archives nationales conservent.', 'archives nationales', 'link');
      expect(out).toBe('Les [archives nationales](url) conservent.');
      expect(sel).toBe('url');
    });

    it('un triple clic prend la fin de ligne : elle reste hors du lien', () => {
      const { out, sel } = wrap('Un titre\nSuite.', 'Un titre\n', 'link');
      expect(out).toBe('[Un titre](url)\nSuite.');
      expect(sel).toBe('url');
    });

    it('sélection vide : le gabarit, le curseur derrière', () => {
      const { out, r } = wrap('Avant après', [6, 6], 'link');
      expect(out).toBe('Avant [texte du lien](url)après');
      expect(r.selFrom).toBe(r.selTo);
      expect(r.selTo).toBe('Avant [texte du lien](url)'.length);
    });

    it('rien que la fin de ligne : aucun texte à envelopper, et elle reste', () => {
      const { out } = wrap('Un\nDeux', [2, 3], 'link');
      expect(out).toBe('Un\n[texte du lien](url)Deux');
    });
  });

  describe('citation', () => {
    it('une clé devient une citation, le curseur derrière', () => {
      const { out, r } = wrap('Voir Smith2020 ici.', 'Smith2020', 'citation');
      expect(out).toBe('Voir [@Smith2020] ici.');
      expect(r.selFrom).toBe(r.selTo);
      expect(r.selTo).toBe('Voir [@Smith2020]'.length);
    });

    it('un mot ordinaire reste, et le gabarit se pose derrière lui, sélectionné', () => {
      const { out, sel } = wrap('Une histoire longue.', 'histoire', 'citation');
      expect(out).toBe('Une histoire [@clé] longue.');
      expect(sel).toBe('clé');
    });

    it('un passage avec un espace ou un saut de ligne n’est jamais une clé', () => {
      expect(wrap('Smith 2020 dit', 'Smith 2020', 'citation').out).toBe('Smith 2020 [@clé] dit');
      expect(wrap('Smith2020\nDoe2021 x', 'Smith2020\nDoe2021', 'citation').out).toBe(
        'Smith2020\nDoe2021 [@clé] x'
      );
    });

    it('un triple clic sur une clé seule sur sa ligne : le gabarit reste sur cette ligne', () => {
      const { out, sel } = wrap('Smith2020\nSuite.', 'Smith2020\n', 'citation');
      expect(out).toBe('Smith2020 [@clé]\nSuite.');
      expect(sel).toBe('clé');
    });

    it('sélection vide : le gabarit, le curseur derrière', () => {
      const { out, r } = wrap('Avant après', [6, 6], 'citation');
      expect(out).toBe('Avant [@clé]après');
      expect(r.selFrom).toBe(r.selTo);
    });
  });

  describe('citation en bloc', () => {
    it('un paragraphe entier', () => {
      const { out, sel } = wrap('Avant.\n\nUn paragraphe.\n\nAprès.', 'Un paragraphe.', 'blockquote');
      expect(out).toBe('Avant.\n\n> Un paragraphe.\n\nAprès.');
      expect(sel).toBe('> Un paragraphe.');
    });

    it('première et dernière lignes partielles : le bloc va jusqu’aux lignes entières', () => {
      const doc = 'Ligne une.\nLigne deux.\nLigne trois.\nLigne quatre.';
      const { out, sel } = wrap(doc, 'une.\nLigne deux.\nLigne', 'blockquote');
      expect(out).toBe('> Ligne une.\n> Ligne deux.\n> Ligne trois.\nLigne quatre.');
      expect(sel).toBe('> Ligne une.\n> Ligne deux.\n> Ligne trois.');
    });

    it('une ligne vide au milieu : `>`, sans espace de fin', () => {
      expect(wrap('Un.\n\nDeux.', [0, 9], 'blockquote').out).toBe('> Un.\n>\n> Deux.');
    });

    it('une sélection qui finit en tête de ligne ne prend pas cette ligne', () => {
      expect(wrap('Un.\nDeux.\nTrois.', 'Un.\nDeux.\n', 'blockquote').out).toBe('> Un.\n> Deux.\nTrois.');
    });

    it('fin de document sans saut final : aucun n’est ajouté', () => {
      expect(wrap('Un.\nDeux.', 'Deux.', 'blockquote').out).toBe('Un.\n> Deux.');
    });

    it('sélection au tout début, première ligne vide comprise', () => {
      expect(wrap('\nUn.', [0, 4], 'blockquote').out).toBe('>\n> Un.');
    });

    it('une ligne déjà préfixée se préfixe encore : le menu dit Insérer, et `> >` est du Markdown', () => {
      expect(wrap('> Un.\nDeux.', [0, 11], 'blockquote').out).toBe('> > Un.\n> Deux.');
    });

    describe('dans un deck', () => {
      const DECK = { keepSlideSeparators: true };

      it('une frontière de diapositive reste une frontière, et ses lignes vides restent vides', () => {
        const deck = '# Une\n\nTexte.\n\n---\n\n# Deux\n\nSuite.\n';
        const { out } = wrap(deck, 'Texte.\n\n---\n\n# Deux', 'blockquote', DECK);
        expect(out).toBe('# Une\n\n> Texte.\n\n---\n\n> # Deux\n\nSuite.\n');
        expect(parseSlides(out).slides).toHaveLength(parseSlides(deck).slides.length);
      });

      it('la ligne vide juste sous une frontière non sélectionnée reste vide', () => {
        const deck = '---\n\n# Une\n\nNote: un point\n\n---\n\n# Deux\n';
        const { out } = wrap(deck, [4, deck.indexOf('# Une') + '# Une'.length], 'blockquote', DECK);
        expect(out).toBe('---\n\n> # Une\n\nNote: un point\n\n---\n\n# Deux\n');
        expect(parseSlides(deck).slides).toHaveLength(3);
        expect(parseSlides(out).slides).toHaveLength(3);
        expect(parseSlides(out).frontmatter).toBeNull();
      });

      it('la ligne vide juste au-dessus d’une frontière non sélectionnée aussi', () => {
        const { out } = wrap('# Une\n\n---\n\n# Deux\n', [0, 7], 'blockquote', DECK);
        expect(out).toBe('> # Une\n\n---\n\n# Deux\n');
      });

      it('un frontmatter sélectionné reste un frontmatter', () => {
        const deck = '---\ntitle: Cours\n---\n\n# Une\n\n---\n\n# Deux\n';
        const { out } = wrap(deck, [0, deck.length], 'blockquote', DECK);
        expect(out).toBe('---\ntitle: Cours\n---\n\n> # Une\n\n---\n\n> # Deux\n');
        expect(parseSlides(out).slides).toHaveLength(2);
        expect(parseSlides(out).frontmatter?.yaml).toBe('title: Cours\n');
      });

      it('un `---` de bloc de code n’est pas une frontière : il reste dans le bloc, cité avec lui', () => {
        const deck = '# Une\n\n```\n---\n```\n\n---\n\n# Deux\n';
        const { out } = wrap(deck, [0, deck.length], 'blockquote', DECK);
        expect(out).toBe('> # Une\n>\n> ```\n> ---\n> ```\n\n---\n\n> # Deux\n');
        expect(parseSlides(out).slides).toHaveLength(parseSlides(deck).slides.length);
      });

      it('fichier mixte : le `\\r` d’une ligne reste à sa place, frontière comprise', () => {
        expect(wrap('Un.\r\n---\r\nDeux.', [0, 15], 'blockquote', DECK).out).toBe('> Un.\r\n---\r\n> Deux.');
      });
    });

    describe('hors d’un deck, `---` est du texte', () => {
      it('un titre Setext se cite avec son soulignement, et reste un titre', () => {
        const { out } = wrap('Titre\n---\n\nTexte\n', [0, 16], 'blockquote');
        expect(out).toBe('> Titre\n> ---\n>\n> Texte\n');
      });

      it('un filet aussi, et ses lignes vides restent dans le bloc', () => {
        expect(wrap('Un.\n\n---\n\nDeux.', [0, 15], 'blockquote').out).toBe('> Un.\n>\n> ---\n>\n> Deux.');
      });

      it('le frontmatter, lui, n’est du texte nulle part', () => {
        const doc = '---\ntitle: Article\n---\n\nTexte.\n';
        expect(wrap(doc, [0, doc.length], 'blockquote').out).toBe('---\ntitle: Article\n---\n\n> Texte.\n');
      });

      it('tout le frontmatter et rien d’autre : rien ne change', () => {
        const doc = '---\ntitle: Article\n---\n\nTexte.\n';
        const { r } = wrap(doc, '---\ntitle: Article\n---', 'blockquote');
        expect(r.insert).toBe(doc.slice(r.from, r.to));
      });
    });

    it('sélection vide : le gabarit', () => {
      expect(wrap('Avant', [5, 5], 'blockquote').out).toBe('Avant\n> Première\n> Seconde\n');
    });
  });

  describe('tableau', () => {
    it('s’insère après la sélection, qui reste entière', () => {
      const { out, r } = wrap('Un mot ici', 'mot', 'table');
      expect(out).toBe(`Un mot${TEMPLATES.table} ici`);
      expect(r.selFrom).toBe(r.selTo);
      expect(r.selTo).toBe(`Un mot${TEMPLATES.table}`.length);
    });

    it('sélection vide : au curseur', () => {
      expect(wrap('Avant', [5, 5], 'table').out).toBe(`Avant${TEMPLATES.table}`);
    });
  });
});

describe('looksLikeCitationKey', () => {
  it.each(['Smith2020', 'smith:2020', 'doe_book', 'clavert2019a', 'Müller2015', 'smith:2020:titre'])(
    '%s ressemble à une clé',
    (key) => {
      expect(looksLikeCitationKey(key)).toBe(true);
    }
  );

  it.each([
    'histoire',
    'XXe',
    'peut-être',
    "l'histoire",
    '1914',
    '1er',
    'Smith 2020',
    'Smith2020\nDoe2021',
    'Smith2020\n',
    ' Smith2020',
    'Smith2020,',
    'Note:',
    'https://exemple.org/a1',
    '',
  ])('%j n’en est pas une', (text) => {
    expect(looksLikeCitationKey(text)).toBe(false);
  });
});
