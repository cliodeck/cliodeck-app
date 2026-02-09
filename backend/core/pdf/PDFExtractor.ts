import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import type { DocumentPage, PDFMetadata } from '../../types/pdf-document';

// pdfjs-dist 3.x loaded dynamically for better Node.js/Electron compatibility
let pdfjsLib: any = null;
let canvasStubbed = false;

// Mock canvas implementation for pdfjs (we only need text extraction, not rendering)
const mockCanvas = {
  createCanvas: (w: number, h: number) => ({
    getContext: () => ({
      fillRect: () => {},
      drawImage: () => {},
      getImageData: () => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData: () => {},
      createImageData: (w2: number, h2: number) => ({ data: new Uint8ClampedArray(w2 * h2 * 4), width: w2, height: h2 }),
      save: () => {},
      restore: () => {},
      transform: () => {},
      setTransform: () => {},
      resetTransform: () => {},
      scale: () => {},
      translate: () => {},
      rotate: () => {},
      beginPath: () => {},
      closePath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      bezierCurveTo: () => {},
      quadraticCurveTo: () => {},
      stroke: () => {},
      fill: () => {},
      clip: () => {},
      rect: () => {},
      arc: () => {},
      ellipse: () => {},
      measureText: () => ({ width: 0 }),
      fillText: () => {},
      strokeText: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
      createPattern: () => null,
      clearRect: () => {},
      canvas: { width: w, height: h },
    }),
    width: w,
    height: h,
    toBuffer: () => Buffer.alloc(0),
    toDataURL: () => '',
  }),
  Image: class MockImage {
    width = 0;
    height = 0;
    src = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
  },
  loadImage: async () => ({ width: 0, height: 0 }),
};

// Stub out canvas module to prevent native module crashes
function stubCanvas(): void {
  if (canvasStubbed) return;

  try {
    // Use createRequire to get access to the require.cache
    const require = createRequire(import.meta.url);

    // Pre-populate the require cache with our mock canvas
    // This prevents the native canvas from being loaded
    const canvasPath = require.resolve('canvas');
    require.cache[canvasPath] = {
      id: canvasPath,
      filename: canvasPath,
      loaded: true,
      exports: mockCanvas,
      parent: null,
      children: [],
      path: path.dirname(canvasPath),
      paths: [],
    } as any;

    canvasStubbed = true;
    console.log('📄 [EXTRACTOR] Canvas module stubbed (not needed for text extraction)');
  } catch (e) {
    console.warn('📄 [EXTRACTOR] Could not stub canvas module:', e);
  }
}

async function initPdfjs(): Promise<any> {
  if (pdfjsLib) return pdfjsLib;

  // Stub canvas before importing pdfjs to prevent native crashes
  stubCanvas();

  // Use CommonJS require to load pdfjs-dist (works correctly with exports)
  const require = createRequire(import.meta.url);
  pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

  // Disable worker for Node.js usage
  pdfjsLib.GlobalWorkerOptions.workerSrc = '';

  console.log('📄 [EXTRACTOR] pdfjs loaded, getDocument available:', typeof pdfjsLib.getDocument);

  return pdfjsLib;
}

export interface PDFStatistics {
  pageCount: number;
  totalWords: number;
  totalCharacters: number;
  averageWordsPerPage: number;
  nonEmptyPages: number;
}

export class PDFExtractor {
  // MARK: - Extraction complète

