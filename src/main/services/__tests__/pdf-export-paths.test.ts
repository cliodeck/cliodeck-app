/**
 * Les exports pandoc résolvent leurs chemins contre le projet (L07-2).
 *
 * Pandoc tourne dans le dossier temporaire de l'export (`cwd`), où rien du projet ne se trouve :
 *  - une image relative (`images/plan.png`), que l'éditeur affiche, était remplacée par sa
 *    légende, et l'export se disait réussi, PDF comme Word (S12-1-1) ;
 *  - le logo d'une présentation (« Logo (chemin relatif) » : `logo.png`) faisait échouer
 *    l'export beamer (S12-1-24). Il est copié dans le dossier de travail sous un nom fixe : un
 *    chemin absolu atteignait LaTeX tel quel, et un `#` ou un `%` du dossier du projet (les
 *    barres obliques inverses de Windows aussi) le faisait encore échouer ;
 *  - un chemin de sortie relatif (`article.pdf`) était écrit dans le dossier temporaire, effacé
 *    avec lui : export « réussi », fichier introuvable (S12-1-28).
 * Et la sortie de pandoc était décodée morceau par morceau : un « é » coupé entre deux morceaux
 * devenait « �� » dans le chapitre résolu par citeproc (S12-2-0).
 *
 * Deux bancs. Le premier simule pandoc (`ExportClock.spawn`) et regarde ce que l'export lui donne
 * (arguments, `input.md`, dossier de travail) et ce qu'il fait de sa sortie : il tourne partout,
 * CI comprise, sauf sa partie Word, qui cherche pandoc par `which` avant de le lancer. Le second lance les vrais pandoc et xelatex sur un projet dont le chemin
 * contient une espace, et juge le fichier produit : images du PDF (`pdfimages`, du même Poppler
 * que `pdftotext`, d'où sa garde), `word/media` du .docx. Sans les outils, il est sauté.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join, resolve } from 'path';
import PizZip from 'pizzip';
import { pdfExportService } from '../pdf-export.js';
import { wordExportService } from '../word-export.js';
import { ExportClock, type ExportResult } from '../export-time-limit.js';
import { DEFAULT_BOOK_SETTINGS, type BookSettings } from '../../../../backend/types/book.js';
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

/** Une image PNG de 3 × 2 pixels : `pdfimages -list` la distingue de la précédente. */
const PNG_3X2 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAD0lEQVR4nGNgaPgPRXAWAFPeCPtx0iu3AAAAAElFTkSuQmCC',
  'base64'
);

/** Une image WebP d'un pixel : un format que xelatex ne lit pas, ni pandoc pour le convertir. */
const PIXEL_WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';

const BIBLIOGRAPHY = `@book{dupont2020,
  author = {Dupont, Jean},
  title = {Une histoire des archives},
  year = {2020},
  publisher = {Éditions du banc},
  address = {Paris}
}
`;

const METADATA = { title: 'Banc des chemins', author: 'Autrice', date: '13/11/2026' };

/**
 * Un nom de projet qui contient le séparateur des listes de chemins (`:` sous macOS et Linux, `;`
 * sous Windows). Pandoc découpe `--resource-path` sur lui : « Les archives : une histoire » y
 * devenait deux dossiers inexistants, et les images du projet disparaissaient de l'export. La
 * création d'un projet n'interdit que `/` et `\`, et un titre français porte souvent « : ».
 */
const DELIMITER_PROJECT = `Les archives ${delimiter} une histoire`;

let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cliodeck-chemins-'));
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Un projet neuf, dont le chemin contient une espace (par défaut), avec ses images. */
function newProject(name = 'Mon projet'): string {
  const project = join(mkdtempSync(join(root, 'p-')), name);
  mkdirSync(join(project, 'images'), { recursive: true });
  mkdirSync(join(project, 'chapters', 'images'), { recursive: true });
  writeFileSync(join(project, 'images', 'plan.png'), PIXEL_PNG);
  writeFileSync(join(project, 'chapters', 'images', 'carte.png'), PIXEL_PNG);
  writeFileSync(join(project, 'logo.png'), PIXEL_PNG);
  writeFileSync(join(project, 'references.bib'), BIBLIOGRAPHY);
  return project;
}

