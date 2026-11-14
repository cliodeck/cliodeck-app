/**
 * Chemin de sortie des trois exports de présentation, résolu contre le projet.
 *
 * Les exports PDF et Word le résolvent depuis L07-2 (S12-1-28) ; reveal.js écrivait un nom
 * nu (« diapos.html », saisi dans le champ de la fenêtre) contre le dossier courant du
 * processus, `/` pour l'app lancée du Finder : l'export échouait sur un dossier en lecture
 * seule, ou réussissait dans un dossier où l'auteur ne le cherchera jamais.
 *
 * Le dossier courant du test est un dossier temporaire à lui : un fichier qui s'y écrirait
 * ne tombe pas dans le dépôt.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const electron = vi.hoisted(() => ({ userData: '', opened: [] as string[] }));

vi.mock('electron', () => ({
  app: { getPath: () => electron.userData },
  shell: {
    openPath: async (path: string) => {
      electron.opened.push(path);
      return '';
    },
  },
  // Chromium n'imprime pas sous Vitest : seule l'écriture du fichier reçu est en jeu ici.
  BrowserWindow: class {
    webContents = { printToPDF: async () => Buffer.from('%PDF-1.4\n') };
    loadFile() {
      return Promise.resolve();
    }
    isDestroyed() {
      return false;
    }
    destroy() {}
    close() {}
  },
}));

const { revealJsExportService } = await import('../revealjs-export.js');

let root: string;
let project: string;
let elsewhere: string;
let cwdBefore: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cliodeck-reveal-paths-')));
  project = join(root, "Séminaire d'histoire");
  elsewhere = join(root, 'dossier-courant');
  mkdirSync(project);
  mkdirSync(elsewhere);
  electron.userData = join(root, 'userData');
  electron.opened = [];
  cwdBefore = process.cwd();
  process.chdir(elsewhere);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('/* asset */')));
});

afterEach(() => {
  process.chdir(cwdBefore);
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

const slides = (outputPath: string) => ({
  projectPath: project,
  content: '# Une diapositive\n\n---\n\n## Une autre\n',
  outputPath,
  metadata: { title: 'Séminaire' },
});

describe.each([
  { name: 'HTML', file: 'diapos.html', run: revealJsExportService.exportToRevealJs.bind(revealJsExportService) },
  { name: 'hors ligne', file: 'S&P hors ligne.html', run: revealJsExportService.exportOffline.bind(revealJsExportService) },
  { name: 'PDF', file: 'diapos.pdf', run: revealJsExportService.exportToPDF.bind(revealJsExportService) },
])('export $name', ({ file, run }) => {
  it(
    'un nom nu s’écrit dans le projet, pas dans le dossier courant du processus',
    async () => {
      const result = await run(slides(file));

      expect(result, result.error).toMatchObject({ success: true, outputPath: join(project, file) });
      expect(existsSync(join(project, file))).toBe(true);
      expect(existsSync(join(elsewhere, file))).toBe(false);
    },
    15_000
  );

  it(
    'un chemin relatif à un sous-dossier aussi',
    async () => {
      const result = await run(slides(join('exports', file)));

      expect(result, result.error).toMatchObject({ success: true, outputPath: join(project, 'exports', file) });
      expect(existsSync(join(project, 'exports', file))).toBe(true);
      expect(existsSync(join(elsewhere, 'exports'))).toBe(false);
    },
    15_000
  );

  it(
    'un chemin absolu reste tel quel',
    async () => {
      const target = join(root, 'ailleurs', file);

      const result = await run(slides(target));

      expect(result, result.error).toMatchObject({ success: true, outputPath: target });
      expect(readFileSync(target).length).toBeGreaterThan(0);
    },
    15_000
  );

  // Résolu contre le projet, « slides.md » saisi dans le champ désignait le manuscrit : l'export
  // le remplaçait par le HTML ou le PDF, sans copie. Un chemin absolu le faisait déjà.
  it.each([
    { output: 'slides.md', manuscript: 'slides.md' },
    { output: 'Slides.MD', manuscript: 'Slides.MD' },
    { output: 'chapters/01.markdown', manuscript: 'chapters/01.markdown' },
    { output: '', manuscript: 'document.md', absolute: true },
  ])(
    'un fichier Markdown ($manuscript) n’est jamais écrasé : refus, et le texte reste intact',
    async ({ output, manuscript, absolute }) => {
      const text = '# Mes diapositives\n\n---\n\n## La deuxième\n';
      mkdirSync(join(project, 'chapters'));
      writeFileSync(join(project, manuscript), text);

      const result = await run(slides(absolute ? join(project, manuscript) : output));

      expect(result).toMatchObject({
        success: false,
        errorCode: 'export.outputIsMarkdown',
        errorParams: { file: manuscript.split('/').pop() },
      });
      expect(readFileSync(join(project, manuscript), 'utf8')).toBe(text);
      expect(electron.opened).toEqual([]);
    },
    15_000
  );
});

it('le navigateur ouvre le fichier écrit dans le projet', async () => {
  await revealJsExportService.exportToRevealJs(slides('diapos.html'));

  expect(electron.opened).toEqual([join(project, 'diapos.html')]);
});
