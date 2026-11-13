/**
 * L'export PDF compile tout ce que pandoc écrit (J19).
 *
 * Les gabarits LaTeX de l'article et du livre sont écrits à la main : ils ne définissaient pas ce
 * que le gabarit par défaut de pandoc définit pour ce que pandoc écrit. Tout tableau échouait sur
 * « Environment longtable undefined » (puis « No counter 'none' defined »), toute image sur
 * « Undefined control sequence \pandocbounded », tout texte barré sur « \st ».
 *
 * Banc réel : vrai pandoc, vrai xelatex, par le vrai chemin d'export (gabarit écrit sur disque,
 * arguments de `pandoc-args.ts`, assemblage pour le livre). Un document par construction, pour
 * chacun des trois types de projet, puis toutes ensemble. Sans pandoc ou sans xelatex il est
 * sauté : la CI n'a ni l'un ni l'autre, il tourne sur le Mac de l'auteur.
 *
 * Avant le correctif, le texte souligné (`\ul`), les formules alignées (`aligned`), le code dans
 * une note (faute de `\VerbatimFootnotes`) et les citations liées (`link-citations: true`, qui
 * fait écrire `\citeproc`) échouaient de même.
 *
 * La présentation passe par le gabarit beamer de pandoc lui-même (`presentationArgs` ne donne pas
 * `--template`) : elle compilait déjà, le banc la garde. Ce qui ne compile pas sur un chemin, même
 * avec le gabarit de pandoc, en sort pour ce chemin (voir `failsIn`).
 *
 * Compiler ne suffit pas toujours : le texte du PDF (pdftotext, gardé par sa présence) montre où
 * vont les notes d'un tableau dans un livre à notes de fin, et ce que devient une citation liée.
 *
 * Restent hors du banc, car d'autres PR les traitent. Ils échouaient déjà avant J19 :
 * - une image en chemin relatif au projet (`images/carte.png`) : pandoc tourne dans le dossier
 *   temporaire de l'export, sans `--resource-path`, et remplace l'image par sa légende sans
 *   erreur. L'export se dit réussi, sans l'image. C'est L07-2 : le banc donne un chemin absolu ;
 * - une image SVG : pandoc la convertit par `rsvg-convert`, et sans lui écrit `\includesvg`, que le
 *   paquet svg ne compile qu'avec Inkscape (« Package svg Error: File `…_svg-tex.pdf' is
 *   missing »). Le risque est noté dans L07-2 ;
 * - un passage dans une autre langue (`[hello]{lang=en}`) : pandoc écrit `\foreignlanguage`, et
 *   le gabarit ne charge que le français (« The language english is not loaded »). C'est L12-6 ;
 * - un passage de droite à gauche (`[texte]{dir=rtl}`) : pandoc écrit `\RL`, qu'aucun gabarit ne
 *   définit sous xelatex, pas même celui de pandoc (il le laisse à babel ou à polyglossia, avec
 *   une langue écrite de droite à gauche). Langue et direction : L12-6.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { inflateSync } from 'zlib';
import { pdfExportService } from '../pdf-export.js';
import type { ExportResult } from '../export-time-limit.js';
import {
  DEFAULT_BOOK_SETTINGS,
  type BookSettings,
  type NoteNumbering,
  type NoteStyle,
} from '../../../../backend/types/book.js';
import {
  pandocAvailable,
  pdftotextAvailable,
  toolEnv,
  xelatexAvailable,
} from '../../../../backend/__tests__/helpers/native-guards.js';

/** Large : xelatex charge les polices du système à chaque compilation. */
const COMPILE_MS = 120_000;

/** Une image PNG d'un pixel. */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const BIBLIOGRAPHY = `@book{dupont2020,
  author = {Dupont, Jean},
  title = {Une histoire des archives},
  year = {2020},
  publisher = {Éditions du banc},
  address = {Paris}
}
`;

interface Construction {
  name: string;
  /** `image` : chemin absolu de l'image (un chemin relatif attend L07-2, voir plus haut). */
  markdown: (image: string) => string;
  /**
   * Les chemins où la construction ne compile pas, avant comme après J19 : elle sort du banc pour
   * eux. Mesuré avec pandoc 3.13 et xelatex (TeX Live 2026).
   * - `endnotes` (livre à notes de fin) : le paquet endnotes recopie les notes dans un fichier, et
   *   le code coloré n'y survit pas. Bloc : « Argument of \NormalTok has an extra } » ; en ligne :
   *   « Forbidden control sequence found while scanning use of \FancyVerbGetVerb ». Le code en
   *   ligne sans couleur passe.
   * - `presentation` : un bloc de code dans une note ne compile pas, même avec `pandoc -t beamer`
   *   seul (« Paragraph ended before \@makefntext was complete »).
   */
  failsIn?: readonly ('endnotes' | 'presentation')[];
}