  async extractDocument(
    filePath: string
  ): Promise<{ pages: DocumentPage[]; metadata: PDFMetadata; title: string }> {
    console.log('📄 [EXTRACTOR] extractDocument called:', filePath);

    console.log('📄 [EXTRACTOR] Initializing pdfjs...');
    const pdfjs = await initPdfjs();
    console.log('📄 [EXTRACTOR] pdfjs initialized');

    // Vérifier que le fichier existe
    console.log('📄 [EXTRACTOR] Checking file exists...');
    if (!fs.existsSync(filePath)) {
      throw new Error('Fichier PDF introuvable');
    }
    console.log('📄 [EXTRACTOR] File exists');

    // Charger le PDF
    console.log('📄 [EXTRACTOR] Reading file...');
    const fileBuffer = fs.readFileSync(filePath);
    console.log(`📄 [EXTRACTOR] File read: ${fileBuffer.length} bytes`);

    console.log('📄 [EXTRACTOR] Creating Uint8Array...');
    const data = new Uint8Array(fileBuffer);
    console.log('📄 [EXTRACTOR] Uint8Array created');

    console.log('📄 [EXTRACTOR] Calling getDocument...');
    const loadingTask = pdfjs.getDocument({ data });
    console.log('📄 [EXTRACTOR] getDocument called, awaiting promise...');
    const pdfDocument = await loadingTask.promise;
    console.log('📄 [EXTRACTOR] PDF loaded successfully');

    console.log(`📄 Extraction de ${pdfDocument.numPages} pages depuis ${path.basename(filePath)}`);

    // Extraire les métadonnées
    const metadata = await this.extractMetadata(pdfDocument);

    // Extraire le titre
    const title = await this.extractTitle(pdfDocument, filePath);

    // Extraire le texte page par page
    const pages: DocumentPage[] = [];

    for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
      const page = await pdfDocument.getPage(pageNum);
      const textContent = await page.getTextContent();

      // Assembler le texte
      const text = textContent.items
        .map((item: any) => item.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      pages.push({
        pageNumber: pageNum,
        text,
      });

      // Log progression
      if (pageNum % 10 === 0 || pageNum === pdfDocument.numPages) {
        console.log(`  Extraction: ${pageNum}/${pdfDocument.numPages} pages`);
      }
    }

    const totalWords = pages.reduce(
      (sum, page) => sum + page.text.split(/\s+/).filter((w) => w.length > 0).length,
      0
    );

    console.log(`✅ PDF extrait: ${pages.length} pages, ${totalWords} mots`);

    return { pages, metadata, title };
  }

  // MARK: - Extraction de métadonnées

  private async extractMetadata(pdfDocument: any): Promise<PDFMetadata> {
    try {
      const metadata = await pdfDocument.getMetadata();
      const info = metadata.info || {};

      // Extraire les métadonnées
      const subject = info.Subject || undefined;
      const creator = info.Creator || undefined;
      const producer = info.Producer || undefined;
      const creationDate = info.CreationDate ? this.parsePDFDate(info.CreationDate) : undefined;
      const modificationDate = info.ModDate ? this.parsePDFDate(info.ModDate) : undefined;

      // Extraire les mots-clés
      let keywords: string[] = [];
      if (info.Keywords) {
        keywords = info.Keywords.split(',')
          .map((k: string) => k.trim())
          .filter((k: string) => k.length > 0);
      }

      return {
        subject,
        keywords,
        creator,
        producer,
        creationDate,
        modificationDate,
      };
    } catch (error) {
      console.warn('⚠️ Erreur extraction métadonnées PDF:', error);
      return {
        keywords: [],
      };
    }
  }

