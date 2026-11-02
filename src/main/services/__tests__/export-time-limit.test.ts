/**
 * Un export qui ne se termine jamais rend la main.
 *
 * #179 a retiré Échap pendant un export, car Échap faisait perdre le résultat
 * de tout export qui aboutit : un export bloqué n'avait plus d'autre sortie que
 * quitter l'app. Ces tests lancent de vrais processus (un faux pandoc en tête de
 * PATH, script sh qui attend un `sleep`) : on vérifie par leur pid qu'ils sont
 * morts, on ne le suppose pas.
 *
 * C'est le test qui fait échoir l'horloge, une fois l'outil lancé (`expireWhen`) :
 * une limite réelle courante courrait contre une machine chargée, et l'outil
 * pourrait ne pas avoir démarré quand elle tombe.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pandocAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';
import { DEFAULT_BOOK_SETTINGS } from '../../../../backend/types/book.js';

/** Fenêtre et réseau d'une présentation : ce que le test décide de faire pendre. */
const presentation = vi.hoisted(() => ({
  userData: '/tmp',
  windows: [] as Array<{ destroyed: boolean; closed: boolean }>,
  loadedFile: null as string | null,
  printing: false,
  loadFile: (): Promise<void> => Promise.resolve(),
  printToPDF: (): Promise<Buffer> => Promise.resolve(Buffer.from('%PDF-faux')),
  openPath: (): Promise<string> => Promise.resolve(''),
  openCalls: 0,
  /** Le `mkdir` de ce dossier se fait, puis reste en attente de la barrière. */
  heldDir: null as string | null,
  dirBarrier: Promise.resolve(),
  dirHeld: false,
}));

vi.mock('fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs/promises')>();
  const mkdir = async (...args: Parameters<typeof real.mkdir>) => {
    const made = await real.mkdir(...args);
    if (String(args[0]) === presentation.heldDir) {
      presentation.dirHeld = true;
      await presentation.dirBarrier;
    }
    return made;
  };
  return { ...real, mkdir };
});

vi.mock('electron', () => ({
  app: { getPath: () => presentation.userData, isPackaged: false },
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  shell: {
    openPath: () => {
      presentation.openCalls += 1;
      return presentation.openPath();
    },
  },
  BrowserWindow: class {
    destroyed = false;
    closed = false;
    webContents = {
      printToPDF: () => {
        presentation.printing = true;
        return presentation.printToPDF();
      },
    };
    constructor() {
      presentation.windows.push(this);
    }
    loadFile(file: string) {
      presentation.loadedFile = file;
      return presentation.loadFile();
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
    close() {
      // Comme Electron : une fenêtre détruite ne se ferme plus, elle lève.
      if (this.destroyed) throw new Error('Object has been destroyed');
      this.closed = true;
    }
  },
}));

const { pdfExportService } = await import('../pdf-export.js');
const { wordExportService } = await import('../word-export.js');
const { revealJsExportService } = await import('../revealjs-export.js');

/** Ceux qu'`extendedToolPath` remettrait devant le faux pandoc s'ils manquaient au PATH. */
const UNIX_TOOL_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/Library/TeX/texbin',
  '/usr/texbin',
  '/opt/local/bin',
];

const NEVER = () => new Promise<never>(() => undefined);

/** Jamais atteinte d'elle-même : `expireWhen` la fait échoir. */
const LIMIT = { timeLimitMs: 60_000 };

let root: string;
let bin: string;
let pids: string;
let scratch: string;
let project: string;
let bibliography: string;
let realPath: string | undefined;
let realTmpdir: string | undefined;

function tool(name: string, body: string): void {
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

/** Le corps d'un outil qui lance un enfant et l'attend, jusqu'à ce qu'on le tue. */
function hangs(name: string): string {
  return [
    `echo $$ > "${pids}/${name}.pid"`,
    'sleep 300 &',
    `echo $! > "${pids}/${name}-enfant.pid"`,
    'wait',
  ].join('\n');
}

function pidOf(name: string): number {
  return Number(readFileSync(join(pids, `${name}.pid`), 'utf8').trim());
}

function pidWritten(name: string): () => boolean {
  return () => {
    try {
      return pidOf(name) > 0;
    } catch {
      return false;
    }
  };
}

/** `ps` et non `kill(pid, 0)` : un zombie répond encore à ce dernier. */
function isAlive(pid: number): boolean {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return state !== '' && !state.startsWith('Z');
  } catch {
    return false; // `ps` sort en erreur quand le pid n'existe pas.
  }
}