/** Ce que l'historien écrit, une construction à la fois. */
const CONSTRUCTIONS: readonly Construction[] = [
  {
    name: 'tableau avec légende',
    markdown: () => '| Colonne A | Colonne B |\n|---|---|\n| un | deux |\n\n: Légende du tableau\n',
  },
  {
    name: 'tableau sans légende',
    markdown: () => '| Colonne A | Colonne B |\n|---|---|\n| un | deux |\n',
  },
  {
    name: 'note dans un tableau',
    markdown: () =>
      '| Colonne A | Colonne B |\n|---|---|\n| un | deux[^tableau] |\n\n[^tableau]: Une note dans le tableau.\n',
  },
  {
    name: 'image avec légende',
    markdown: (image) => `![Légende de l’image](${image})\n`,
  },
  {
    name: 'texte barré',
    markdown: () => 'Un mot ~~barré~~ dans la phrase.\n',
  },
  {
    name: 'texte souligné',
    markdown: () => 'Un mot [souligné]{.underline} dans la phrase.\n',
  },
  {
    name: 'liste de tâches',
    markdown: () => '- [ ] une tâche à faire\n- [x] une tâche faite\n',
  },
  {
    name: 'liste de définitions',
    markdown: () => 'Terme\n:   Sa définition.\n',
  },
  {
    name: 'bloc de lignes',
    markdown: () => '| Première ligne du vers\n| deuxième ligne du vers\n',
  },
  {
    name: 'code coloré',
    markdown: () => '```python\ndef f(x):\n    return x\n```\n',
  },
  {
    name: 'formule',
    markdown: () => 'En ligne $E = mc^2$, et posée :\n\n$$\\int_0^1 x\\,dx$$\n',
  },
  {
    name: 'formule alignée',
    markdown: () => '$$\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}$$\n',
  },
  {
    name: 'citation longue',
    markdown: () =>
      '> Une citation longue, en retrait, qui se prolonge assez pour former un bloc à part du texte.\n',
  },
  {
    name: 'note de bas de page',
    markdown: () => 'Un appel de note[^note].\n\n[^note]: La note de bas de page.\n',
  },
  {
    name: 'code dans une note',
    markdown: () =>
      'Un appel de note[^code].\n\n[^code]: Une note qui cite du code :\n\n    ```python\n    x = 1\n    ```\n',
    failsIn: ['endnotes', 'presentation'],
  },
  {
    name: 'code en ligne coloré dans une note',
    markdown: () => 'Un appel de note[^ligne].\n\n[^ligne]: Une note qui cite `x = 1`{.python}.\n',
    failsIn: ['endnotes'],
  },
  {
    name: 'citations par citeproc',
    markdown: () => 'Selon @dupont2020, et aussi [@dupont2020, p. 12].\n',
  },
  {
    // L'en-tête YAML que l'historien écrit en tête de son document (ou d'un chapitre). Pandoc
    // écrit alors `\citeproc{ref-dupont2020}{…}` : dans le texte et dans une note.
    name: 'citations liées (link-citations)',
    markdown: () =>
      '---\nlink-citations: true\n---\n\nSelon @dupont2020, et aussi [@dupont2020, p. 12][^liee].\n\n[^liee]: Voir @dupont2020.\n',
  },
];

/** Chaque construction sous son titre : une section, un chapitre ou une diapositive. */
function documentOf(constructions: readonly Construction[], image: string): string {
  return constructions.map((c) => `# ${c.name}\n\n${c.markdown(image)}`).join('\n');
}

/** Les lignes d'erreur LaTeX que pandoc rapporte : aucune quand l'export réussit. */
function latexErrors(result: ExportResult): string[] {
  return (result.error ?? '')
    .split('\n')
    .filter((line) => /LaTeX Error|Undefined control sequence|^! |^l\.\d+ /.test(line));
}

/** Le texte du PDF, par pdftotext. `-layout` : le numéro d'une note sur sa ligne, puis son texte. */
function pdfText(pdf: string): string {
  return execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8', env: toolEnv() });
}

/** Les destinations des liens internes du PDF (`/D(…)`), lues dans ses flux décompressés. */
function linkDestinations(pdf: string): string[] {
  const bytes = readFileSync(pdf);
  const raw = bytes.toString('latin1');
  const parts = [raw];
  for (const match of raw.matchAll(/stream\r?\n/g)) {
    const start = match.index + match[0].length;
    try {
      parts.push(inflateSync(bytes.subarray(start, raw.indexOf('endstream', start))).toString('latin1'));
    } catch {
      // Un flux qui n'est pas compressé par Flate (image, police) ne porte pas de lien.
    }
  }
  return [...parts.join('\n').matchAll(/\/D\s*\(([^)]*)\)/g)].map((m) => m[1]);
}