  // Parser les dates PDF (format: D:YYYYMMDDHHmmSS)
  private parsePDFDate(dateString: string): Date | undefined {
    try {
      const match = dateString.match(/D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
      if (!match) return undefined;

      const [, year, month, day, hour, minute, second] = match;
      return new Date(
        parseInt(year),
        parseInt(month) - 1,
        parseInt(day),
        parseInt(hour),
        parseInt(minute),
        parseInt(second)
      );
    } catch {
      return undefined;
    }
  }

  // MARK: - Extraction du titre

  private async extractTitle(pdfDocument: any, filePath: string): Promise<string> {
    try {
      // Essayer d'obtenir le titre depuis les métadonnées
      const metadata = await pdfDocument.getMetadata();
      const info = metadata.info || {};

      if (info.Title && info.Title.trim().length > 0) {
        return this.cleanTitle(info.Title);
      }

      // Si pas de titre dans les métadonnées, essayer la première page
      const firstPage = await pdfDocument.getPage(1);
      const textContent = await firstPage.getTextContent();
      const pageText = textContent.items.map((item: any) => item.str).join('\n');

      // Trouver la première ligne substantielle
      const lines = pageText.split('\n').map((l) => l.trim());
      for (const line of lines) {
        if (line.length > 10 && line.length < 200) {
          return this.cleanTitle(line);
        }
      }
    } catch (error) {
      console.warn('⚠️ Erreur extraction titre:', error);
    }

    // Sinon, utiliser le nom du fichier
    return this.cleanTitle(path.basename(filePath, path.extname(filePath)));
  }

  private cleanTitle(title: string): string {
    let cleaned = title;

    // Enlever les extensions communes
    cleaned = cleaned.replace(/\.pdf$/i, '');

    // Remplacer les underscores et tirets par des espaces
    cleaned = cleaned.replace(/_/g, ' ').replace(/-/g, ' ');

    // Nettoyer les espaces multiples
    cleaned = cleaned.replace(/\s+/g, ' ');

    // Trim
    cleaned = cleaned.trim();

    return cleaned;
  }

  // MARK: - Extraction d'auteur depuis métadonnées

  async extractAuthor(filePath: string): Promise<string | undefined> {
    try {
      const pdfjs = await initPdfjs();
      const data = new Uint8Array(fs.readFileSync(filePath));
      const loadingTask = pdfjs.getDocument({ data });
      const pdfDocument = await loadingTask.promise;

      const metadata = await pdfDocument.getMetadata();
      const info = metadata.info as any || {};

      return info.Author?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  // MARK: - Extraction de l'année

  async extractYear(filePath: string): Promise<string | undefined> {
    try {
      const pdfjs = await initPdfjs();
      const data = new Uint8Array(fs.readFileSync(filePath));
      const loadingTask = pdfjs.getDocument({ data });
      const pdfDocument = await loadingTask.promise;

      const metadata = await pdfDocument.getMetadata();
      const info = metadata.info as any || {};

      if (info.CreationDate) {
        const date = this.parsePDFDate(info.CreationDate);
        return date ? date.getFullYear().toString() : undefined;
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  // MARK: - Utilitaires

  async getPageCount(filePath: string): Promise<number | null> {
    try {
      const pdfjs = await initPdfjs();
      const data = new Uint8Array(fs.readFileSync(filePath));
      const loadingTask = pdfjs.getDocument({ data });
      const pdfDocument = await loadingTask.promise;
      return pdfDocument.numPages;
    } catch {
      return null;
    }
  }

  async extractText(filePath: string, pageNumber: number): Promise<string> {
    const pdfjs = await initPdfjs();
    const data = new Uint8Array(fs.readFileSync(filePath));
    const loadingTask = pdfjs.getDocument({ data });
    const pdfDocument = await loadingTask.promise;

    if (pageNumber < 1 || pageNumber > pdfDocument.numPages) {
      throw new Error('Numéro de page invalide');
    }

    const page = await pdfDocument.getPage(pageNumber);
    const textContent = await page.getTextContent();

    return textContent.items.map((item: any) => item.str).join(' ');
  }

  // MARK: - Validation

  isPDFValid(filePath: string): boolean {
    try {
      if (!fs.existsSync(filePath)) return false;

      const data = new Uint8Array(fs.readFileSync(filePath));
      // Simple vérification du magic number PDF
      const header = String.fromCharCode(...data.slice(0, 5));
      return header === '%PDF-';
    } catch {
      return false;
    }
  }

  // MARK: - Statistiques

  async getStatistics(filePath: string): Promise<PDFStatistics> {
    const { pages } = await this.extractDocument(filePath);

    const totalWords = pages.reduce((sum, page) => {
      return sum + page.text.split(/\s+/).filter((w) => w.length > 0).length;
    }, 0);

    const totalCharacters = pages.reduce((sum, page) => sum + page.text.length, 0);

    const averageWordsPerPage = pages.length > 0 ? Math.floor(totalWords / pages.length) : 0;

    const nonEmptyPages = pages.filter((page) => page.text.trim().length > 0).length;

    return {
      pageCount: pages.length,
      totalWords,
      totalCharacters,
      averageWordsPerPage,
      nonEmptyPages,
    };
  }
}
