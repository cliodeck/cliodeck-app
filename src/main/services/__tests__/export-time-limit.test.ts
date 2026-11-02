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
import { EventEmitter } from 'events';
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
  /** Le `writeFile` de ce fichier se fait, puis reste en attente de la barrière. */
  heldFile: null as string | null,
  fileBarrier: Promise.resolve(),
  fileHeld: false,
  /** Un stat sans réponse, comme sur un montage mort. */
  deadPath: null as string | null,
  statBarrier: Promise.resolve(),
  statHeld: false,
  /** Un stat synchrone sous ce dossier gèlerait le main sur un montage mort, et l'horloge avec. */
  syncStatRoot: null as string | null,
  syncStats: [] as string[],
}));

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const existsSync = (path: Parameters<typeof real.existsSync>[0]) => {
    if (presentation.syncStatRoot && String(path).startsWith(presentation.syncStatRoot)) {
      presentation.syncStats.push(String(path));
    }
    return real.existsSync(path);
  };
  return { ...real, existsSync };
});

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
  const writeFile = async (...args: Parameters<typeof real.writeFile>) => {
    await real.writeFile(...args);
    if (String(args[0]) === presentation.heldFile) {
      presentation.fileHeld = true;
      await presentation.fileBarrier;
    }
  };
  const access = async (...args: Parameters<typeof real.access>) => {
    if (String(args[0]) === presentation.deadPath) {
      presentation.statHeld = true;
      await presentation.statBarrier;
    }
    return real.access(...args);
  };
  return { ...real, mkdir, writeFile, access };
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
const { ExportClock, watchSystemSleep } = await import('../export-time-limit.js');

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

/**
 * Larges, car une machine saturée met des secondes à lancer un script (mesuré sous
 * 16 processus de charge). Seul un test rouge les attend jusqu'au bout.
 */
const TEST_MS = 60_000;
const READY_MS = 30_000;
const SETTLED_MS = 15_000;

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

async function waitUntil(condition: () => boolean, ms = SETTLED_MS): Promise<void> {
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
  });
}

/** Retient le `writeFile` de ce fichier, une fois fait. Rend de quoi le relâcher. */
function holdWrite(file: string): () => void {
  let release: () => void = () => undefined;
  presentation.fileBarrier = new Promise((resolve) => { release = resolve; });
  presentation.heldFile = file;
  return () => release();
}

/** Il part peu après l'annonce de l'échec : le nettoyage du service n'est attendu que 2 s. */
async function expectNoTempLeft(): Promise<void> {
  await waitUntil(() => readdirSync(scratch).length === 0);
  expect(readdirSync(scratch)).toEqual([]);
}

function useFakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
}

