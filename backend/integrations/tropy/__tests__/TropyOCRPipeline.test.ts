/**
 * TropyOCRPipeline sous tesseract.js simulé.
 *
 * Le pipeline n'avait aucun test : c'est pourtant lui qui transforme des
 * heures de calcul en texte. tesseract.js est remplacé par un faux moteur
 * (`vi.mock`) — aucun modèle de langue téléchargé, aucun réseau — et la
 * conversion des PDF passe par le vrai `PDFConverter`, espionné : soit sa
 * conversion est remplacée par l'écriture de vraies pages PNG factices dans
 * un vrai dossier temporaire, soit, si Poppler est installé, elle tourne pour
 * de bon. Le nettoyage, lui, est toujours le vrai.
 *
 * Tests de caractérisation, verts sur le code du 2026-11-07 ; les `it.fails`
 * décrivent un défaut connu, que la PR citée doit faire passer au vert.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import {
  OcrEngineStoppedError,
  OcrEngineUnavailableError,
  SUPPORTED_OCR_LANGUAGES,
  TropyOCRPipeline,
} from '../TropyOCRPipeline';
import { PDFConverter } from '../PDFConverter';
import { findExternalTool } from '../../../core/tools/external-tools';

// MARK: - Faux tesseract.js

type RecognizeResult = { data: { text: string; confidence: number } };
interface FakeWorker {
  recognize: Mock<(file: string) => Promise<RecognizeResult>>;
  terminate: Mock<() => Promise<void>>;
  reinitialize: Mock<(language: string) => Promise<void>>;
}

interface FakeWorkerState extends FakeWorker {
  createWorker: Mock<(...args: unknown[]) => Promise<FakeWorker>>;
  /** Texte et confiance par nom de fichier reconnu ; `Error` = la page échoue. */
  pages: Map<string, { text: string; confidence: number } | Error>;
  /** Fichiers présents sur le disque au moment de leur reconnaissance. */
  seenOnDisk: string[];
}

const tess = vi.hoisted(() => ({}) as FakeWorkerState);

vi.mock('tesseract.js', () => ({
  createWorker: (...args: unknown[]) => tess.createWorker(...args),
}));

function resetTesseract(): void {
  tess.pages = new Map();
  tess.seenOnDisk = [];
  tess.recognize = vi.fn(async (file: string) => {
    if (fs.existsSync(file)) tess.seenOnDisk.push(file);
    const page = tess.pages.get(path.basename(file)) ?? { text: `texte de ${path.basename(file)}`, confidence: 80 };
    if (page instanceof Error) throw page;
    return { data: { text: `  ${page.text}\n`, confidence: page.confidence } };
  });
  tess.terminate = vi.fn(async () => undefined);
  tess.reinitialize = vi.fn(async (_language: string) => undefined);
  tess.createWorker = vi.fn(async (..._args: unknown[]) => ({
    recognize: tess.recognize,
    terminate: tess.terminate,
    reinitialize: tess.reinitialize,
  }));
}

// Le plafond d'un `vi.waitFor` (une seconde par défaut) : la CI est plus lente que le Mac.
const UNTIL = { timeout: 4_000 };

// MARK: - Fichiers

let root: string;
let pageDirs: string[];

function writeFile(name: string, content = 'octets factices'): string {
  const p = path.join(root, name);
  fs.writeFileSync(p, content);
  return p;
}

/**
 * Remplace la conversion par Poppler : écrit `count` pages PNG factices dans
 * un vrai dossier temporaire, comme le ferait pdftoppm, et le note pour que
 * le test vérifie qu'il a disparu.
 */