function bookOptions(project: string, chapters: string[], book: Partial<BookSettings> = {}) {
  chapters.forEach((text, i) => writeFileSync(join(project, 'chapters', `c${i + 1}.md`), text));
  return {
    projectPath: project,
    projectType: 'book' as const,
    content: '',
    bookSettings: { ...DEFAULT_BOOK_SETTINGS, ...book },
    manuscript: {
      chapters: chapters.map((_, i) => ({
        id: `c${i + 1}`,
        title: `Chapitre ${i + 1}`,
        filePath: `chapters/c${i + 1}.md`,
        order: i,
      })),
    },
    metadata: METADATA,
  };
}

// MARK: - Pandoc simulé

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

interface PandocCall {
  args: string[];
  cwd: string;
  /** Le fichier d'entrée (premier argument), lu au lancement : le dossier part ensuite. */
  input: string;
  /**
   * Les dossiers que pandoc lira dans `--resource-path`, découpés comme il les découpe (sur
   * `path.delimiter`), résolus depuis son dossier de travail au lancement. Un dossier qui
   * n'existe pas y est marqué `absent:`.
   */
  resources: string[];
  child: FakeChild;
}

function resourceDirs(args: string[], cwd: string): string[] {
  const arg = args.find((a) => a.startsWith('--resource-path='));
  if (!arg) return [];
  return arg
    .slice('--resource-path='.length)
    .split(delimiter)
    .map((dir) => {
      try {
        return realpathSync(resolve(cwd, dir));
      } catch {
        return `absent:${dir}`;
      }
    });
}

/** Ce que rend pandoc : des morceaux tels quels (un caractère peut y être coupé), puis son code. */
function answer(child: FakeChild, out: { stdout?: Buffer[]; stderr?: Buffer[]; code?: number } = {}): void {
  for (const chunk of out.stdout ?? []) child.stdout.emit('data', chunk);
  for (const chunk of out.stderr ?? []) child.stderr.emit('data', chunk);
  child.emit('close', out.code ?? 0);
}

