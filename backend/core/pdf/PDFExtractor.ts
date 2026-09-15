import * as fs from 'fs';
import * as path from 'path';
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api';
import type { DocumentPage, PDFMetadata } from '../../types/pdf-document';
import { openPdfForText, pageStrings } from './pdfjs-loader';

interface PDFInfo {
  Title?: string;
  Author?: string;
  Subject?: string;
  Keywords?: string;
  Creator?: string;
  Producer?: string;
  CreationDate?: string;
  ModDate?: string;
}

async function readInfo(pdfDocument: PDFDocumentProxy): Promise<PDFInfo> {
  const metadata = await pdfDocument.getMetadata();
  return (metadata.info ?? {}) as PDFInfo;
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

    console.log('📄 [EXTRACTOR] Opening PDF...');
    const pdfDocument = await openPdfForText(data);
    console.log('📄 [EXTRACTOR] PDF loaded successfully');

    console.log(`📄 Extraction de ${pdfDocument.numPages} pages depuis ${path.basename(filePath)}`);

    // Extraire les métadonnées
    const metadata = await this.extractMetadata(pdfDocument);

    // Extraire le titre
    const title = await this.extractTitle(pdfDocument, filePath);

    // Extraire le texte page par page
    const pages: DocumentPage[] = [];

    for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
      // Assembler le texte
      const text = (await pageStrings(pdfDocument, pageNum))
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

  private async extractMetadata(pdfDocument: PDFDocumentProxy): Promise<PDFMetadata> {
    try {
      const info = await readInfo(pdfDocument);

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

  private async extractTitle(pdfDocument: PDFDocumentProxy, filePath: string): Promise<string> {
    try {
      // Essayer d'obtenir le titre depuis les métadonnées
      const info = await readInfo(pdfDocument);

      if (info.Title && info.Title.trim().length > 0) {
        return this.cleanTitle(info.Title);
      }

      // Si pas de titre dans les métadonnées, essayer la première page
      const pageText = (await pageStrings(pdfDocument, 1)).join('\n');

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
      const pdfDocument = await openPdfForText(new Uint8Array(fs.readFileSync(filePath)));
      const info = await readInfo(pdfDocument);

      return info.Author?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  // MARK: - Extraction de l'année

  async extractYear(filePath: string): Promise<string | undefined> {
    try {
      const pdfDocument = await openPdfForText(new Uint8Array(fs.readFileSync(filePath)));
      const info = await readInfo(pdfDocument);

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
      const pdfDocument = await openPdfForText(new Uint8Array(fs.readFileSync(filePath)));
      return pdfDocument.numPages;
    } catch {
      return null;
    }
  }

  async extractText(filePath: string, pageNumber: number): Promise<string> {
    const pdfDocument = await openPdfForText(new Uint8Array(fs.readFileSync(filePath)));

    if (pageNumber < 1 || pageNumber > pdfDocument.numPages) {
      throw new Error('Numéro de page invalide');
    }

    return (await pageStrings(pdfDocument, pageNumber)).join(' ');
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
