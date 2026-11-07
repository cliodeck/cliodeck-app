/**
 * Poppler absent : ClioDeck doit le **dire**, une fois, au lieu de conclure
 * « pas de texte » (#138).
 *
 * Avant : `PDFConverter` ne cherchait Poppler que dans des emplacements Unix
 * et retombait sur `which` — jamais trouvé sous Windows. L'échec était avalé
 * par un `console.warn` dans la boucle d'OCR, la synchronisation rendait
 * `null`, et l'historien ne savait pas qu'il manquait un logiciel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PopplerNotFoundError, createPDFConverter, popplerInstallHint } from '../PDFConverter';
import { TropyOCRPipeline } from '../TropyOCRPipeline';

let realPlatform: NodeJS.Platform;

beforeEach(() => {
  realPlatform = process.platform;
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  vi.restoreAllMocks();
});

describe('popplerInstallHint', () => {
  it('donne la marche à suivre du système, en nommant ce qui est en jeu', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const hint = popplerInstallHint(platform);
      expect(hint).toContain('OCR');
      expect(hint).toContain('Poppler');
    }
    expect(popplerInstallHint('win32')).toContain('PATH');
    expect(popplerInstallHint('darwin')).toContain('brew install poppler');
    expect(popplerInstallHint('linux')).toContain('poppler-utils');
  });
});

describe('PDFConverter sans Poppler', () => {
  it('lève une erreur reconnaissable, qui explique quoi installer', async () => {
    const converter = createPDFConverter();
    // Aucun binaire trouvé, quel que soit l'emplacement essayé.
    vi.spyOn(converter as unknown as { findBinary(name: string): string | null }, 'findBinary').mockReturnValue(null);

    await expect(converter.initialize()).rejects.toBeInstanceOf(PopplerNotFoundError);
    await expect(converter.initialize()).rejects.toThrow(/Poppler est introuvable/);
  });
});

describe('boucle d’OCR', () => {
  it('ne réduit pas un outil absent à l’échec d’un fichier : l’erreur remonte', async () => {
    const pipeline = new TropyOCRPipeline();
    vi.spyOn(pipeline as unknown as { performOCR(p: string): Promise<unknown> }, 'performOCR').mockRejectedValue(
      new PopplerNotFoundError(),
    );

    await expect(pipeline.performBatchOCR(['/archives/a.pdf', '/archives/b.pdf'])).rejects.toBeInstanceOf(
      PopplerNotFoundError,
    );
  });

  // L06-10 (S08-1-14) : le PDF levait au milieu du lot, et les images déjà
  // reconnues étaient jetées avec lui.
  it('12 images et un PDF : le texte des images est rendu, l’outil manquant dit avec lui (L06-10)', async () => {
    const pipeline = new TropyOCRPipeline();
    const performOCR = vi
      .spyOn(pipeline as unknown as { performOCR(p: string): Promise<unknown> }, 'performOCR')
      .mockImplementation(async (filePath: string) => {
        if (filePath.endsWith('.pdf')) throw new PopplerNotFoundError();
        return { text: `Texte de ${filePath.split('/').pop()}`, confidence: 80, language: 'fra', pageCount: 1 };
      });
    const images = Array.from({ length: 12 }, (_, i) => `/archives/dossier-x/vue-${i + 1}.jpg`);

    const result = await pipeline.performBatchOCR([
      ...images.slice(0, 6),
      '/archives/dossier-x/annexe.pdf',
      ...images.slice(6),
    ]);

    expect(performOCR).toHaveBeenCalledTimes(13);
    expect(result.text).toContain('Texte de vue-1.jpg');
    expect(result.text).toContain('Texte de vue-12.jpg');
    expect(result.missingTool).toBe('poppler');
  });

  it('un échec ordinaire sur un fichier reste ignoré, les autres sont traités', async () => {
    const pipeline = new TropyOCRPipeline();
    vi.spyOn(pipeline as unknown as { performOCR(p: string): Promise<unknown> }, 'performOCR').mockImplementation(
      async (filePath: string) => {
        if (filePath.endsWith('cassé.pdf')) throw new Error('page illisible');
        return { text: 'Texte de la source', confidence: 80, language: 'fra', pageCount: 1 };
      },
    );

    const result = await pipeline.performBatchOCR(['/archives/cassé.pdf', '/archives/bon.pdf']);
    expect(result.text).toContain('Texte de la source');
  });
});