/** Remplace pandoc par `script`, qui répond à chaque lancement. Les dépendances sont « là ». */
function simulatePandoc(script: (call: PandocCall, calls: PandocCall[]) => void | Promise<void>): PandocCall[] {
  const calls: PandocCall[] = [];
  vi.spyOn(pdfExportService, 'checkDependencies').mockResolvedValue({ pandoc: true, xelatex: true });
  vi.spyOn(ExportClock.prototype, 'spawn').mockImplementation((_command, args, options) => {
    const child: FakeChild = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    const cwd = String(options.cwd);
    const call: PandocCall = {
      args,
      cwd,
      input: readFileSync(args[0], 'utf8'),
      resources: resourceDirs(args, cwd),
      child,
    };
    calls.push(call);
    setImmediate(() => void script(call, calls));
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  return calls;
}

const isFinalPdfCall = (call: PandocCall) => call.args.includes('--pdf-engine=xelatex');

/** Coupe `text` entre les deux octets de la première occurrence de `char` (UTF-8). */
function cutInside(text: string, char: string): Buffer[] {
  const bytes = Buffer.from(text, 'utf8');
  const at = bytes.indexOf(Buffer.from(char, 'utf8')) + 1;
  return [bytes.subarray(0, at), bytes.subarray(at)];
}

describe('export PDF, pandoc simulé', () => {
  it('bibliographie par chapitre : un « é » coupé entre deux morceaux de la sortie de citeproc reste « é »', async () => {
    const project = newProject();
    const resolved = '# Premier\n\nLe français, à l’été (Dupont 2020).\n';
    const calls = simulatePandoc((call) => {
      if (call.args.includes('--citeproc') && call.args.includes('markdown')) {
        answer(call.child, { stdout: cutInside(resolved, 'é') });
      } else {
        answer(call.child);
      }
    });

    const result = await pdfExportService.exportToPDF({
      ...bookOptions(project, ['# Premier\n\nLe français, à l’été [@dupont2020].\n'], {
        bibliography: 'per-chapter',
      }),
      bibliographyPath: join(project, 'references.bib'),
      outputPath: join(project, 'livre.pdf'),
    });

    expect(result, result.error).toMatchObject({ success: true });
    const final = calls.find(isFinalPdfCall);
    expect(final?.input).toContain('Le français, à l’été (Dupont 2020).');
    expect(final?.input).not.toContain('�');
  });

  it('une image introuvable se dit, même quand pandoc coupe son nom accentué entre deux morceaux', async () => {
    const project = newProject();
    simulatePandoc((call) =>
      answer(call.child, {
        stderr: cutInside(
          '[WARNING] Could not fetch resource images/carte-été.png: replacing image with description\n',
          'é'
        ),
      })
    );

    const result = await pdfExportService.exportToPDF({
      projectPath: project,
      projectType: 'article',
      content: '![Carte](images/carte-été.png)\n',
      outputPath: join(project, 'article.pdf'),
      metadata: METADATA,
    });

    expect(result).toMatchObject({
      success: true,
      warnings: [{ code: 'export.imagesNotFound', params: { files: 'images/carte-été.png', count: 1 } }],
    });
  });

  it('pandoc reçoit le dossier du projet et un chemin de sortie résolu contre lui ; logo et image de titre sont copiés dans son dossier de travail', async () => {
    const project = newProject();
    writeFileSync(join(project, 'images', 'titre.jpg'), PNG_3X2);
    const staged = new Map<string, Buffer>();
    const calls = simulatePandoc((call) => {
      // Le dossier de travail part avec l'export : ce que xelatex y trouverait se lit au lancement.
      for (const name of ['cliodeck-beamer/logo.png', 'cliodeck-beamer/titlegraphic.jpg']) {
        const file = join(call.cwd, ...name.split('/'));
        if (existsSync(file)) staged.set(name, readFileSync(file));
      }
      answer(call.child);
    });

    const result = await pdfExportService.exportToPDF({
      projectPath: project,
      projectType: 'presentation',
      content: '# Diapo\n\nTexte\n',
      outputPath: 'diapos.pdf',
      beamerConfig: { logo: 'logo.png', titlegraphic: 'images/titre.jpg' },
      metadata: METADATA,
    });

    const args = calls.find(isFinalPdfCall)?.args ?? [];
    expect(args[args.indexOf('-o') + 1]).toBe(join(project, 'diapos.pdf'));
    expect(args).toContain(`--resource-path=${project}`);
    expect(args).toContain('logo:cliodeck-beamer/logo.png');
    expect(args).toContain('titlegraphic:cliodeck-beamer/titlegraphic.jpg');
    expect(staged.get('cliodeck-beamer/logo.png')).toEqual(PIXEL_PNG);
    expect(staged.get('cliodeck-beamer/titlegraphic.jpg')).toEqual(PNG_3X2);
    expect(result).toMatchObject({ success: true, outputPath: join(project, 'diapos.pdf') });
    expect(result.warnings).toBeUndefined();
  });

  it('un logo introuvable : la présentation est exportée sans lui, et l’export le dit', async () => {
    const project = newProject();
    const calls = simulatePandoc((call) => answer(call.child));

    const result = await pdfExportService.exportToPDF({
      projectPath: project,
      projectType: 'presentation',
      content: '# Diapo\n\nTexte\n',
      outputPath: join(project, 'diapos.pdf'),
      beamerConfig: { logo: 'images/logo absent.png' },
      metadata: METADATA,
    });

    const args = calls.find(isFinalPdfCall)?.args ?? [];
    expect(args.some((a) => a.startsWith('logo:'))).toBe(false);
    expect(result).toMatchObject({
      success: true,
      warnings: [{ code: 'export.beamerImageNotFound', params: { file: 'images/logo absent.png' } }],
    });
  });

  it('livre : pandoc cherche d’abord sous chapters/, comme l’éditeur pour un chapitre', async () => {
    const project = newProject();
    const calls = simulatePandoc((call) => answer(call.child));

    await pdfExportService.exportToPDF({
      ...bookOptions(project, ['# Premier\n\nTexte.\n']),
      outputPath: join(project, 'livre.pdf'),
    });

    expect(calls.find(isFinalPdfCall)?.args).toContain(
      `--resource-path=${[join(project, 'chapters'), project].join(delimiter)}`
    );
  });

  it.each(['article', 'book'] as const)(
    '%s : un projet dont le nom contient le séparateur de --resource-path, pandoc lit bien ses dossiers, et le nettoyage n’y touche pas',
    async (projectType) => {
      const project = newProject(DELIMITER_PROJECT);
      const calls = simulatePandoc((call) => answer(call.child));
      const options =
        projectType === 'book'
          ? bookOptions(project, ['# Premier\n\nTexte.\n'])
          : { projectPath: project, projectType, content: '# Un\n', metadata: METADATA };

      const result = await pdfExportService.exportToPDF({ ...options, outputPath: join(project, 'sortie.pdf') });

      expect(result, result.error).toMatchObject({ success: true });
      expect(result.warnings).toBeUndefined();
      const final = calls.find(isFinalPdfCall);
      const real = realpathSync(project);
      expect(final?.resources).toEqual(projectType === 'book' ? [join(real, 'chapters'), real] : [real]);
      // Le dossier de travail est parti, sans rien emporter du projet par ses liens.
      expect(existsSync(final?.cwd ?? '')).toBe(false);
      expect(readFileSync(join(project, 'images', 'plan.png'))).toEqual(PIXEL_PNG);
      expect(readFileSync(join(project, 'chapters', 'images', 'carte.png'))).toEqual(PIXEL_PNG);
    }
  );

  it('deux exports lancés dans la même milliseconde ont chacun leur dossier de travail', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_763_000_000_000);
    let release: () => void = () => undefined;
    const bothRunning = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = simulatePandoc(async (call, all) => {
      if (all.length === 2) release();
      await bothRunning;
      answer(call.child);
    });
    const project = newProject();
    const options = {
      projectPath: project,
      projectType: 'article' as const,
      metadata: METADATA,
    };

    const results = await Promise.all([
      pdfExportService.exportToPDF({ ...options, content: 'Un.\n', outputPath: join(project, 'un.pdf') }),
      pdfExportService.exportToPDF({ ...options, content: 'Deux.\n', outputPath: join(project, 'deux.pdf') }),
    ]);

    expect(results.map((r) => r.success)).toEqual([true, true]);
    expect(calls).toHaveLength(2);
    expect(calls[0].cwd).not.toBe(calls[1].cwd);
    expect(calls.map((c) => c.input.trim()).sort()).toEqual(['Deux.', 'Un.']);
  });
});