function spyConversion(count: number) {
  return vi.spyOn(PDFConverter.prototype, 'convertToTempFiles').mockImplementation(async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-pdf-test-'));
    pageDirs.push(tempDir);
    const files: string[] = [];
    for (let i = 1; i <= count; i++) {
      const f = path.join(tempDir, `page-${i}.png`);
      fs.writeFileSync(f, 'png factice');
      files.push(f);
    }
    return { tempDir, files, pageCount: count };
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-ocr-test-'));
  pageDirs = [];
  resetTesseract();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
  // Filet si un test échoue avant le nettoyage du pipeline : dossiers nommés, un par un.
  for (const dir of pageDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// MARK: - Images

describe('TropyOCRPipeline — images', () => {
  it('reconnaît une image avec la langue demandée et rend le texte nettoyé', async () => {
    const image = writeFile('lettre.jpg');
    tess.pages.set('lettre.jpg', { text: 'Monsieur le Préfet,', confidence: 91.5 });

    const pipeline = new TropyOCRPipeline();
    const result = await pipeline.performOCR(image, { language: 'fra' });

    expect(tess.createWorker).toHaveBeenCalledTimes(1);
    expect(tess.createWorker.mock.calls[0][0]).toBe('fra');
    expect(tess.recognize).toHaveBeenCalledWith(image);
    expect(result).toEqual({ text: 'Monsieur le Préfet,', confidence: 91.5, language: 'fra' });
  });

  it('un lot : un seul moteur, chaque fichier une fois, textes joints et confiance moyenne', async () => {
    const a = writeFile('a.jpg');
    const b = writeFile('b.png');
    tess.pages.set('a.jpg', { text: 'recto', confidence: 90 });
    tess.pages.set('b.png', { text: 'verso', confidence: 70 });

    const pipeline = new TropyOCRPipeline();
    const result = await pipeline.performBatchOCR([a, b, a], { language: 'fra' });

    expect(tess.createWorker).toHaveBeenCalledTimes(1);
    expect(tess.recognize.mock.calls.map((c) => c[0])).toEqual([a, b]);
    expect(result.text).toBe('recto\n\n---\n\nverso');
    expect(result.confidence).toBe(80);
  });

  it('un fichier absent est sauté, les autres passent', async () => {
    const a = writeFile('a.jpg');
    tess.pages.set('a.jpg', { text: 'recto', confidence: 90 });

    const pipeline = new TropyOCRPipeline();
    const result = await pipeline.performBatchOCR([path.join(root, 'absent.jpg'), a]);

    expect(tess.recognize.mock.calls.map((c) => c[0])).toEqual([a]);
    expect(result.text).toBe('recto');
  });

  it('dispose termine le moteur, et un nouvel appel en recrée un', async () => {
    const a = writeFile('a.jpg');
    const pipeline = new TropyOCRPipeline();
    await pipeline.performOCR(a);
    await pipeline.dispose();
    expect(tess.terminate).toHaveBeenCalledTimes(1);

    await pipeline.performOCR(a);
    expect(tess.createWorker).toHaveBeenCalledTimes(2);
  });
});

// MARK: - PDF

describe('TropyOCRPipeline — PDF', () => {
  it('convertit, reconnaît chaque page, numérote, puis efface les pages temporaires', async () => {
    const pdf = writeFile('registre.pdf');
    const convert = spyConversion(2);
    const cleanup = vi.spyOn(PDFConverter.prototype, 'cleanupTempFiles');
    tess.pages.set('page-1.png', { text: 'première page', confidence: 90 });
    tess.pages.set('page-2.png', { text: 'seconde page', confidence: 60 });

    const pipeline = new TropyOCRPipeline();
    const result = await pipeline.performOCR(pdf, { language: 'fra' });

    expect(convert).toHaveBeenCalledWith(pdf, { dpi: 300 });
    expect(tess.recognize).toHaveBeenCalledTimes(2);
    // Les pages existaient bien quand le moteur les a lues…
    expect(tess.seenOnDisk.map((f) => path.basename(f))).toEqual(['page-1.png', 'page-2.png']);
    expect(result.text).toBe('--- Page 1 ---\n\npremière page\n\n--- Page 2 ---\n\nseconde page');
    expect(result.confidence).toBe(75);
    // …et elles n'y sont plus.
    expect(cleanup).toHaveBeenCalledWith(pageDirs[0]);
    expect(fs.existsSync(pageDirs[0])).toBe(false);
  });

  it('une page en échec n’empêche ni les autres ni le nettoyage', async () => {
    const pdf = writeFile('registre.pdf');
    spyConversion(3);
    tess.pages.set('page-2.png', new Error('page illisible'));

    const pipeline = new TropyOCRPipeline();
    const result = await pipeline.performOCR(pdf);

    expect(tess.recognize).toHaveBeenCalledTimes(3);
    expect(result.text).toContain('texte de page-1.png');
    expect(result.text).toContain('texte de page-3.png');
    expect(fs.existsSync(pageDirs[0])).toBe(false);
  });

  it('PDF et image dans le même lot', async () => {
    const pdf = writeFile('registre.pdf');
    const image = writeFile('photo.jpg');
    spyConversion(1);

    const pipeline = new TropyOCRPipeline();
    const result = await pipeline.performBatchOCR([pdf, image]);

    expect(tess.createWorker).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('--- Page 1 ---\n\ntexte de page-1.png\n\n---\n\ntexte de photo.jpg');
    expect(fs.existsSync(pageDirs[0])).toBe(false);
  });

  // L06-11 (S08-1-12) : la numérotation suit les pages réussies, pas les pages du PDF.
  it.fails('une page en échec ne décale pas le numéro des suivantes (L06-11, S08-1-12)', async () => {
    const pdf = writeFile('registre.pdf');
    spyConversion(3);
    tess.pages.set('page-2.png', new Error('page illisible'));

    const result = await new TropyOCRPipeline().performOCR(pdf);

    expect(result.text).toContain('--- Page 3 ---\n\ntexte de page-3.png');
  });

  // L06-10 (S08-1-13) : la conversion précédait l'initialisation du moteur, et
  // le nettoyage n'était pas dans un `finally` — un moteur qui ne démarre pas
  // laissait les PNG 300 dpi dans le dossier temporaire.
  it('un moteur qui ne démarre pas ne laisse pas de pages temporaires (L06-10, S08-1-13)', async () => {
    const pdf = writeFile('registre.pdf');
    const convert = spyConversion(2);
    tess.createWorker.mockRejectedValue(new Error('langue indisponible'));

    await expect(new TropyOCRPipeline().performOCR(pdf)).rejects.toBeInstanceOf(OcrEngineUnavailableError);

    // Le moteur d'abord : aucune page convertie à 300 dpi pour rien.
    expect(convert).not.toHaveBeenCalled();
    expect(fs.existsSync(pageDirs[0] ?? path.join(root, 'aucune-page'))).toBe(false);
  });

  it('le moteur arrêté pendant une page : échec franc, pages temporaires effacées (L06-10)', async () => {
    const pdf = writeFile('registre.pdf');
    spyConversion(2);
    const cleanup = vi.spyOn(PDFConverter.prototype, 'cleanupTempFiles');
    // Comme tesseract.js 7 : `terminate` ne règle pas une reconnaissance en cours.
    tess.recognize.mockImplementation(() => new Promise<RecognizeResult>(() => undefined));

    const pipeline = new TropyOCRPipeline();
    const running = pipeline.performOCR(pdf);
    await vi.waitFor(() => expect(tess.recognize).toHaveBeenCalledTimes(1), UNTIL);
    await pipeline.dispose();

    await expect(running).rejects.toBeInstanceOf(OcrEngineStoppedError);
    expect(cleanup).toHaveBeenCalledWith(pageDirs[0]);
    expect(fs.existsSync(pageDirs[0])).toBe(false);
    // Ni la page suivante, ni un nouveau moteur pour elle.
    expect(tess.recognize).toHaveBeenCalledTimes(1);
    expect(tess.createWorker).toHaveBeenCalledTimes(1);
  });
});

// MARK: - Moteur qui ne démarre pas

type WorkerOptions = { cachePath?: string; errorHandler?: (data: unknown) => void };

function workerOptions(call = 0): WorkerOptions {
  return (tess.createWorker.mock.calls[call]?.[2] ?? {}) as WorkerOptions;
}

function fakeWorker(): FakeWorker {
  return { recognize: tess.recognize, terminate: tess.terminate, reinitialize: tess.reinitialize };
}

/**
 * Comme tesseract.js 7 quand le modèle de langue ne se charge pas (hors ligne,
 * 404 du dépôt) : la promesse de `createWorker` ne se règle jamais, seul
 * `errorHandler` est prévenu. Rend de quoi faire arriver le moteur plus tard.
 */
function engineThatNeverStarts(): { release: () => void } {
  let resolve: (worker: FakeWorker) => void = () => undefined;
  tess.createWorker.mockImplementation(
    () =>
      new Promise<FakeWorker>((r) => {
        resolve = r;
      })
  );
  return { release: () => resolve(fakeWorker()) };
}

describe('TropyOCRPipeline — moteur qui ne démarre pas (L06-10, S08-1-29)', () => {
  it('modèle introuvable : `errorHandler` prévenu, rejet typé aussitôt', async () => {
    engineThatNeverStarts();
    const started = new TropyOCRPipeline().initialize('frk');
    await vi.waitFor(() => expect(tess.createWorker).toHaveBeenCalledTimes(1), UNTIL);

    workerOptions().errorHandler?.(
      'Error: Network error while fetching https://cdn.jsdelivr.net/npm/@tesseract.js-data/frk/4.0.0_best_int/frk.traineddata.gz. Response code: 404'
    );

    await expect(started).rejects.toBeInstanceOf(OcrEngineUnavailableError);
    await expect(started).rejects.toMatchObject({ language: 'frk' });
  });

  it('aucune réponse : rejet typé au délai, pas avant', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    engineThatNeverStarts();
    let outcome: unknown = 'en attente';
    const started = new TropyOCRPipeline({ initTimeoutMs: 60_000 }).initialize('fra').then(
      () => 'démarré',
      (error: unknown) => error
    );
    void started.then((value) => {
      outcome = value;
    });
    await vi.waitFor(() => expect(tess.createWorker).toHaveBeenCalledTimes(1), UNTIL);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(outcome).toBe('en attente');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await started).toBeInstanceOf(OcrEngineUnavailableError);
  });

  it('un moteur arrivé après le délai est terminé, pas gardé', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const engine = engineThatNeverStarts();
    const started = new TropyOCRPipeline({ initTimeoutMs: 1_000 }).initialize('fra').catch((error: unknown) => error);
    await vi.waitFor(() => expect(tess.createWorker).toHaveBeenCalledTimes(1), UNTIL);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await started).toBeInstanceOf(OcrEngineUnavailableError);

    engine.release();
    await vi.waitFor(() => expect(tess.terminate).toHaveBeenCalledTimes(1), UNTIL);
  });

  it('lot : le premier fichier suffit, le lot s’arrête sur une seule tentative', async () => {
    const files = ['a.jpg', 'b.jpg', 'c.jpg'].map((name) => writeFile(name));
    tess.createWorker.mockRejectedValue(new Error('worker crashed'));

    await expect(new TropyOCRPipeline().performBatchOCR(files, { language: 'frk' })).rejects.toBeInstanceOf(
      OcrEngineUnavailableError
    );
    expect(tess.createWorker).toHaveBeenCalledTimes(1);
  });

  it('arrêté pendant son démarrage : rejet franc, et le moteur arrivé ensuite est terminé', async () => {
    const engine = engineThatNeverStarts();
    const pipeline = new TropyOCRPipeline();
    const running = pipeline.performOCR(writeFile('a.jpg'));
    await vi.waitFor(() => expect(tess.createWorker).toHaveBeenCalledTimes(1), UNTIL);

    await pipeline.dispose();
    await expect(running).rejects.toBeInstanceOf(OcrEngineStoppedError);

    engine.release();
    await vi.waitFor(() => expect(tess.terminate).toHaveBeenCalledTimes(1), UNTIL);
    expect(tess.recognize).not.toHaveBeenCalled();
  });

  it('arrêté pendant un lot : le lot s’arrête, aucun moteur n’est recréé pour le fichier suivant', async () => {
    const files = ['a.jpg', 'b.jpg'].map((name) => writeFile(name));
    tess.recognize.mockImplementation(() => new Promise<RecognizeResult>(() => undefined));
    const pipeline = new TropyOCRPipeline();
    const running = pipeline.performBatchOCR(files);
    await vi.waitFor(() => expect(tess.recognize).toHaveBeenCalledTimes(1), UNTIL);

    await pipeline.dispose();

    await expect(running).rejects.toBeInstanceOf(OcrEngineStoppedError);
    expect(tess.createWorker).toHaveBeenCalledTimes(1);
  });
});

