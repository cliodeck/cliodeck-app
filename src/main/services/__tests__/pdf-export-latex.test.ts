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
 * Avant le correctif, le texte souligné (`\ul`), les formules alignées (`aligned`) et le code dans
 * une note (faute de `\VerbatimFootnotes`) échouaient de même.
 *
 * La présentation passe par le gabarit beamer de pandoc lui-même (`presentationArgs` ne donne pas
 * `--template`) : elle compilait déjà, le banc la garde. Le code dans une note n'y compile pas,
 * même avec `pandoc -t beamer` seul : limite de pandoc, écartée du banc pour elle.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pdfExportService } from '../pdf-export.js';
import type { ExportResult } from '../export-time-limit.js';
import { DEFAULT_BOOK_SETTINGS, type NoteStyle } from '../../../../backend/types/book.js';
import {
  pandocAvailable,
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
  /** `image` : chemin absolu de l'image. */
  markdown: (image: string) => string;
  /**
   * Du code dans une note. Ni le gabarit beamer de pandoc (`pandoc -t beamer` seul, 3.13 :
   * « Paragraph ended before \@makefntext was complete ») ni les notes de fin du livre (le paquet
   * endnotes recopie les notes dans un fichier : « Argument of \NormalTok has an extra } ») ne le
   * compilent, avant comme après J19 : il sort du banc pour eux.
   */
  verbatimInNote?: true;
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
    verbatimInNote: true,
  },
  {
    name: 'citations par citeproc',
    markdown: () => 'Selon @dupont2020, et aussi [@dupont2020, p. 12].\n',
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

const PROJECT_TYPES = ['article', 'book', 'presentation'] as const;
type ProjectType = (typeof PROJECT_TYPES)[number];

/** Ce qui peut compiler pour ce type de projet (voir `verbatimInNote`). */
function constructionsFor(projectType: ProjectType, noteStyle?: NoteStyle): readonly Construction[] {
  const endnotes = noteStyle === 'endnote-chapter' || noteStyle === 'endnote-book';
  return projectType === 'presentation' || endnotes
    ? CONSTRUCTIONS.filter((c) => !c.verbatimInNote)
    : CONSTRUCTIONS;
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

    /** Exporte le markdown comme l'app le fait pour ce type de projet ; le livre passe par l'assemblage. */
    async function exportAs(
      projectType: ProjectType,
      markdown: string,
      noteStyle: NoteStyle = DEFAULT_BOOK_SETTINGS.noteStyle
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
        mkdirSync(join(project, 'chapters'));
        writeFileSync(join(project, 'chapters', 'c1.md'), markdown);
        const result = await pdfExportService.exportToPDF({
          ...common,
          projectType,
          content: '',
          bookSettings: { ...DEFAULT_BOOK_SETTINGS, noteStyle },
          manuscript: {
            chapters: [{ id: 'c1', title: 'Chapitre', filePath: 'chapters/c1.md', order: 0 }],
          },
        });
        return { result, outputPath };
      }

      const result = await pdfExportService.exportToPDF({ ...common, projectType, content: markdown });
      return { result, outputPath };
    }

    async function expectCompiles(
      projectType: ProjectType,
      markdown: string,
      noteStyle?: NoteStyle
    ): Promise<void> {
      const { result, outputPath } = await exportAs(projectType, markdown, noteStyle);

      expect(latexErrors(result)).toEqual([]);
      expect(result, result.error).toMatchObject({ success: true });
      expect(readFileSync(outputPath).subarray(0, 5).toString('latin1')).toBe('%PDF-');
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

    /** Les notes de fin passent par une autre branche du gabarit du livre (`$if(endnotes)$`). */
    it.each(['endnote-chapter', 'endnote-book'] as const)(
      'livre à notes de fin (%s) : toutes ensemble',
      async (noteStyle) => {
        await expectCompiles('book', documentOf(constructionsFor('book', noteStyle), image), noteStyle);
      },
      COMPILE_MS
    );
  }
);