/**
 * Le chemin pandoc du Word ne se prend qu'avec une bibliographie, et seulement si `which pandoc`
 * le trouve : d'où la garde, bien que pandoc lui-même y soit simulé.
 */
describe.skipIf(!pandocAvailable())('export Word, pandoc simulé', () => {
  const wordOptions = (project: string, content: string, outputPath: string) => ({
    projectPath: project,
    projectType: 'article' as const,
    content,
    bibliographyPath: join(project, 'references.bib'),
    outputPath,
    metadata: METADATA,
  });

  it('une image introuvable se dit, même quand pandoc coupe son nom accentué entre deux morceaux', async () => {
    const project = newProject();
    const calls = simulatePandoc((call) =>
      answer(call.child, {
        stderr: cutInside(
          '[WARNING] Could not fetch resource images/carte-été.png: replacing image with description\n',
          'é'
        ),
      })
    );

    const result = await wordExportService.exportToWord(
      wordOptions(project, '![Carte](images/carte-été.png) [@dupont2020]\n', join(project, 'article.docx'))
    );

    expect(calls[0]?.args).toContain(`--resource-path=${project}`);
    expect(result).toMatchObject({
      success: true,
      warnings: [{ code: 'export.imagesNotFound', params: { files: 'images/carte-été.png', count: 1 } }],
    });
  });

  it('un projet dont le nom contient le séparateur de --resource-path : pandoc lit bien son dossier, et le nettoyage n’y touche pas', async () => {
    const project = newProject(DELIMITER_PROJECT);
    const calls = simulatePandoc((call) => answer(call.child));

    const result = await wordExportService.exportToWord(
      wordOptions(project, '![Plan](images/plan.png) [@dupont2020]\n', join(project, 'article.docx'))
    );

    expect(result, result.error).toMatchObject({ success: true });
    expect(calls[0]?.resources).toEqual([realpathSync(project)]);
    expect(existsSync(calls[0]?.cwd ?? '')).toBe(false);
    expect(readFileSync(join(project, 'images', 'plan.png'))).toEqual(PIXEL_PNG);
  });

  it('deux exports lancés dans la même milliseconde ont chacun leur dossier de travail', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_763_000_000_000);
    let release: () => void = () => undefined;
    const bothRunning = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = simulatePandoc(async (call, all) => {
      if (all.length === 2) release();
      await bothRunning;
      answer(call.child);
    });
    const project = newProject();

    const results = await Promise.all([
      wordExportService.exportToWord(wordOptions(project, 'Un [@dupont2020].\n', join(project, 'un.docx'))),
      wordExportService.exportToWord(wordOptions(project, 'Deux [@dupont2020].\n', join(project, 'deux.docx'))),
    ]);

    expect(results.map((r) => r.success)).toEqual([true, true]);
    expect(calls).toHaveLength(2);
    expect(calls[0].cwd).not.toBe(calls[1].cwd);
  });
});