/** Fait échoir l'horloge de l'export, une fois `ready` vrai. */
async function expireWhen(ready: () => boolean): Promise<void> {
  await waitUntil(ready, READY_MS);
  if (!ready()) throw new Error('L’export n’a pas atteint l’attente que le test devait faire échoir.');
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
  presentation.heldFile = null;
  presentation.fileHeld = false;
  presentation.deadPath = null;
  presentation.statHeld = false;
  presentation.syncStatRoot = null;
  presentation.syncStats = [];
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
  // Ce nettoyage synchrone a dépassé les 10 s par défaut sur une machine saturée.
}, TEST_MS);

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
      await expectNoTempLeft();
    },
    TEST_MS
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
      await expectNoTempLeft();
    },
    TEST_MS
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
      await expectNoTempLeft();
    },
    TEST_MS
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
    TEST_MS
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
    TEST_MS
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
    TEST_MS
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
      await expectNoTempLeft();
      expect(calls()).toEqual([]);
    },
    TEST_MS
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
      await expectNoTempLeft();
    },
    TEST_MS
  );

  it(
    'un citeproc qui échoue vite garde le repli existant',
    async () => {
      tool('pandoc', pandocForBook('exit 1'));

      const result = await pdfExportService.exportToPDF(bookOptions(2), undefined, LIMIT);

      expect(result).toMatchObject({ success: true });
      expect(calls()).toEqual(['citeproc', 'citeproc', 'principal']);
      expect(readFileSync(join(root, 'entree-principale.md'), 'utf8')).toContain('[@clef]');
    },
    TEST_MS
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
      await expectNoTempLeft();
    },
    TEST_MS
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
      await expectNoTempLeft();
    },
    TEST_MS
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
      await expectNoTempLeft();
    },
    TEST_MS
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
    TEST_MS
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
    TEST_MS
  );

  it(
    'une écriture qui se débloque après l’échéance n’annonce pas de succès',
    async () => {
      const { bibliographyPath: _unused, ...native } = wordOptions();
      const release = holdWrite(native.outputPath);
      const stages: string[] = [];
      useFakeClock();

      const exporting = wordExportService.exportToWord(native, (p) => stages.push(p.stage), LIMIT);
      await expireWhen(() => presentation.fileHeld);
      await vi.advanceTimersByTimeAsync(2000);

      expect(await exporting).toMatchObject({ success: false, errorCode: 'export_timed_out' });

      vi.useRealTimers();
      release();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(stages).not.toContain('complete');
    },
    TEST_MS
  );
});

