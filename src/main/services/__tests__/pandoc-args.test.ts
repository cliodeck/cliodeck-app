/**
 * Couche pandoc/LaTeX — tests des fonctions pures (item 24 de l'audit).
 *
 * Cette logique n'était vérifiable qu'en produisant des PDF à la main, alors
 * qu'elle porte l'assemblage des chapitres, les trois styles de notes, la
 * numérotation et la bibliographie par chapitre. Les combinaisons ci-dessous
 * sont celles qui changent réellement le document produit.
 */
import { describe, expect, it } from 'vitest';
import type { BookSettings } from '../../../../backend/types/book.js';
import {
  buildBeamerCustomizations,
  buildPandocArgs,
  computeSecnumdepth,
  escapeLatex,
  resolveBibliographyMode,
  resolveBookSettings,
  type PandocArgsInput,
} from '../pandoc-args.js';

const BASE: PandocArgsInput = {
  mdPath: '/tmp/w/input.md',
  outputPath: '/out/livre.pdf',
  templatePath: '/tmp/w/template.latex',
  projectType: 'article',
  useEnginePipeline: false,
  cslAvailable: false,
};

/** Valeur du `-V clef=…` (ou `-V clef:…`) recherché, sinon undefined. */
function variable(args: string[], key: string): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== '-V') continue;
    const [name, ...rest] = args[i + 1].split(/[=:]/);
    if (name === key) return rest.join('=');
  }
  return undefined;
}

function meta(args: string[], key: string): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== '-M') continue;
    const value = args[i + 1];
    if (value.startsWith(`${key}=`)) return value.slice(key.length + 1);
  }
  return undefined;
}

const book = (over: Partial<BookSettings> = {}): BookSettings =>
  resolveBookSettings(over as BookSettings);

describe('escapeLatex', () => {
  it('échappe ce que LaTeX interpréterait dans un titre', () => {
    expect(escapeLatex('Danzig & Co #1')).toBe('Danzig \\& Co \\#1');
    expect(escapeLatex('100 % _sûr_')).toBe('100 \\% \\_sûr\\_');
    expect(escapeLatex('a\\b')).toBe('a\\textbackslash{}b');
    expect(escapeLatex('~x^2')).toBe('\\textasciitilde{}x\\textasciicircum{}2');
  });

  it('laisse un titre ordinaire intact', () => {
    expect(escapeLatex('La Ville libre de Dantzig')).toBe(
      'La Ville libre de Dantzig'
    );
  });
});

describe('computeSecnumdepth', () => {
  it('numérote les chapitres seuls par défaut', () => {
    expect(computeSecnumdepth(book())).toBe(0);
  });

  it('numérote aussi les sections quand demandé', () => {
    expect(computeSecnumdepth(book({ numberSections: true }))).toBe(1);
  });

  it('ne numérote rien quand les chapitres sont désactivés', () => {
    expect(computeSecnumdepth(book({ numberChapters: false }))).toBe(-1);
  });

  it('les sections numérotées priment sur des chapitres désactivés', () => {
    expect(
      computeSecnumdepth(book({ numberChapters: false, numberSections: true }))
    ).toBe(1);
  });
});