function pdfOptions() {
  return {
    projectPath: project,
    projectType: 'article' as const,
    content: 'Un texte.',
    outputPath: join(project, 'sortie.pdf'),
    metadata: { title: 'Titre' },
  };
}

function wordOptions() {
  return {
    projectPath: project,
    projectType: 'article' as const,
    content: 'Un texte.',
    outputPath: join(project, 'sortie.docx'),
    bibliographyPath: bibliography,
  };
}

/** Un livre dont chaque chapitre passe par son citeproc (bibliographie par chapitre). */
function bookOptions(chapterCount: number) {
  mkdirSync(join(project, 'chapters'));
  const chapters = Array.from({ length: chapterCount }, (_, i) => {
    const filePath = `chapters/c${i}.md`;
    writeFileSync(join(project, filePath), `# Chapitre ${i}\n\nTexte [@clef].\n`);
    return { id: `c${i}`, title: `Chapitre ${i}`, filePath, order: i };
  });
  return {
    projectPath: project,
    projectType: 'book' as const,
    content: '',
    outputPath: join(project, 'sortie.pdf'),
    bibliographyPath: bibliography,
    metadata: { title: 'Titre' },
    bookSettings: { ...DEFAULT_BOOK_SETTINGS, bibliography: 'per-chapter' as const },
    manuscript: { chapters },
  };
}

/** Un pandoc qui distingue le citeproc d'un chapitre du passage principal, et les compte. */
function pandocForBook(citeproc: string, main = 'printf "%s" "%PDF-faux" > "$3"'): string {
  return [
    'case "$*" in',
    `  *"-t markdown"*) echo citeproc >> "${root}/appels"`,
    citeproc,
    '  ;;',
    `  *) echo principal >> "${root}/appels"`,
    `  cp "$1" "${root}/entree-principale.md"`,
    main,
    '  ;;',
    'esac',
  ].join('\n');
}

function calls(): string[] {
  const file = join(root, 'appels');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
}

/** Une lecture bloquée, faute d'écrivain : une attente qui n'est pas un outil. */
function blockedAbstract(): string {
  const fifo = join(project, 'abstract.md');
  execFileSync('mkfifo', [fifo]);
  return fifo;
}

async function waitUntil(condition: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition() && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Rend le fil bloqué sur la FIFO, sans quoi le processus de test ne saurait plus sortir. */
async function releaseFifo(fifo: string): Promise<void> {
  await waitUntil(() => {
    try {
      closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
      return true;
    } catch {
      return false; // Personne n'y lit encore.
    }
  }, 2000);
}

function useFakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
}

/** Fait échoir l'horloge de l'export, une fois `ready` vrai. */
async function expireWhen(ready: () => boolean): Promise<void> {
  await waitUntil(ready, 10_000);
  vi.advanceTimersByTime(LIMIT.timeLimitMs);
}