// MARK: - Vrais pandoc et xelatex

/** Les images du PDF (`pdfimages -list`), sans leurs masques de transparence. */
function pdfImageCount(pdf: string): number {
  const list = execFileSync('pdfimages', ['-list', pdf], { encoding: 'utf8', env: toolEnv() });
  return list
    .split('\n')
    .slice(2)
    .filter((line) => line.trim().split(/\s+/)[2] === 'image').length;
}

/** Largeur et hauteur de chaque image du PDF (`pdfimages -list`), sans les masques. */
function pdfImageSizes(pdf: string): string[] {
  const list = execFileSync('pdfimages', ['-list', pdf], { encoding: 'utf8', env: toolEnv() });
  return list
    .split('\n')
    .slice(2)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols[2] === 'image')
    .map((cols) => `${cols[3]}x${cols[4]}`);
}

/** Les fichiers de `word/media` du .docx. */
function docxMedia(docx: string): string[] {
  return Object.keys(new PizZip(readFileSync(docx)).files).filter((name) => name.startsWith('word/media/'));
}

describe.skipIf(!pandocAvailable() || !xelatexAvailable())(
  'export PDF réel : les chemins se résolvent contre le projet (vrais pandoc et xelatex)',
  () => {
    it.skipIf(!pdftotextAvailable()).each(['Mon projet', DELIMITER_PROJECT])(
      'article : une image sous images/ entre dans le PDF (projet « %s »)',
      async (name) => {
        const project = newProject(name);
        const outputPath = join(project, 'article.pdf');

        const result = await pdfExportService.exportToPDF({
          projectPath: project,
          projectType: 'article',
          content: '# Un\n\n![Plan de la ville](images/plan.png)\n',
          outputPath,
          metadata: METADATA,
        });

        expect(result, result.error).toMatchObject({ success: true });
        expect(result.warnings).toBeUndefined();
        expect(pdfImageCount(outputPath)).toBe(1);
      },
      COMPILE_MS
    );

    it.skipIf(!pdftotextAvailable()).each(['Mon projet', DELIMITER_PROJECT])(
      'livre : une image sous chapters/images/ et une sous images/, chacune relative à son chapitre (projet « %s »)',
      async (name) => {
        const project = newProject(name);
        const outputPath = join(project, 'livre.pdf');

        const result = await pdfExportService.exportToPDF({
          ...bookOptions(project, [
            '# Premier\n\n![Carte du chapitre](images/carte.png)\n',
            '# Second\n\n![Plan du projet](../images/plan.png)\n',
          ]),
          outputPath,
        });

        expect(result, result.error).toMatchObject({ success: true });
        expect(result.warnings).toBeUndefined();
        expect(pdfImageCount(outputPath)).toBe(2);
      },
      COMPILE_MS
    );

    it.skipIf(!pdftotextAvailable())(
      'livre : deux images homonymes, celle du chapitre entre dans le PDF, comme l’éditeur la montre',
      async () => {
        const project = newProject();
        writeFileSync(join(project, 'images', 'x.png'), PNG_3X2);
        writeFileSync(join(project, 'chapters', 'images', 'x.png'), PIXEL_PNG);
        const outputPath = join(project, 'livre.pdf');

        const result = await pdfExportService.exportToPDF({
          ...bookOptions(project, ['# Premier\n\n![Carte](images/x.png)\n']),
          outputPath,
        });

        expect(result, result.error).toMatchObject({ success: true });
        expect(pdfImageSizes(outputPath)).toEqual(['1x1']);
      },
      COMPILE_MS
    );

    it(
      'chemin de sortie relatif « article.pdf » : le PDF est dans le projet',
      async () => {
        const project = newProject();

        const result = await pdfExportService.exportToPDF({
          projectPath: project,
          projectType: 'article',
          content: 'Un texte.\n',
          outputPath: 'article.pdf',
          metadata: METADATA,
        });

        expect(result, result.error).toMatchObject({ success: true, outputPath: join(project, 'article.pdf') });
        expect(readFileSync(join(project, 'article.pdf')).subarray(0, 5).toString('latin1')).toBe('%PDF-');
      },
      COMPILE_MS
    );

    /**
     * Le nom du dossier du projet n'atteint plus LaTeX : avant la copie, « Projet #2 » échouait
     * sur « Illegal parameter number », « Taux 100% » sur « File ended while scanning ».
     */
    it.skipIf(!pdftotextAvailable()).each(['Mon projet', 'Projet #2', 'Taux 100%', 'A & B'])(
      'présentation : Logo = « logo.png » (chemin relatif) donne un PDF, avec le logo (projet « %s »)',
      async (name) => {
        const project = newProject(name);
        const outputPath = join(project, 'diapos.pdf');

        const result = await pdfExportService.exportToPDF({
          projectPath: project,
          projectType: 'presentation',
          content: '# Diapo\n\nTexte\n',
          outputPath,
          beamerConfig: { logo: 'logo.png' },
          metadata: METADATA,
        });

        expect(result, result.error).toMatchObject({ success: true });
        expect(result.warnings).toBeUndefined();
        expect(pdfImageCount(outputPath)).toBeGreaterThanOrEqual(1);
      },
      COMPILE_MS
    );

    /**
     * Pandoc extrait les images du document dans son dossier `media-…`, que xelatex lit avant son
     * dossier courant : copié sous `logo.png`, le logo du réglage y était remplacé, sans un mot,
     * par une image du document qui porte ce nom (`![…](logo.png)`, à la racine du projet).
     */
    it.skipIf(!pdftotextAvailable()).each(['logo', 'titlegraphic'] as const)(
      'présentation : %s du réglage, pas l’image du document qui porte son nom',
      async (kind) => {
        const project = newProject();
        writeFileSync(join(project, `${kind}.png`), PIXEL_PNG);
        writeFileSync(join(project, 'images', 'marque.png'), PNG_3X2);
        const outputPath = join(project, 'diapos.pdf');

        const result = await pdfExportService.exportToPDF({
          projectPath: project,
          projectType: 'presentation',
          content: `# Diapo\n\n![Image du document](${kind}.png)\n`,
          outputPath,
          beamerConfig: { [kind]: 'images/marque.png' },
          metadata: METADATA,
        });

        expect(result, result.error).toMatchObject({ success: true });
        expect(result.warnings).toBeUndefined();
        const sizes = pdfImageSizes(outputPath);
        expect(sizes).toContain('3x2');
        expect(sizes).toContain('1x1');
      },
      COMPILE_MS
    );

    it(
      'présentation : un logo introuvable, le PDF est écrit sans lui, et l’export le dit',
      async () => {
        const project = newProject();
        const outputPath = join(project, 'diapos.pdf');

        const result = await pdfExportService.exportToPDF({
          projectPath: project,
          projectType: 'presentation',
          content: '# Diapo\n\nTexte\n',
          outputPath,
          beamerConfig: { logo: 'logo-absent.png' },
          metadata: METADATA,
        });

        expect(result, result.error).toMatchObject({
          success: true,
          warnings: [{ code: 'export.beamerImageNotFound', params: { file: 'logo-absent.png' } }],
        });
        expect(readFileSync(outputPath).subarray(0, 5).toString('latin1')).toBe('%PDF-');
      },
      COMPILE_MS
    );

    it(
      'image absente : le PDF est écrit, et l’export dit laquelle manque',
      async () => {
        const project = newProject();

        const result = await pdfExportService.exportToPDF({
          projectPath: project,
          projectType: 'article',
          content: '# Un\n\n![Absente](images/absente.png)\n\n![Sans elle](<images/mon image.png>)\n',
          outputPath: join(project, 'article.pdf'),
          metadata: METADATA,
        });

        // Pandoc écrit `images/mon%20image.png` : l'export dit le nom du fichier sur le disque.
        expect(result).toMatchObject({
          success: true,
          warnings: [
            {
              code: 'export.imagesNotFound',
              params: { files: 'images/absente.png, images/mon image.png', count: 2 },
            },
          ],
        });
      },
      COMPILE_MS
    );

    /**
     * Le risque de la fiche : une image jusqu'ici perdue en silence atteint xelatex. SVG sans
     * rsvg-convert, WebP : l'export échoue, et le dit par un code que la modale traduit. Avec
     * rsvg-convert installé, le SVG entre dans le PDF.
     */
    it.skipIf(!pdftotextAvailable()).each([
      ['SVG', 'schema.svg', SVG, 'export.imageNeedsRsvgConvert'],
      ['WebP', 'photo.webp', PIXEL_WEBP, 'export.imageNotConverted'],
    ] as const)(
      'image %s : dans le PDF, ou un échec qui nomme l’image et dit pourquoi',
      async (_kind, file, bytes, code) => {
        const project = newProject();
        writeFileSync(join(project, 'images', file), bytes);
        const outputPath = join(project, 'article.pdf');

        const result: ExportResult = await pdfExportService.exportToPDF({
          projectPath: project,
          projectType: 'article',
          content: `# Un\n\n![Figure](images/${file})\n`,
          outputPath,
          metadata: METADATA,
        });

        if (result.success) {
          expect(pdfImageCount(outputPath)).toBe(1);
        } else {
          expect(result).toMatchObject({ errorCode: code, errorParams: { file: `images/${file}` } });
        }
      },
      COMPILE_MS
    );
  }
);

