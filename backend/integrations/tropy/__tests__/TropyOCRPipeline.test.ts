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
import { TropyOCRPipeline } from '../TropyOCRPipeline';
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

  // L06-10 (S08-1-13) : la conversion précède l'initialisation du moteur, et le
  // nettoyage n'est pas dans un `finally` — un moteur qui ne démarre pas laisse
  // les PNG 300 dpi dans le dossier temporaire.
  it.fails('un moteur qui ne démarre pas ne laisse pas de pages temporaires (L06-10, S08-1-13)', async () => {
    const pdf = writeFile('registre.pdf');
    spyConversion(2);
    tess.createWorker.mockRejectedValue(new Error('langue indisponible'));

    await expect(new TropyOCRPipeline().performOCR(pdf)).rejects.toThrow();

    expect(fs.existsSync(pageDirs[0])).toBe(false);
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