describe('resolveBibliographyMode', () => {
  it('accorde la bibliographie par chapitre quand tout est réuni', () => {
    const r = resolveBibliographyMode({
      settings: book({ bibliography: 'per-chapter' }),
      bibliographyAvailable: true,
      useEngine: false,
    });
    expect(r.perChapter).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it('replie sur une bibliographie unique sans fichier .bib, en prévenant', () => {
    const r = resolveBibliographyMode({
      settings: book({ bibliography: 'per-chapter' }),
      bibliographyAvailable: false,
      useEngine: false,
    });
    expect(r.perChapter).toBe(false);
    expect(r.warning).toContain('repli');
  });

  it('replie aussi quand le pipeline CitationEngine est actif', () => {
    // Citeproc n'aurait plus de `[@clef]` à résoudre : il n'ajouterait
    // qu'une bibliographie vide en fin d'ouvrage.
    const r = resolveBibliographyMode({
      settings: book({ bibliography: 'per-chapter' }),
      bibliographyAvailable: true,
      useEngine: true,
    });
    expect(r.perChapter).toBe(false);
    expect(r.warning).toBeDefined();
  });

  it('ne prévient pas quand la bibliographie unique est demandée', () => {
    const r = resolveBibliographyMode({
      settings: book({ bibliography: 'single' }),
      bibliographyAvailable: false,
      useEngine: false,
    });
    expect(r).toEqual({ perChapter: false });
  });
});

describe('buildPandocArgs — socle commun', () => {
  it('porte entrée, sortie et moteur PDF', () => {
    const args = buildPandocArgs(BASE);
    expect(args[0]).toBe('/tmp/w/input.md');
    expect(args.slice(1, 3)).toEqual(['-o', '/out/livre.pdf']);
    expect(args).toContain('--pdf-engine=xelatex');
    expect(args).toContain('--from=markdown+autolink_bare_uris');
  });
});

describe('buildPandocArgs — article vs livre', () => {
  it('un article utilise le template maison sans division en chapitres', () => {
    const args = buildPandocArgs({ ...BASE, projectType: 'article' });
    expect(args).toContain('--template');
    expect(args).toContain('--toc');
    expect(args).not.toContain('--top-level-division=chapter');
    expect(variable(args, 'secnumdepth')).toBeUndefined();
  });

  it('un livre émet de vrais chapitres', () => {
    // Sans cette option pandoc rendait un `#` en \section : aucun \chapter,
    // table des matières réduite aux sections, en-têtes recto/verso vides.
    const args = buildPandocArgs({
      ...BASE,
      projectType: 'book',
      bookSettings: book(),
    });
    expect(args).toContain('--top-level-division=chapter');
    expect(variable(args, 'secnumdepth')).toBe('0');
  });

  it('une présentation passe en beamer natif, sans template maison', () => {
    const args = buildPandocArgs({ ...BASE, projectType: 'presentation' });
    expect(args).toContain('--to=beamer');
    expect(args).toContain('--slide-level=1');
    expect(args).not.toContain('--template');
  });
});

describe('buildPandocArgs — numérotation des titres', () => {
  it.each([
    ['défaut (chapitres seuls)', {}, '0'],
    ['chapitres et sections', { numberSections: true }, '1'],
    ['rien de numéroté', { numberChapters: false }, '-1'],
  ])('%s', (_label, over, expected) => {
    const args = buildPandocArgs({
      ...BASE,
      projectType: 'book',
      bookSettings: book(over as Partial<BookSettings>),
    });
    expect(variable(args, 'secnumdepth')).toBe(expected);
  });
});

describe('buildPandocArgs — les trois styles de notes × les deux numérotations', () => {
  const styles = ['footnote', 'endnote-chapter', 'endnote-book'] as const;
  const numberings = ['continuous', 'per-chapter'] as const;

  for (const noteStyle of styles) {
    for (const noteNumbering of numberings) {
      it(`${noteStyle} / ${noteNumbering}`, () => {
        const args = buildPandocArgs({
          ...BASE,
          projectType: 'book',
          bookSettings: book({ noteStyle, noteNumbering }),
        });
        // Le template n'active l'appareil de notes de fin que pour les
        // deux styles concernés ; la numérotation, elle, est placée par
        // l'assembleur dans le markdown, pas par un argument pandoc.
        const expected = noteStyle === 'footnote' ? undefined : 'true';
        expect(variable(args, 'endnotes')).toBe(expected);
      });
    }
  }

  it("un article n'active jamais les notes de fin, même mal configuré", () => {
    const args = buildPandocArgs({
      ...BASE,
      projectType: 'article',
      bookSettings: book({ noteStyle: 'endnote-book' }),
    });
    expect(variable(args, 'endnotes')).toBeUndefined();
  });
});

describe('buildPandocArgs — métadonnées et résumé', () => {
  it('échappe titre et auteur, laisse la date brute', () => {
    const args = buildPandocArgs({
      ...BASE,
      metadata: { title: 'Danzig & Co #1', author: 'F. Clavert', date: '2026-07-19' },
    });
    expect(meta(args, 'title')).toBe('Danzig \\& Co \\#1');
    expect(meta(args, 'author')).toBe('F. Clavert');
    expect(meta(args, 'date')).toBe('2026-07-19');
  });

  it('passe le résumé quand il existe', () => {
    const args = buildPandocArgs({ ...BASE, abstract: 'Quatrième de couverture.' });
    expect(meta(args, 'abstract')).toBe('Quatrième de couverture.');
  });

  it("n'invente pas de résumé quand il n'y en a pas", () => {
    expect(meta(buildPandocArgs(BASE), 'abstract')).toBeUndefined();
  });
});

describe('buildPandocArgs — bibliographie', () => {
  it('branche citeproc sur la bibliographie fournie', () => {
    const args = buildPandocArgs({ ...BASE, bibPath: '/tmp/w/bibliography.bib' });
    expect(args).toContain('--bibliography');
    expect(args).toContain('/tmp/w/bibliography.bib');
    expect(args).toContain('--citeproc');
  });

  it('utilise le style CSL quand le fichier existe', () => {
    const args = buildPandocArgs({
      ...BASE,
      bibPath: '/tmp/w/bibliography.bib',
      cslPath: '/styles/chicago.csl',
      cslAvailable: true,
    });
    expect(args).toContain('--csl');
    expect(args).toContain('/styles/chicago.csl');
  });

  it('retombe sur le style par défaut quand le CSL est introuvable', () => {
    const args = buildPandocArgs({
      ...BASE,
      bibPath: '/tmp/w/bibliography.bib',
      cslPath: '/styles/absent.csl',
      cslAvailable: false,
    });
    expect(args).not.toContain('--csl');
    expect(args).toContain('reference-section-title=Références');
  });

  it('se tait quand CitationEngine a déjà tout inséré', () => {
    // Les notes et la bibliographie sont déjà du markdown : une seconde
    // passe citeproc n'ajouterait qu'une bibliographie vide.
    const args = buildPandocArgs({
      ...BASE,
      bibPath: '/tmp/w/bibliography.bib',
      useEnginePipeline: true,
    });
    expect(args).not.toContain('--citeproc');
    expect(args).not.toContain('--bibliography');
  });

  it('ne branche rien sans fichier de bibliographie', () => {
    expect(buildPandocArgs(BASE)).not.toContain('--citeproc');
  });
});

describe('buildBeamerCustomizations', () => {
  it('masque le pied de page par défaut', () => {
    expect(buildBeamerCustomizations({})).toEqual([
      '\\setbeamertemplate{footline}{}',
    ]);
  });

  it('numérote les diapositives selon le style demandé', () => {
    expect(
      buildBeamerCustomizations({ showFrameNumber: true, frameNumberStyle: 'total' })
    ).toContain('\\setbeamertemplate{footline}[frame number]');
  });

  it('ajoute le plan avant chaque section, seulement si la TOC est active', () => {
    const avec = buildBeamerCustomizations({ tocBeforeSection: true, showToc: true });
    expect(avec.some((l) => l.includes('AtBeginSection'))).toBe(true);
    const sans = buildBeamerCustomizations({ tocBeforeSection: true, showToc: false });
    expect(sans.some((l) => l.includes('AtBeginSection'))).toBe(false);
  });

  it('le fichier d’en-têtes n’est référencé que s’il a été écrit', () => {
    const sans = buildPandocArgs({ ...BASE, projectType: 'presentation' });
    expect(sans).not.toContain('--include-in-header');
    const avec = buildPandocArgs({
      ...BASE,
      projectType: 'presentation',
      headerIncludesPath: '/tmp/w/beamer-custom.tex',
    });
    expect(avec).toContain('--include-in-header');
    expect(avec).toContain('/tmp/w/beamer-custom.tex');
  });
});