beforeEach(() => {
  realPath = process.env.PATH;
  realTmpdir = process.env.TMPDIR;
  root = mkdtempSync(join(tmpdir(), 'cliodeck-delai-'));
  bin = join(root, 'bin');
  pids = join(root, 'pids');
  scratch = join(root, 'systmp');
  project = join(root, 'projet');
  for (const dir of [bin, pids, scratch, project]) mkdirSync(dir);
  bibliography = join(project, 'biblio.bib');
  writeFileSync(bibliography, '@book{clef, title={Titre}, author={Nom, Prénom}, year={2000}}\n');
  process.env.PATH = [bin, ...UNIX_TOOL_DIRS, realPath ?? ''].join(':');
  // `tmpdir()` et les fichiers temporaires de pandoc passent par là : ce qu'un
  // export laisse derrière lui se voit dans ce seul dossier.
  process.env.TMPDIR = scratch;
  tool('xelatex', 'exit 0');
  presentation.userData = join(root, 'userData');
  presentation.windows = [];
  presentation.loadedFile = null;
  presentation.printing = false;
  presentation.loadFile = () => Promise.resolve();
  presentation.printToPDF = () => Promise.resolve(Buffer.from('%PDF-faux'));
  presentation.openPath = () => Promise.resolve('');
  presentation.openCalls = 0;
  presentation.heldDir = null;
  presentation.dirHeld = false;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // Un test rouge laisse ses processus derrière lui.
  for (const file of readdirSync(pids)) {
    try {
      process.kill(Number(readFileSync(join(pids, file), 'utf8').trim()), 'SIGKILL');
    } catch {
      // Déjà mort : le cas normal.
    }
  }
  process.env.PATH = realPath;
  if (realTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmpdir;
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('export PDF : un pandoc qui pend', () => {
  it(
    'rend export_timed_out, tue pandoc ET son enfant, supprime le dossier temporaire',
    async () => {
      tool('pandoc', hangs('pandoc'));
      useFakeClock();

      const exporting = pdfExportService.exportToPDF(pdfOptions(), undefined, LIMIT);
      await expireWhen(pidWritten('pandoc-enfant'));

      expect(await exporting).toMatchObject({ success: false, errorCode: 'export_timed_out' });
      expect(isAlive(pidOf('pandoc'))).toBe(false);
      expect(isAlive(pidOf('pandoc-enfant'))).toBe(false);
      expect(readdirSync(scratch)).toEqual([]);
    },
    20_000
  );

  it(
    'un pandoc qui ignore SIGTERM meurt quand même, par SIGKILL',
    async () => {
      tool('pandoc', `trap '' TERM\n${hangs('pandoc')}`);
      useFakeClock();

      const exporting = pdfExportService.exportToPDF(pdfOptions(), undefined, LIMIT);
      await expireWhen(pidWritten('pandoc-enfant'));
      const expiredAt = Date.now();

      expect(await exporting).toMatchObject({ success: false, errorCode: 'export_timed_out' });
      expect(isAlive(pidOf('pandoc'))).toBe(false);
      expect(isAlive(pidOf('pandoc-enfant'))).toBe(false);
      // Le SIGTERM n'a pas suffi : les 5 s de grâce sont passées avant le SIGKILL.
      expect(Date.now() - expiredAt).toBeGreaterThanOrEqual(4900);
      expect(readdirSync(scratch)).toEqual([]);
    },
    20_000
  );

  it(
    'le dossier temporaire ne part qu’après la mort de tout l’arbre',
    async () => {
      // pandoc meurt au SIGTERM, mais un descendant l'ignore et écrit encore
      // dans le dossier : supprimé trop tôt, ce dossier reviendrait.
      tool(
        'pandoc',
        [
          `(trap '' TERM; while :; do mkdir -p "$PWD"; echo x > "$PWD/encore-vivant"; sleep 0.05; done) >/dev/null 2>&1 &`,
          `echo $! > "${pids}/tenace.pid"`,
          'exec sleep 300',
        ].join('\n')
      );
      useFakeClock();

      const exporting = pdfExportService.exportToPDF(pdfOptions(), undefined, LIMIT);
      await expireWhen(pidWritten('tenace'));

      expect(await exporting).toMatchObject({ errorCode: 'export_timed_out' });
      expect(isAlive(pidOf('tenace'))).toBe(false);
      expect(readdirSync(scratch)).toEqual([]);
    },
    20_000
  );

  it(
    'un fichier de sortie déjà présent garde ses octets',
    async () => {
      tool('pandoc', hangs('pandoc'));
      const before = Buffer.from('%PDF-export-precedent');
      writeFileSync(pdfOptions().outputPath, before);
      useFakeClock();

      const exporting = pdfExportService.exportToPDF(pdfOptions(), undefined, LIMIT);
      await expireWhen(pidWritten('pandoc-enfant'));

      expect(await exporting).toMatchObject({ errorCode: 'export_timed_out' });
      expect(readFileSync(pdfOptions().outputPath).equals(before)).toBe(true);
    },
    20_000
  );

  it(
    'sans limite injectée, c’est 15 minutes, et le résultat transporte ce nombre',
    async () => {
      tool('pandoc', hangs('pandoc'));
      useFakeClock();

      const exporting = pdfExportService.exportToPDF(pdfOptions());
      await waitUntil(pidWritten('pandoc-enfant'), 10_000);
      vi.advanceTimersByTime(15 * 60 * 1000 - 5000);
      expect(isAlive(pidOf('pandoc'))).toBe(true);
      vi.advanceTimersByTime(5000);

      expect(await exporting).toMatchObject({
        success: false,
        errorCode: 'export_timed_out',
        timeLimitMinutes: 15,
      });
      expect(isAlive(pidOf('pandoc'))).toBe(false);
    },
    20_000
  );

  it(
    'un export fini avant la limite réussit et ne laisse aucune minuterie armée',
    async () => {
      tool('pandoc', 'sleep 0.2\nprintf "%s" "%PDF-faux" > "$3"');
      useFakeClock();
      const killSpy = vi.spyOn(process, 'kill');

      const result = await pdfExportService.exportToPDF(pdfOptions(), undefined, LIMIT);

      expect(result).toMatchObject({ success: true, outputPath: pdfOptions().outputPath });
      expect(readFileSync(pdfOptions().outputPath, 'utf8')).toBe('%PDF-faux');
      expect(vi.getTimerCount()).toBe(0);
      expect(killSpy).not.toHaveBeenCalled();
    },
    15_000
  );

  it(
    'une lecture bloquée rend la main aussi, et ne lance plus rien ensuite',
    async () => {
      tool('pandoc', `echo principal >> "${root}/appels"`);
      const fifo = blockedAbstract();

      try {
        const result = await pdfExportService.exportToPDF(pdfOptions(), undefined, { timeLimitMs: 500 });
        expect(result).toMatchObject({ success: false, errorCode: 'export_timed_out' });
      } finally {
        await releaseFifo(fifo);
      }

      await waitUntil(() => readdirSync(scratch).length === 0);
      expect(readdirSync(scratch)).toEqual([]);
      expect(calls()).toEqual([]);
    },
    15_000
  );
});

describe.skipIf(process.platform === 'win32')('export PDF : citeproc par chapitre', () => {
  it(
    'un citeproc qui pend fait échouer l’export, sans repli silencieux',
    async () => {
      tool('pandoc', pandocForBook(hangs('citeproc')));
      useFakeClock();

      const exporting = pdfExportService.exportToPDF(bookOptions(2), undefined, LIMIT);
      await expireWhen(pidWritten('citeproc-enfant'));

      expect(await exporting).toMatchObject({ success: false, errorCode: 'export_timed_out' });
      expect(isAlive(pidOf('citeproc'))).toBe(false);
      expect(isAlive(pidOf('citeproc-enfant'))).toBe(false);
      // Le repli aurait laissé le chapitre tel quel et poursuivi l'export.
      expect(calls()).toEqual(['citeproc']);
      expect(existsSync(join(project, 'sortie.pdf'))).toBe(false);
      await waitUntil(() => readdirSync(scratch).length === 0);
      expect(readdirSync(scratch)).toEqual([]);
    },
    20_000
  );

  it(
    'un citeproc qui échoue vite garde le repli existant',
    async () => {
      tool('pandoc', pandocForBook('exit 1'));

      const result = await pdfExportService.exportToPDF(bookOptions(2), undefined, { timeLimitMs: 10_000 });

      expect(result).toMatchObject({ success: true });
      expect(calls()).toEqual(['citeproc', 'citeproc', 'principal']);
      expect(readFileSync(join(root, 'entree-principale.md'), 'utf8')).toContain('[@clef]');
    },
    15_000
  );

  it(
    'tous les chapitres consomment la même horloge',
    async () => {
      // Chacun tient seul dans la limite : une horloge par chapitre ne verrait rien.
      tool('pandoc', pandocForBook('sleep 0.4\ncat "$1"'));

      const result = await pdfExportService.exportToPDF(bookOptions(6), undefined, { timeLimitMs: 1000 });

      expect(result).toMatchObject({ success: false, errorCode: 'export_timed_out' });
      expect(calls().length).toBeLessThan(6);
      expect(calls()).not.toContain('principal');
      expect(readdirSync(scratch)).toEqual([]);
    },
    15_000
  );
});

/**
 * Pandoc compile dans son propre dossier temporaire, avec la copie LaTeX du
 * manuscrit. Il ne le retire pas quand on le tue (mesuré avec le vrai xelatex) :
 * ce dossier doit vivre dans celui de l'export.
 */
describe.skipIf(process.platform === 'win32' || !pandocAvailable())('export PDF : le vrai pandoc', () => {
  it(
    'tué en pleine compilation, il ne laisse aucune copie du manuscrit',
    async () => {
      tool('xelatex', hangs('xelatex'));
      useFakeClock();

      const exporting = pdfExportService.exportToPDF(pdfOptions(), undefined, LIMIT);
      await expireWhen(pidWritten('xelatex-enfant'));

      expect(await exporting).toMatchObject({ success: false, errorCode: 'export_timed_out' });
      expect(isAlive(pidOf('xelatex'))).toBe(false);
      expect(isAlive(pidOf('xelatex-enfant'))).toBe(false);
      expect(readdirSync(scratch)).toEqual([]);
    },
    20_000
  );
});

describe.skipIf(process.platform === 'win32')('export Word', () => {
  it(
    'un pandoc qui pend : export_timed_out, processus morts, dossier supprimé, sortie intacte',
    async () => {
      tool('pandoc', hangs('pandoc'));
      const before = Buffer.from('docx-precedent');
      writeFileSync(wordOptions().outputPath, before);
      useFakeClock();

      const exporting = wordExportService.exportToWord(wordOptions(), undefined, LIMIT);
      await expireWhen(pidWritten('pandoc-enfant'));

      expect(await exporting).toMatchObject({ success: false, errorCode: 'export_timed_out' });
      expect(isAlive(pidOf('pandoc'))).toBe(false);
      expect(isAlive(pidOf('pandoc-enfant'))).toBe(false);
      expect(readFileSync(wordOptions().outputPath).equals(before)).toBe(true);
      expect(readdirSync(scratch)).toEqual([]);
    },
    20_000
  );

  it(
    'un export fini avant la limite réussit et ne laisse aucune minuterie armée',
    async () => {
      tool('pandoc', 'printf "%s" "docx" > "$3"');
      useFakeClock();

      const result = await wordExportService.exportToWord(wordOptions(), undefined, LIMIT);

      expect(result).toMatchObject({ success: true });
      expect(vi.getTimerCount()).toBe(0);
    },
    15_000
  );

  it(
    'une lecture bloquée rend la main aussi, y compris hors pandoc',
    async () => {
      // Sans bibliographie : le générateur interne, qui n'a aucun outil à tuer.
      const { bibliographyPath: _unused, ...native } = wordOptions();
      const fifo = blockedAbstract();
      let outcome: unknown;

      try {
        outcome = await wordExportService.exportToWord(native, undefined, { timeLimitMs: 500 });
      } finally {
        await releaseFifo(fifo);
      }

      expect(outcome).toMatchObject({ success: false, errorCode: 'export_timed_out' });
      // Le travail repris après coup n'écrit pas par-dessus l'annonce d'un échec.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(existsSync(native.outputPath)).toBe(false);
    },
    15_000
  );
});

describe('export de présentation', () => {
  const slides = () => ({
    projectPath: project,
    content: '# Une diapositive\n\nTexte.\n',
    outputPath: join(project, 'diapos.pdf'),
  });

  it(
    'une page qui ne charge jamais : fenêtre détruite, export_timed_out, HTML supprimé',
    async () => {
      presentation.loadFile = NEVER;
      useFakeClock();

      const exporting = revealJsExportService.exportToPDF(slides(), undefined, LIMIT);
      await expireWhen(() => presentation.loadedFile !== null);

      expect(await exporting).toMatchObject({ success: false, errorCode: 'export_timed_out' });
      expect(presentation.windows).toHaveLength(1);
      expect(presentation.windows[0]).toMatchObject({ destroyed: true, closed: false });
      expect(presentation.loadedFile).not.toBeNull();
      expect(existsSync(presentation.loadedFile as string)).toBe(false);
      expect(existsSync(slides().outputPath)).toBe(false);
    },
    10_000
  );

  it(
    'une impression qui ne finit jamais : même issue',
    async () => {
      presentation.printToPDF = NEVER;
      useFakeClock();

      const exporting = revealJsExportService.exportToPDF(slides(), undefined, LIMIT);
      await expireWhen(() => presentation.printing);

      expect(await exporting).toMatchObject({ success: false, errorCode: 'export_timed_out' });
      expect(presentation.windows[0]).toMatchObject({ destroyed: true, closed: false });
      expect(existsSync(presentation.loadedFile as string)).toBe(false);
    },
    10_000
  );

  it(
    'un rendu qui aboutit referme la fenêtre, sans la détruire ni garder de minuterie',
    async () => {
      useFakeClock();

      const result = await revealJsExportService.exportToPDF(slides(), undefined, LIMIT);

      expect(result).toMatchObject({ success: true, outputPath: slides().outputPath });
      expect(presentation.windows[0]).toMatchObject({ destroyed: false, closed: true });
      expect(vi.getTimerCount()).toBe(0);
    },
    10_000
  );

  it(
    'un CDN qui ne répond pas fait échouer l’export hors ligne, qui n’écrit rien ensuite',
    async () => {
      const responders: Array<(response: Response) => void> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise<Response>((resolve) => { responders.push(resolve); }))
      );
      // Un dossier encore absent : même sa création serait une suite de trop.
      const outputDir = join(project, 'sorties');
      const output = join(outputDir, 'diapos.html');

      const result = await revealJsExportService.exportOffline(
        { ...slides(), outputPath: output },
        undefined,
        { timeLimitMs: 300 }
      );

      expect(result).toMatchObject({ success: false, errorCode: 'export_timed_out' });
      // Toutes les réponses : une seule en attente laisserait le travail suspendu,
      // et l'assertion ci-dessous ne pourrait jamais échouer.
      for (const respond of responders) respond(new Response('/* tardif */'));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(existsSync(outputDir)).toBe(false);
    },
    10_000
  );

  it(
    'un navigateur qui ne s’ouvre jamais ne retient pas l’export HTML : le fichier est écrit, il a réussi',
    async () => {
      presentation.openPath = NEVER;
      const output = join(project, 'diapos.html');

      const result = await revealJsExportService.exportToRevealJs(
        { ...slides(), outputPath: output },
        undefined,
        { timeLimitMs: 300 }
      );

      expect(result).toEqual({ success: true, outputPath: output });
      expect(readFileSync(output, 'utf8')).toContain('<!DOCTYPE html>');
      expect(presentation.openCalls).toBe(1);
    },
    10_000
  );

  it(
    'un navigateur qui refuse de s’ouvrir ne fait pas échouer l’export HTML',
    async () => {
      presentation.openPath = () => Promise.reject(new Error('aucune application'));
      const output = join(project, 'diapos.html');

      const result = await revealJsExportService.exportToRevealJs(
        { ...slides(), outputPath: output },
        undefined,
        LIMIT
      );

      expect(result).toEqual({ success: true, outputPath: output });
      // Un rejet sans lecteur ferait échouer ce test : on lui laisse le temps de partir.
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
    10_000
  );

  describe.each([
    {
      name: 'HTML',
      file: 'diapos.html',
      run: revealJsExportService.exportToRevealJs.bind(revealJsExportService),
    },
    {
      name: 'hors ligne',
      file: 'diapos.html',
      run: revealJsExportService.exportOffline.bind(revealJsExportService),
    },
    {
      name: 'PDF',
      file: 'diapos.pdf',
      run: revealJsExportService.exportToPDF.bind(revealJsExportService),
    },
  ])('chemin $name : un dossier de sortie qui se débloque après l’échéance', ({ file, run }) => {
    it(
      'n’écrit plus rien par-dessus l’annonce de l’échec',
      async () => {
        const outputDir = join(project, 'sorties');
        mkdirSync(outputDir);
        const output = join(outputDir, file);
        writeFileSync(output, 'EXPORT-PRECEDENT');
        vi.stubGlobal('fetch', vi.fn(async () => new Response('/* asset */')));
        let release: () => void = () => undefined;
        presentation.dirBarrier = new Promise((resolve) => { release = resolve; });
        presentation.heldDir = outputDir;
        useFakeClock();

        const exporting = run({ ...slides(), outputPath: output }, undefined, LIMIT);
        await expireWhen(() => presentation.dirHeld);
        // Le délai laissé au nettoyage : le travail reste suspendu sur la barrière.
        await vi.advanceTimersByTimeAsync(2000);

        expect(await exporting).toMatchObject({ success: false, errorCode: 'export_timed_out' });

        vi.useRealTimers();
        release();
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(readFileSync(output, 'utf8')).toBe('EXPORT-PRECEDENT');
        expect(presentation.openCalls).toBe(0);
      },
      15_000
    );
  });
});