// MARK: - Dossier des modèles de langue

describe('TropyOCRPipeline — dossier des modèles (L06-10, S08-1-29)', () => {
  it('le moteur range ses modèles dans le dossier donné, créé au besoin', async () => {
    const cache = path.join(root, 'userData', 'tesseract-cache');

    await new TropyOCRPipeline({ cachePath: cache }).initialize('fra');

    expect(workerOptions().cachePath).toBe(cache);
    expect(fs.statSync(cache).isDirectory()).toBe(true);
  });

  it('à sa création, le dossier reprend les modèles laissés dans le dossier courant, sans les déplacer', async () => {
    // tesseract.js 7, sans `cachePath`, écrivait dans `.` : le dossier courant.
    const legacy = path.join(root, 'ancien-dossier-courant');
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, 'fra.traineddata'), 'modèle français');
    fs.writeFileSync(path.join(legacy, 'xyz.traineddata'), 'pas une langue proposée');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(legacy);
    const cache = path.join(root, 'tesseract-cache');
    const pipeline = new TropyOCRPipeline({ cachePath: cache });
    cwd.mockRestore();

    await pipeline.initialize('deu');

    expect(fs.readdirSync(cache)).toEqual(['fra.traineddata']);
    expect(fs.readFileSync(path.join(cache, 'fra.traineddata'), 'utf-8')).toBe('modèle français');
    expect(fs.existsSync(path.join(legacy, 'fra.traineddata'))).toBe(true);
  });

  it('un dossier de modèles qui existe déjà ne reprend rien : une reprise par mise à jour, pas à chaque démarrage', async () => {
    const legacy = path.join(root, 'ancien-dossier-courant');
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, 'fra.traineddata'), 'modèle français');
    const cache = path.join(root, 'tesseract-cache');
    fs.mkdirSync(cache);
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(legacy);
    const pipeline = new TropyOCRPipeline({ cachePath: cache });
    cwd.mockRestore();

    await pipeline.initialize('fra');

    expect(fs.readdirSync(cache)).toEqual([]);
  });
});