const PROJECT_TYPES = ['article', 'book', 'presentation'] as const;
type ProjectType = (typeof PROJECT_TYPES)[number];

/** Ce qui peut compiler pour ce type de projet (voir `failsIn`). */
function constructionsFor(projectType: ProjectType, noteStyle?: NoteStyle): readonly Construction[] {
  const endnotes = noteStyle === 'endnote-chapter' || noteStyle === 'endnote-book';
  return CONSTRUCTIONS.filter(
    (c) =>
      !(projectType === 'presentation' && c.failsIn?.includes('presentation')) &&
      !(endnotes && c.failsIn?.includes('endnotes'))
  );
}

describe.skipIf(!pandocAvailable() || !xelatexAvailable())(
  'export PDF : tout ce que pandoc écrit compile (vrais pandoc et xelatex)',
  () => {
    let root = '';
    let image = '';
    let bibliography = '';

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'cliodeck-latex-'));
      image = join(root, 'pixel.png');
      writeFileSync(image, PIXEL_PNG);
      bibliography = join(root, 'references.bib');
      writeFileSync(bibliography, BIBLIOGRAPHY);
    });

    afterAll(() => {
      if (root) rmSync(root, { recursive: true, force: true });
    });

    /**
     * Exporte le markdown comme l'app le fait pour ce type de projet. Le livre passe par
     * l'assemblage : un chapitre par texte donné.
     */
    async function exportAs(
      projectType: ProjectType,
      markdown: string | readonly string[],
      book: Partial<BookSettings> = {}
    ): Promise<{ result: ExportResult; outputPath: string }> {
      const project = mkdtempSync(join(root, `${projectType}-`));
      const outputPath = join(project, 'sortie.pdf');
      const common = {
        projectPath: project,
        outputPath,
        bibliographyPath: bibliography,
        metadata: { title: 'Banc de compilation', author: 'Autrice', date: '13/11/2026' },
      };

      if (projectType === 'book') {
        const texts = typeof markdown === 'string' ? [markdown] : markdown;
        mkdirSync(join(project, 'chapters'));
        texts.forEach((text, i) => writeFileSync(join(project, 'chapters', `c${i + 1}.md`), text));
        const result = await pdfExportService.exportToPDF({
          ...common,
          projectType,
          content: '',
          bookSettings: { ...DEFAULT_BOOK_SETTINGS, ...book },
          manuscript: {
            chapters: texts.map((_, i) => ({
              id: `c${i + 1}`,
              title: `Chapitre ${i + 1}`,
              filePath: `chapters/c${i + 1}.md`,
              order: i,
            })),
          },
        });
        return { result, outputPath };
      }

      const content = typeof markdown === 'string' ? markdown : markdown.join('\n');
      const result = await pdfExportService.exportToPDF({ ...common, projectType, content });
      return { result, outputPath };
    }

    /** Compile, et rend le chemin du PDF produit. */
    async function expectCompiles(
      projectType: ProjectType,
      markdown: string | readonly string[],
      book?: Partial<BookSettings>
    ): Promise<string> {
      const { result, outputPath } = await exportAs(projectType, markdown, book);

      expect(latexErrors(result)).toEqual([]);
      expect(result, result.error).toMatchObject({ success: true });
      expect(readFileSync(outputPath).subarray(0, 5).toString('latin1')).toBe('%PDF-');
      return outputPath;
    }

    describe.each(PROJECT_TYPES)('%s', (projectType) => {
      it.each(constructionsFor(projectType))(
        '$name',
        async (construction) => {
          await expectCompiles(projectType, documentOf([construction], image));
        },
        COMPILE_MS
      );

      it(
        'toutes ensemble, comme dans un vrai document',
        async () => {
          await expectCompiles(projectType, documentOf(constructionsFor(projectType), image));
        },
        COMPILE_MS
      );
    });

    /**
     * Avec `link-citations`, pandoc écrit `\citeproc{ref-cle}{texte}`, même pour une clé sans notice
     * (texte : « inconnu2020? »). Par `\cite`, cette clé-là devenait un simple « ? » : l'historien
     * voyait qu'une citation manque, sans savoir laquelle (revue J19). Une citation connue, elle,
     * reste un lien vers sa notice.
     */
    it.skipIf(!pdftotextAvailable())(
      'citations liées : une clé sans notice garde son nom, une citation connue reste un lien',
      async () => {
        const pdf = await expectCompiles(
          'article',
          '---\nlink-citations: true\n---\n\nSelon @inconnu2020 et @dupont2020.\n'
        );

        expect(pdfText(pdf)).toMatch(/Selon \(inconnu2020\s*\?\) et Dupont \(2020\)/);
        expect(linkDestinations(pdf)).toContain('cite.ref-dupont2020');
      },
      COMPILE_MS
    );

    /** Les notes de fin passent par une autre branche du gabarit du livre (`$if(endnotes)$`). */
    it.each(['endnote-chapter', 'endnote-book'] as const)(
      'livre à notes de fin (%s) : toutes ensemble',
      async (noteStyle) => {
        await expectCompiles('book', documentOf(constructionsFor('book', noteStyle), image), {
          noteStyle,
        });
      },
      COMPILE_MS
    );

    /**
     * Une note dans un tableau ou dans une légende, pandoc l'écrit en deux temps : `\footnotemark{}`
     * dans la cellule ou la légende, `\footnotetext{…}` après, avec des `\addtocounter{footnote}`
     * entre plusieurs. Le gabarit ne renvoyait que `\footnote` aux notes de fin : ces notes-là
     * sortaient en bas de page, avec leur propre compteur, et un même numéro servait à deux notes
     * (revue J19). Compiler ne suffit pas à le voir : le texte du PDF le montre.
     */
    describe.skipIf(!pdftotextAvailable())(
      'livre à notes de fin : les notes d’un tableau et d’une légende (texte du PDF)',
      () => {
        /** Chaque appel `APPELX` renvoie à la note `NOTEX` ; l'ordre est celui du texte. */
        const chapters = (): string[] => [
          '# Premier\n\nTexte APPELAVANT[^a] la table.\n\n' +
            '| Colonne A | Colonne B |\n|---|---|\n| APPELTABUN[^t1] | APPELTABDEUX[^t2] |\n\n' +
            ': Tableau annoté\n\n' +
            `![Légende APPELLEGENDE[^f]](${image})\n\n` +
            'Texte APPELAPRES[^b].\n\n' +
            '[^a]: NOTEAVANT.\n[^t1]: NOTETABUN.\n[^t2]: NOTETABDEUX.\n' +
            '[^f]: NOTELEGENDE.\n[^b]: NOTEAPRES.\n',
          '# Second\n\nTexte APPELSECONDA[^c] et APPELSECONDB[^d].\n\n' +
            '[^c]: NOTESECONDA.\n[^d]: NOTESECONDB.\n',
        ];
        const NOTES = ['AVANT', 'TABUN', 'TABDEUX', 'LEGENDE', 'APRES', 'SECONDA', 'SECONDB'];
        const CHAPTER_OF = [1, 1, 1, 1, 1, 2, 2];

        it.each([
          ['endnote-chapter', 'continuous', [1, 2, 3, 4, 5, 6, 7]],
          ['endnote-chapter', 'per-chapter', [1, 2, 3, 4, 5, 1, 2]],
          ['endnote-book', 'continuous', [1, 2, 3, 4, 5, 6, 7]],
        ] as const satisfies readonly (readonly [NoteStyle, NoteNumbering, readonly number[]])[])(
          '%s, %s : toutes aux notes de fin, dans l’ordre du texte, un numéro par note',
          async (noteStyle, noteNumbering, numbers) => {
            const pdf = await expectCompiles('book', chapters(), { noteStyle, noteNumbering });
            const text = pdfText(pdf);

            const calls = Object.fromEntries(
              [...text.matchAll(/APPEL([A-Z]+)\s*(\d+)/g)].map((m) => [m[1], Number(m[2])])
            );
            const notes = [...text.matchAll(/(\d+)\s*NOTE([A-Z]+)/g)].map((m) => [
              Number(m[1]),
              m[2],
            ]);

            expect(calls).toEqual(Object.fromEntries(NOTES.map((n, i) => [n, numbers[i]])));
            expect(notes).toEqual(NOTES.map((n, i) => [numbers[i], n]));
            // Une note de fin vient après le dernier appel de ce que vide `\theendnotes` : son
            // chapitre, ou tout l'ouvrage.
            NOTES.forEach((note, i) => {
              const last =
                noteStyle === 'endnote-book' || CHAPTER_OF[i] === 2 ? 'APPELSECONDB' : 'APPELAPRES';
              expect(text.indexOf(`NOTE${note}`), note).toBeGreaterThan(text.indexOf(last));
            });
          },
          COMPILE_MS
        );
      }
    );
  }
);