describe.skipIf(process.platform === 'win32')('un disque qui ne répond plus', () => {
  describe.each([
    {
      name: 'PDF',
      options: pdfOptions,
      run: pdfExportService.exportToPDF.bind(pdfExportService),
    },
    {
      name: 'Word',
      options: wordOptions,
      run: wordExportService.exportToWord.bind(wordExportService),
    },
  ])('$name : un stat sans réponse', ({ options, run }) => {
    it(
      'rend la main à l’échéance, et le travail repris ne lance plus rien',
      async () => {
        tool('pandoc', `echo principal >> "${root}/appels"`);
        writeFileSync(join(project, 'abstract.md'), 'Un résumé.\n');
        let release: () => void = () => undefined;
        presentation.statBarrier = new Promise((resolve) => { release = resolve; });
        presentation.deadPath = join(project, 'abstract.md');
        useFakeClock();

        const exporting = run(options(), undefined, LIMIT);
        await expireWhen(() => presentation.statHeld);
        await vi.advanceTimersByTimeAsync(2000);

        expect(await exporting).toMatchObject({ success: false, errorCode: 'export_timed_out' });

        vi.useRealTimers();
        release();
        // Word ne crée son dossier qu'après ce stat : le travail repris doit d'abord avancer.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await expectNoTempLeft();
        expect(calls()).toEqual([]);
        expect(existsSync(options().outputPath)).toBe(false);
      },
      TEST_MS
    );
  });

  /** Tous les fichiers facultatifs d'un export : chaque test d'existence y passe. */
  function optionalFiles(): { cslPath: string; templatePath: string } {
    writeFileSync(join(project, 'abstract.md'), 'Un résumé.\n');
    writeFileSync(join(project, 'style.csl'), '<style/>');
    writeFileSync(join(project, 'modele.dotx'), 'pas un vrai modèle');
    return { cslPath: join(project, 'style.csl'), templatePath: join(project, 'modele.dotx') };
  }

  it(
    'PDF d’un livre, bibliographie par chapitre : aucun stat synchrone sur les fichiers du projet',
    async () => {
      tool('pandoc', pandocForBook('cat "$1"'));
      const { cslPath } = optionalFiles();

      presentation.syncStatRoot = project;
      const result = await pdfExportService.exportToPDF({ ...bookOptions(1), cslPath }, undefined, LIMIT);
      presentation.syncStatRoot = null;

      expect(result).toMatchObject({ success: true });
      expect(presentation.syncStats).toEqual([]);
    },
    TEST_MS
  );

  it(
    'Word par pandoc : aucun stat synchrone sur les fichiers du projet',
    async () => {
      tool('pandoc', 'printf "%s" "docx" > "$3"');
      const files = optionalFiles();

      presentation.syncStatRoot = project;
      const result = await wordExportService.exportToWord({ ...wordOptions(), ...files }, undefined, LIMIT);
      presentation.syncStatRoot = null;

      expect(result).toMatchObject({ success: true });
      expect(presentation.syncStats).toEqual([]);
    },
    TEST_MS
  );

  it(
    'PDF à bibliographie unique : aucun stat synchrone non plus',
    async () => {
      tool('pandoc', 'printf "%s" "%PDF-faux" > "$3"');
      const { cslPath } = optionalFiles();

      presentation.syncStatRoot = project;
      const result = await pdfExportService.exportToPDF(
        { ...pdfOptions(), cslPath, bibliographyPath: bibliography },
        undefined,
        LIMIT
      );
      presentation.syncStatRoot = null;

      expect(result).toMatchObject({ success: true });
      expect(presentation.syncStats).toEqual([]);
    },
    TEST_MS
  );

  /** `pathExists` non attendu : une promesse est toujours vraie, un fichier absent passerait. */
  describe('un fichier facultatif présent est pris, un absent ne l’est pas', () => {
    const recordArgs = (output: string) =>
      `echo "$*" >> "${root}/arguments"\nprintf "%s" "${output}" > "$3"`;
    const args = () => readFileSync(join(root, 'arguments'), 'utf8');

    it(
      'PDF',
      async () => {
        tool('pandoc', recordArgs('%PDF-faux'));
        const { cslPath } = optionalFiles();
        const bibliographyPath = bibliography;

        await pdfExportService.exportToPDF(
          { ...pdfOptions(), cslPath, bibliographyPath },
          undefined,
          LIMIT
        );
        expect(args()).toContain('--bibliography');
        expect(args()).toContain('--csl');
        expect(args()).toContain('Un résumé.');

        // Le CSL ne compte qu'avec une bibliographie : d'abord lui seul.
        rmSync(join(root, 'arguments'));
        rmSync(cslPath);
        await pdfExportService.exportToPDF(
          { ...pdfOptions(), cslPath, bibliographyPath },
          undefined,
          LIMIT
        );
        expect(args()).toContain('--bibliography');
        expect(args()).not.toContain('--csl');

        rmSync(join(root, 'arguments'));
        rmSync(bibliographyPath);
        rmSync(join(project, 'abstract.md'));
        await pdfExportService.exportToPDF(
          { ...pdfOptions(), cslPath, bibliographyPath },
          undefined,
          LIMIT
        );
        expect(args()).not.toContain('--bibliography');
        expect(args()).not.toContain('Un résumé.');
      },
      TEST_MS
    );

    it(
      'PDF d’un livre : le citeproc de chaque chapitre',
      async () => {
        const record = `echo "$*" >> "${root}/arguments"`;
        tool('pandoc', pandocForBook(`${record}\ncat "$1"`));
        const { cslPath } = optionalFiles();
        const options = { ...bookOptions(1), cslPath };

        await pdfExportService.exportToPDF(options, undefined, LIMIT);
        expect(args()).toContain('--csl');

        rmSync(join(root, 'arguments'));
        rmSync(cslPath);
        await pdfExportService.exportToPDF(options, undefined, LIMIT);
        expect(args()).toContain('--citeproc');
        expect(args()).not.toContain('--csl');

        // Sans bibliographie sur le disque, plus de citeproc par chapitre.
        rmSync(join(root, 'appels'));
        rmSync(bibliography);
        await pdfExportService.exportToPDF(options, undefined, LIMIT);
        expect(calls()).toEqual(['principal']);
      },
      TEST_MS
    );

    it(
      'Word par pandoc',
      async () => {
        tool('pandoc', recordArgs('docx'));
        const files = optionalFiles();

        await wordExportService.exportToWord({ ...wordOptions(), ...files }, undefined, LIMIT);
        expect(args()).toContain('--bibliography');
        expect(args()).toContain('--csl');
        expect(args()).toContain('--reference-doc');

        rmSync(join(root, 'arguments'));
        rmSync(files.cslPath);
        rmSync(files.templatePath);
        await wordExportService.exportToWord({ ...wordOptions(), ...files }, undefined, LIMIT);
        expect(args()).toContain('--bibliography');
        expect(args()).not.toContain('--csl');
        expect(args()).not.toContain('--reference-doc');
      },
      TEST_MS
    );

    it(
      'Word : sans bibliographie sur le disque, le générateur interne, pas pandoc',
      async () => {
        tool('pandoc', recordArgs('docx'));
        rmSync(bibliography);

        const result = await wordExportService.exportToWord(wordOptions(), undefined, LIMIT);

        expect(result).toMatchObject({ success: true });
        expect(existsSync(join(root, 'arguments'))).toBe(false);
        // Un vrai docx : une archive ZIP.
        expect(readFileSync(wordOptions().outputPath).subarray(0, 2).toString()).toBe('PK');
      },
      TEST_MS
    );
  });

  it(
    'Word par le générateur interne : aucun stat synchrone sur les fichiers du projet',
    async () => {
      const { bibliographyPath: _unused, ...native } = wordOptions();
      const { templatePath } = optionalFiles();

      presentation.syncStatRoot = project;
      const result = await wordExportService.exportToWord({ ...native, templatePath }, undefined, LIMIT);
      presentation.syncStatRoot = null;

      expect(result).toMatchObject({ success: true });
      expect(presentation.syncStats).toEqual([]);
    },
    TEST_MS
  );
});