describe.skipIf(!pandocAvailable())('export Word par pandoc : les chemins se résolvent contre le projet', () => {
  it.each(['Mon projet', DELIMITER_PROJECT])('une image relative entre dans le .docx (projet « %s »)', async (name) => {
    const project = newProject(name);
    const outputPath = join(project, 'article.docx');

    const result = await wordExportService.exportToWord({
      projectPath: project,
      projectType: 'article',
      content: '# Un\n\n![Plan de la ville](images/plan.png) [@dupont2020]\n',
      bibliographyPath: join(project, 'references.bib'),
      outputPath,
      metadata: METADATA,
    });

    expect(result, result.error).toMatchObject({ success: true });
    expect(result.warnings).toBeUndefined();
    expect(docxMedia(outputPath)).toHaveLength(1);
  });

  it('image absente : le .docx est écrit, et l’export dit laquelle manque', async () => {
    const project = newProject();

    const result = await wordExportService.exportToWord({
      projectPath: project,
      projectType: 'article',
      content: '# Un\n\n![Absente](images/absente.png) [@dupont2020]\n',
      bibliographyPath: join(project, 'references.bib'),
      outputPath: join(project, 'article.docx'),
      metadata: METADATA,
    });

    expect(result).toMatchObject({
      success: true,
      warnings: [{ code: 'export.imagesNotFound', params: { files: 'images/absente.png', count: 1 } }],
    });
  });

  it('chemin de sortie relatif « article.docx » : le document est dans le projet', async () => {
    const project = newProject();

    const result = await wordExportService.exportToWord({
      projectPath: project,
      projectType: 'article',
      content: 'Un texte [@dupont2020].\n',
      bibliographyPath: join(project, 'references.bib'),
      outputPath: 'article.docx',
      metadata: METADATA,
    });

    expect(result, result.error).toMatchObject({ success: true, outputPath: join(project, 'article.docx') });
    expect(existsSync(join(project, 'article.docx'))).toBe(true);
  });
});