// MARK: - Langues proposées

describe('SUPPORTED_OCR_LANGUAGES', () => {
  it('chaque code proposé existe dans tesseract.js (L06-10, S08-2-3)', () => {
    // La liste du paquet lui-même, hors de la doublure de `tesseract.js`.
    const known = new Set(
      Object.values(createRequire(import.meta.url)('tesseract.js/src/constants/languages') as Record<string, string>)
    );

    expect(SUPPORTED_OCR_LANGUAGES.map((l) => l.code).filter((code) => !known.has(code))).toEqual([]);
    expect(SUPPORTED_OCR_LANGUAGES.find((l) => l.name === 'Allemand Fraktur')?.code).toBe('frk');
  });
});

// MARK: - Poppler réel

// pdftoppm installé (Homebrew, poppler-utils) : la vraie conversion, sans
// espion sur elle. Sauté sinon — la CI n'a pas forcément Poppler.
const pdftoppm = findExternalTool('pdftoppm');

/** Un PDF minimal d'une page blanche ; Poppler recalcule la table xref. */
function minimalPdf(): string {
  return [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] >> endobj',
    'trailer << /Root 1 0 R >>',
    '%%EOF',
  ].join('\n');
}

describe.skipIf(!pdftoppm)('TropyOCRPipeline — PDF avec le vrai Poppler', () => {
  it('la page convertie existe pendant la reconnaissance et disparaît après', async () => {
    const pdf = writeFile('page-blanche.pdf', minimalPdf());
    const convert = vi.spyOn(PDFConverter.prototype, 'convertToTempFiles');
    const cleanup = vi.spyOn(PDFConverter.prototype, 'cleanupTempFiles');

    const result = await new TropyOCRPipeline().performOCR(pdf);
    // Filet de l'afterEach si le nettoyage régresse : le dossier de Poppler, nommément.
    if (tess.seenOnDisk[0]) pageDirs.push(path.dirname(tess.seenOnDisk[0]));

    expect(convert).toHaveBeenCalledTimes(1);
    expect(tess.seenOnDisk).toHaveLength(1);
    expect(tess.seenOnDisk[0]).toMatch(/\.png$/);
    expect(result.text).toContain('--- Page 1 ---');
    const tempDir = cleanup.mock.calls[0]?.[0];
    expect(tempDir).toBe(path.dirname(tess.seenOnDisk[0]));
    expect(fs.existsSync(tempDir)).toBe(false);
  });
});
