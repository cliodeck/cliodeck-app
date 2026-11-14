/**
 * Couche pandoc/LaTeX — tests des fonctions pures (item 24 de l'audit).
 *
 * Cette logique n'était vérifiable qu'en produisant des PDF à la main, alors
 * qu'elle porte l'assemblage des chapitres, les trois styles de notes, la
 * numérotation et la bibliographie par chapitre. Les combinaisons ci-dessous
 * sont celles qui changent réellement le document produit.
 */
import { describe, expect, it } from 'vitest';
import { delimiter, join } from 'path';
import type { BookSettings } from '../../../../backend/types/book.js';
import {
  buildBeamerCustomizations,
  buildPandocArgs,
  computeSecnumdepth,
  missingImagesWarnings,
  pandocImageFailure,
  pandocMissingResources,
  projectResourcePaths,
  resolveBibliographyMode,
  resolveBookSettings,
  stagedBeamerImageName,
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

/**
 * L07-2 : pandoc tourne dans le dossier temporaire de l'export. Sans `--resource-path`, une image
 * relative au projet (`images/plan.png`), que l'éditeur affiche, n'était pas trouvée : remplacée
 * par sa légende, et l'export se disait réussi.
 */
describe('buildPandocArgs — dossiers des images', () => {
  const dirs = ['/Users/h/Mon projet', '/Users/h/Mon projet/chapters'];

  it.each(['article', 'book', 'presentation'] as const)(
    '%s : --resource-path joint les dossiers par path.delimiter, en un seul argument',
    (projectType) => {
      const args = buildPandocArgs({ ...BASE, projectType, resourcePaths: dirs });
      expect(args).toContain(`--resource-path=${dirs.join(delimiter)}`);
    }
  );

  it('sans dossier donné, aucun --resource-path', () => {
    expect(buildPandocArgs(BASE).some((a) => a.startsWith('--resource-path'))).toBe(false);
  });

  /**
   * L'éditeur résout une image relative au fichier ouvert. Un chapitre qui écrit `images/x.png`
   * montre `chapters/images/x.png` : si le projet a aussi un `images/x.png`, chercher d'abord à
   * la racine remettait dans le livre une autre image que celle que l'auteur voit.
   */
  it('livre : chapters/ d’abord, puis la racine (où retombe le ../images/ d’un chapitre)', () => {
    expect(projectResourcePaths('/Users/h/Mon projet', 'book')).toEqual([
      join('/Users/h/Mon projet', 'chapters'),
      '/Users/h/Mon projet',
    ]);
  });

  it.each(['article', 'presentation'] as const)(
    '%s : la racine seule, où vit le document',
    (projectType) => {
      expect(projectResourcePaths('/Users/h/Mon projet', projectType)).toEqual(['/Users/h/Mon projet']);
    }
  );
});

/**
 * Le logo et l'image de titre d'une présentation : pandoc recopie la variable telle quelle dans
 * `\logo{\includegraphics{…}}`. Un chemin absolu y portait les barres obliques inverses de Windows
 * (« Undefined control sequence »), le `#` ou le `%` d'un nom de dossier (« Illegal parameter
 * number », « File ended while scanning »). L'export les copie dans son dossier de travail, où
 * xelatex tourne, sous un nom fixe : rien du chemin du projet n'atteint LaTeX.
 *
 * Le nom fixe est rangé dans un sous-dossier : pandoc extrait les images du document dans son
 * dossier `media-…`, que xelatex lit avant son dossier courant, et un `logo.png` du document y
 * remplaçait en silence le logo du réglage.
 */
describe('stagedBeamerImageName', () => {
  it.each([
    ['logo', 'C:\\Users\\Jean\\Documents\\Mon projet #2\\logo.png', 'cliodeck-beamer/logo.png'],
    ['logo', '/Users/h/Taux 100% & co/images/Logo final.PNG', 'cliodeck-beamer/logo.PNG'],
    ['titlegraphic', 'C:\\Users\\Jean\\Mon projet\\titre.jpeg', 'cliodeck-beamer/titlegraphic.jpeg'],
    ['titlegraphic', '/Users/h/Projet/images/couverture', 'cliodeck-beamer/titlegraphic'],
    ['logo', '/Users/h/Projet.v2/logo', 'cliodeck-beamer/logo'],
    ['logo', '/Users/h/Projet/logo.p#g', 'cliodeck-beamer/logo'],
  ] as const)('%s depuis %s : %s', (kind, source, expected) => {
    expect(stagedBeamerImageName(kind, source)).toBe(expected);
  });
});

/** Ce que pandoc écrit sur sa sortie d'erreur, relevé sur pandoc 3.13 (L07-2). */
describe('avertissements de pandoc sur les images', () => {
  it('relève chaque ressource introuvable, une seule fois', () => {
    const stderr = [
      '[WARNING] Could not fetch resource images/plan.png: replacing image with description',
      '[WARNING] Could not fetch resource chapters/images/carte été.png: replacing image with description',
      '[WARNING] Could not fetch resource images/plan.png: replacing image with description',
      '[WARNING] Citeproc: citation inconnu2020 not found',
    ].join('\n');
    expect(pandocMissingResources(stderr)).toEqual([
      'images/plan.png',
      'chapters/images/carte été.png',
    ]);
    expect(pandocMissingResources('')).toEqual([]);
  });

  /**
   * Pandoc écrit l'espace d'un nom de fichier en `%20` (relevé sur pandoc 3.13, `![X](<images/mon
   * image.png>)`) : l'auteur ne retrouverait pas ce nom dans le Finder. Un `%` que ne suivent pas
   * deux chiffres hexadécimaux est laissé tel quel, comme pandoc le laisse.
   */
  it('rend le nom du fichier tel qu’il est sur le disque, sans %20', () => {
    const stderr = [
      '[WARNING] Could not fetch resource images/mon%20image.png: replacing image with description',
      '[WARNING] Could not fetch resource images/autre%20image%20%C3%A9t%C3%A9.png: replacing image with description',
      '[WARNING] Could not fetch resource images/100%.png: replacing image with description',
      '[WARNING] Could not fetch resource images/taux%2050%.png: replacing image with description',
    ].join('\n');
    expect(pandocMissingResources(stderr)).toEqual([
      'images/mon image.png',
      'images/autre image été.png',
      'images/100%.png',
      'images/taux 50%.png',
    ]);
  });

  it('une seule réserve pour toutes les images introuvables, avec leur nombre', () => {
    expect(missingImagesWarnings(['images/a.png', 'images/b.png'])).toEqual([
      { code: 'export.imagesNotFound', params: { files: 'images/a.png, images/b.png', count: 2 } },
    ]);
    expect(missingImagesWarnings([])).toEqual([]);
  });

  it('une image SVG sans rsvg-convert : le code le dit, avec le chemin de l’image dans le projet', () => {
    const stderr =
      '[WARNING] Could not convert image /var/folders/x/T/cliodeck-export-1/media-5db82535f1365f20/images/schema.svg: check that rsvg-convert is in path.\n' +
      '  rsvg-convert: createProcess: posix_spawnp: does not exist (No such file or directory)\n' +
      'Error producing PDF.\n' +
      "! Package svg Error: File `schema_svg-tex.pdf' is missing.\n";
    expect(pandocImageFailure(stderr)).toEqual({
      code: 'export.imageNeedsRsvgConvert',
      params: { file: 'images/schema.svg' },
    });
  });

  it('une image d’un format que pandoc ne convertit pas (WebP)', () => {
    const stderr =
      '[WARNING] Could not convert image /tmp/w/media-a47481f6018129fa/images/photo.webp: Cannot load file\n' +
      '  Jpeg Invalid marker used\n' +
      'Error producing PDF.\n' +
      '! LaTeX Error: Cannot determine size of graphic in /tmp/w/media-a47481f6018129fa/images/photo.webp (no BoundingBox).\n';
    expect(pandocImageFailure(stderr)).toEqual({
      code: 'export.imageNotConverted',
      params: { file: 'images/photo.webp' },
    });
  });

  it('un autre échec n’est pas mis sur le compte d’une image', () => {
    expect(pandocImageFailure('! LaTeX Error: Environment longtable undefined.')).toBeNull();
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
  it('passe les métadonnées EN CLAIR — pandoc échappe lui-même', () => {
    const args = buildPandocArgs({
      ...BASE,
      metadata: { title: 'Danzig & Co #1', author: 'F. Clavert', date: '2026-07-19' },
    });
    // Échapper ici produisait `Danzig \textbackslash& Co \textbackslash#1`
    // sur la page de titre : pandoc ré-échappe la MetaString au rendu du
    // gabarit LaTeX. Vérifié avec pandoc 3.8.
    expect(meta(args, 'title')).toBe('Danzig & Co #1');
    expect(meta(args, 'author')).toBe('F. Clavert');
    expect(meta(args, 'date')).toBe('2026-07-19');
  });

  it('laisse le résumé intact, esperluettes comprises', () => {
    const args = buildPandocArgs({
      ...BASE,
      abstract: 'Sur Dupont & Fils, 100 % des cas.',
    });
    expect(meta(args, 'abstract')).toBe('Sur Dupont & Fils, 100 % des cas.');
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