/**
 * Le Mac qui dort ne fait rien tourner. Les deux temps sont ici indépendants :
 * `vi.advanceTimersByTime` pour les minuteries, `wall` pour l'heure. Sous macOS,
 * les minuteries comptent la veille et tombent dès le réveil ; ailleurs, elles
 * peuvent ne pas la compter.
 */
describe('la veille ne compte pas dans la limite', () => {
  const HOUR = 3_600_000;
  let wall: number;
  let power: EventEmitter;

  const isExpired = (clock: InstanceType<typeof ExportClock>): boolean => {
    try {
      clock.throwIfExpired();
      return false;
    } catch {
      return true;
    }
  };

  /** Le temps passe pour tout le monde. */
  const pass = (ms: number): void => {
    wall += ms;
    vi.advanceTimersByTime(ms);
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    wall = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    power = new EventEmitter();
    watchSystemSleep(power);
  });

  it('sans veille, la limite tombe à l’heure et rien ne reste armé', () => {
    const clock = new ExportClock(1000);
    pass(999);
    expect(isExpired(clock)).toBe(false);
    pass(1);
    expect(isExpired(clock)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    clock.stop();
  });

  it('une minuterie qui tombe au réveil, avant l’annonce : il reste le temps qui restait', () => {
    const clock = new ExportClock(1000);
    pass(400);
    power.emit('suspend');
    wall += HOUR;
    vi.advanceTimersByTime(600); // Elle a compté la veille : elle tombe dès le réveil.
    expect(isExpired(clock)).toBe(false);
    power.emit('resume');
    pass(599);
    expect(isExpired(clock)).toBe(false);
    pass(1);
    expect(isExpired(clock)).toBe(true);
    clock.stop();
  });

  it('une annonce du réveil qui précède la minuterie : même reste', () => {
    const clock = new ExportClock(1000);
    pass(400);
    power.emit('suspend');
    wall += HOUR;
    power.emit('resume');
    vi.advanceTimersByTime(600);
    expect(isExpired(clock)).toBe(false);
    pass(599);
    expect(isExpired(clock)).toBe(false);
    pass(1);
    expect(isExpired(clock)).toBe(true);
    clock.stop();
  });

  it('des minuteries qui ne comptent pas la veille : la limite tombe sans rallonge', () => {
    const clock = new ExportClock(1000);
    pass(400);
    power.emit('suspend');
    wall += HOUR;
    power.emit('resume');
    pass(600);
    expect(isExpired(clock)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    clock.stop();
  });

  it('un réveil jamais annoncé ne retire pas l’échéance', () => {
    const clock = new ExportClock(1000);
    pass(400);
    power.emit('suspend');
    wall += HOUR;
    vi.advanceTimersByTime(600);
    expect(isExpired(clock)).toBe(false);
    pass(600);
    expect(isExpired(clock)).toBe(true);
    clock.stop();
  });

  it('plusieurs veilles s’additionnent', () => {
    const clock = new ExportClock(1000);
    pass(300);
    power.emit('suspend');
    wall += HOUR;
    power.emit('resume');
    pass(300);
    power.emit('suspend');
    wall += 2 * HOUR;
    power.emit('resume');
    vi.advanceTimersByTime(400);
    expect(isExpired(clock)).toBe(false);
    pass(399);
    expect(isExpired(clock)).toBe(false);
    pass(1);
    expect(isExpired(clock)).toBe(true);
    clock.stop();
  });

  it('une heure système qu’on recule, sans veille, ne retarde pas la limite', () => {
    const clock = new ExportClock(1000);
    pass(999);
    wall -= HOUR;
    pass(1);
    expect(isExpired(clock)).toBe(true);
    clock.stop();
  });

  it('une veille d’avant l’export ne lui donne aucune rallonge', () => {
    power.emit('suspend');
    wall += HOUR;
    power.emit('resume');
    const clock = new ExportClock(1000);
    pass(1000);
    expect(isExpired(clock)).toBe(true);
    clock.stop();
  });

  it('une limite repartie après une veille se désarme aussi', () => {
    const clock = new ExportClock(1000);
    pass(400);
    power.emit('suspend');
    wall += HOUR;
    vi.advanceTimersByTime(600);
    power.emit('resume');
    expect(vi.getTimerCount()).toBe(1);
    clock.stop();
    expect(vi.getTimerCount()).toBe(0);
    pass(1000);
    expect(isExpired(clock)).toBe(false);
  });
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
    TEST_MS
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
    TEST_MS
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
    TEST_MS
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
    TEST_MS
  );

  it(
    'un navigateur qui ne s’ouvre jamais ne retient pas l’export HTML : le fichier est écrit, il a réussi',
    async () => {
      presentation.openPath = NEVER;
      const output = join(project, 'diapos.html');

      const result = await revealJsExportService.exportToRevealJs(
        { ...slides(), outputPath: output },
        undefined,
        { timeLimitMs: 3000 }
      );

      expect(result).toEqual({ success: true, outputPath: output });
      expect(readFileSync(output, 'utf8')).toContain('<!DOCTYPE html>');
      expect(presentation.openCalls).toBe(1);
    },
    TEST_MS
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
    TEST_MS
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
      TEST_MS
    );

    it(
      'une écriture qui se débloque après l’échéance n’annonce pas de succès et n’ouvre rien',
      async () => {
        const output = join(project, file);
        vi.stubGlobal('fetch', vi.fn(async () => new Response('/* asset */')));
        const release = holdWrite(output);
        const stages: string[] = [];
        useFakeClock();

        const exporting = run(
          { ...slides(), outputPath: output },
          (progress) => stages.push(progress.stage),
          LIMIT
        );
        await expireWhen(() => presentation.fileHeld);
        await vi.advanceTimersByTimeAsync(2000);

        expect(await exporting).toMatchObject({ success: false, errorCode: 'export_timed_out' });

        vi.useRealTimers();
        release();
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(stages).not.toContain('complete');
        expect(presentation.openCalls).toBe(0);
      },
      TEST_MS
    );
  });
});