describe('export Word natif (sans bibliographie) : chemin de sortie relatif', () => {
  // Avant L07-2, ce nom se résolvait contre le dossier courant du processus : le test l'y efface.
  const name = 'zz-L07-2-sortie-relative.docx';
  afterEach(() => rmSync(join(process.cwd(), name), { force: true }));

  it('le document est dans le projet', async () => {
    const project = newProject();

    const result = await wordExportService.exportToWord({
      projectPath: project,
      projectType: 'article',
      content: 'Un texte.\n',
      outputPath: name,
      metadata: METADATA,
    });

    expect(result, result.error).toMatchObject({ success: true, outputPath: join(project, name) });
    expect(existsSync(join(project, name))).toBe(true);
  });
});

/**
 * Résolu contre le projet, « document.md » saisi dans le champ « Fichier de sortie » désigne le
 * manuscrit : l'export le remplaçait par le PDF ou le .docx, sans copie, et se disait réussi. Un
 * chemin absolu le faisait déjà. Refusé avant tout lancement de pandoc.
 */
describe('le fichier de sortie n’est jamais un fichier Markdown', () => {
  const MANUSCRIPT = '# Article\n\nLe texte de l’autrice.\n';
  const articleTo = (project: string, outputPath: string) => ({
    projectPath: project,
    projectType: 'article' as const,
    content: MANUSCRIPT,
    outputPath,
    bibliographyPath: join(project, 'references.bib'),
    metadata: METADATA,
  });
  type ArticleOptions = ReturnType<typeof articleTo>;

  it.each([
    { name: 'PDF', run: (options: ArticleOptions) => pdfExportService.exportToPDF(options) },
    { name: 'Word', run: (options: ArticleOptions) => wordExportService.exportToWord(options) },
  ])('$name : document.md, nom nu ou chemin absolu, reste intact', async ({ run }) => {
    const project = newProject();
    writeFileSync(join(project, 'document.md'), MANUSCRIPT);
    const calls = simulatePandoc((call) => answer(call.child));

    for (const outputPath of ['document.md', join(project, 'document.md')]) {
      const result: ExportResult = await run(articleTo(project, outputPath));

      expect(result).toMatchObject({
        success: false,
        errorCode: 'export.outputIsMarkdown',
        errorParams: { file: 'document.md' },
      });
    }
    expect(calls).toEqual([]);
    expect(readFileSync(join(project, 'document.md'), 'utf8')).toBe(MANUSCRIPT);
  });
});
