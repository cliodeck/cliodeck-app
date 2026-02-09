import * as fs from 'fs';
import * as path from 'path';
import { PDFConverter, createPDFConverter } from './PDFConverter';

// MARK: - Types

export interface OCROptions {
  language: string; // ISO 639-2 codes: 'fra', 'deu', 'eng', 'lat', etc.
  oem?: number; // OCR Engine Mode (0-3), default 3 (LSTM)
}

export interface OCRResult {
  text: string;
  confidence: number; // 0-100
  language: string;
}

export type TranscriptionFormat = 'transkribus' | 'alto' | 'page-xml' | 'plain-text';

export interface TranscriptionImportConfig {
  type: TranscriptionFormat;
  filePath: string;
}

export interface TranscriptionImportResult {
  text: string;
  format: TranscriptionFormat;
  pageCount?: number;
}

// MARK: - TropyOCRPipeline

/**
 * Pipeline OCR pour les sources primaires Tropy
 * Supporte:
 * - OCR avec Tesseract.js (texte imprimé)
 * - Import de transcriptions externes (Transkribus, ALTO, PAGE XML, texte brut)
 */
export class TropyOCRPipeline {
  private tesseractWorker: any = null;
  private isInitialized: boolean = false;
  private pdfConverter: PDFConverter | null = null;

  /**
   * Initialise le worker Tesseract.js
   * @param language Langue pour l'OCR (default: 'fra')
   */
  async initialize(language: string = 'fra'): Promise<void> {
    if (this.isInitialized) return;

    try {
      // Import dynamique de tesseract.js pour éviter les erreurs si non installé
      const Tesseract = await import('tesseract.js');

      this.tesseractWorker = await Tesseract.createWorker(language, 1, {
        logger: (m: any) => {
          if (m.status === 'recognizing text') {
            // Progress tracking si nécessaire
          }
        },
      });

      this.isInitialized = true;
      console.log(`🔤 OCR initialized with language: ${language}`);
    } catch (error) {
      console.error('Failed to initialize Tesseract:', error);
      throw new Error(
        'Tesseract.js not available. Please install with: npm install tesseract.js'
      );
    }
  }

  /**
   * Change la langue du worker Tesseract
   */
  async setLanguage(language: string): Promise<void> {
    if (!this.tesseractWorker) {
      await this.initialize(language);
      return;
    }

    await this.tesseractWorker.reinitialize(language);
  }

  /**
   * Check if a file is a PDF
   */
  isPDF(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === '.pdf';
  }

  /**
   * Get or create PDF converter instance
   */
  private async getPDFConverter(): Promise<PDFConverter> {
    if (!this.pdfConverter) {
      this.pdfConverter = createPDFConverter();
    }
    return this.pdfConverter;
  }

  /**
   * Effectue l'OCR sur une image ou un PDF
   * @param filePath Chemin vers l'image ou le PDF
   * @param options Options OCR
   * @returns Texte extrait avec score de confiance
   */
  async performOCR(filePath: string, options?: OCROptions): Promise<OCRResult> {
    const language = options?.language || 'fra';

    // Vérifier que le fichier existe
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Si c'est un PDF, le convertir en images d'abord
    if (this.isPDF(filePath)) {
      return this.performPDFOCR(filePath, options);
    }

    // Initialiser Tesseract si nécessaire
    if (!this.isInitialized) {
      await this.initialize(language);
    }

    try {
      console.log(`🔍 Performing OCR on: ${path.basename(filePath)}`);

      const result = await this.tesseractWorker.recognize(filePath);

      return {
        text: result.data.text.trim(),
        confidence: result.data.confidence,
        language,
      };
    } catch (error) {
      console.error('OCR failed:', error);
      throw new Error(`OCR failed for ${filePath}: ${error}`);
    }
  }

  /**
   * Effectue l'OCR sur un fichier PDF
   * Convertit chaque page en image puis applique l'OCR
   * @param pdfPath Chemin vers le PDF
   * @param options Options OCR
   * @returns Texte combiné de toutes les pages avec confiance moyenne
   */
  async performPDFOCR(pdfPath: string, options?: OCROptions): Promise<OCRResult> {
    const language = options?.language || 'fra';

    console.log(`📄 Performing OCR on PDF: ${path.basename(pdfPath)}`);

    // Initialiser le convertisseur PDF
    const pdfConverter = await this.getPDFConverter();

    // Convertir le PDF en fichiers temporaires
    let tempResult: { tempDir: string; files: string[]; pageCount: number };
    try {
      tempResult = await pdfConverter.convertToTempFiles(pdfPath, {
        dpi: 300, // Bonne qualité pour OCR
      });
    } catch (error) {
      console.error('PDF conversion failed:', error);
      throw new Error(`Failed to convert PDF ${pdfPath}: ${error}`);
    }

    console.log(`📄 PDF converted: ${tempResult.pageCount} pages`);

    // Initialiser Tesseract si nécessaire
    if (!this.isInitialized) {
      await this.initialize(language);
    }

    // Effectuer l'OCR sur chaque page
    const results: OCRResult[] = [];
    for (let i = 0; i < tempResult.files.length; i++) {
      const pageFile = tempResult.files[i];
      try {
        console.log(`  📃 OCR page ${i + 1}/${tempResult.files.length}`);
        const result = await this.tesseractWorker.recognize(pageFile);
        results.push({
          text: result.data.text.trim(),
          confidence: result.data.confidence,
          language,
        });
      } catch (error) {
        console.warn(`⚠️ OCR failed for page ${i + 1}: ${error}`);
      }
    }

    // Nettoyer les fichiers temporaires
    pdfConverter.cleanupTempFiles(tempResult.tempDir);

    if (results.length === 0) {
      return {
        text: '',
        confidence: 0,
        language,
      };
    }

    // Combiner les textes des pages
    const combinedText = results.map((r, i) => `--- Page ${i + 1} ---\n\n${r.text}`).join('\n\n');
    const avgConfidence = results.reduce((sum, r) => sum + r.confidence, 0) / results.length;

    console.log(`📄 PDF OCR completed: ${results.length} pages, avg confidence: ${avgConfidence.toFixed(1)}%`);

    return {
      text: combinedText,
      confidence: avgConfidence,
      language,
    };
  }

  /**
   * Effectue l'OCR sur plusieurs fichiers (images ou PDF) et concatène les résultats
   * @param filePaths Liste des chemins de fichiers (images ou PDF)
   * @param options Options OCR
   * @returns Texte combiné avec confiance moyenne
   */
  async performBatchOCR(
    filePaths: string[],
    options?: OCROptions
  ): Promise<OCRResult> {
    // Deduplicate file paths to avoid processing the same file multiple times
    const uniquePaths = [...new Set(filePaths)];
    const results: OCRResult[] = [];

    for (const filePath of uniquePaths) {
      try {
        // performOCR gère automatiquement les PDF et les images
        const result = await this.performOCR(filePath, options);
        results.push(result);
      } catch (error) {
        console.warn(`Skipping ${filePath}: ${error}`);
      }
    }

    if (results.length === 0) {
      return {
        text: '',
        confidence: 0,
        language: options?.language || 'fra',
      };
    }

    // Combiner les textes
    const combinedText = results.map((r) => r.text).join('\n\n---\n\n');
    const avgConfidence =
      results.reduce((sum, r) => sum + r.confidence, 0) / results.length;

    return {
      text: combinedText,
      confidence: avgConfidence,
      language: results[0].language,
    };
  }

  /**
   * Importe une transcription externe
   * @param config Configuration d'import
   * @returns Texte importé
   */
  async importTranscription(
    config: TranscriptionImportConfig
  ): Promise<TranscriptionImportResult> {
    if (!fs.existsSync(config.filePath)) {
      throw new Error(`File not found: ${config.filePath}`);
    }

    switch (config.type) {
      case 'transkribus':
        return this.parseTranskribusExport(config.filePath);
      case 'alto':
        return this.parseALTO(config.filePath);
      case 'page-xml':
        return this.parsePageXML(config.filePath);
      case 'plain-text':
        return this.parsePlainText(config.filePath);
      default:
        throw new Error(`Unknown transcription format: ${config.type}`);
    }
  }

  /**
   * Détecte automatiquement le format d'un fichier de transcription
   */
  detectFormat(filePath: string): TranscriptionFormat | null {
    const ext = path.extname(filePath).toLowerCase();
    const content = fs.readFileSync(filePath, 'utf-8').slice(0, 500);

    if (ext === '.txt') {
      return 'plain-text';
    }

    if (ext === '.xml') {
      if (content.includes('<alto') || content.includes('<Alto')) {
        return 'alto';
      }
      if (content.includes('<PcGts') || content.includes('PAGE')) {
        return 'page-xml';
      }
      if (content.includes('TranskribusExport') || content.includes('<page')) {
        return 'transkribus';
      }
    }

    return null;
  }

  /**
   * Termine le worker Tesseract
   */
  async dispose(): Promise<void> {
    if (this.tesseractWorker) {
      await this.tesseractWorker.terminate();
      this.tesseractWorker = null;
      this.isInitialized = false;
      console.log('🔤 OCR worker terminated');
    }
  }

  // MARK: - Private Parsers

  /**
   * Parse un export Transkribus (format XML propriétaire ou PAGE XML)
   */
  private parseTranskribusExport(filePath: string): TranscriptionImportResult {
    const content = fs.readFileSync(filePath, 'utf-8');
    const textLines: string[] = [];
    let pageCount = 0;

    // Transkribus exporte souvent en PAGE XML, essayer d'abord ce format
    if (content.includes('<PcGts') || content.includes('PAGE')) {
      return this.parsePageXML(filePath);
    }

    // Format Transkribus natif (structure de pages avec lignes)
    // Pattern pour extraire le texte des éléments <line> ou <TextLine>
    const linePattern = /<(?:line|TextLine)[^>]*>[\s\S]*?<Unicode>([^<]*)<\/Unicode>/gi;
    const pagePattern = /<page\b/gi;

    let match;
    while ((match = linePattern.exec(content)) !== null) {
      const text = match[1].trim();
      if (text) {
        textLines.push(text);
      }
    }

    // Compter les pages
    while (pagePattern.exec(content) !== null) {
      pageCount++;
    }

    return {
      text: textLines.join('\n'),
      format: 'transkribus',
      pageCount: pageCount || undefined,
    };
  }

  /**
   * Parse un fichier ALTO XML (standard de la BnF, etc.)
   * ALTO = Analyzed Layout and Text Object
   */
  private parseALTO(filePath: string): TranscriptionImportResult {
    const content = fs.readFileSync(filePath, 'utf-8');
    const textLines: string[] = [];
    let pageCount = 0;

    // Extraire le texte des éléments <String CONTENT="...">
    const stringPattern = /<String[^>]*CONTENT="([^"]*)"/gi;
    const textLinePattern = /<TextLine\b/gi;
    const pagePattern = /<Page\b/gi;

    // Collecter tous les mots/strings
    const strings: string[] = [];
    let match;
    while ((match = stringPattern.exec(content)) !== null) {
      strings.push(match[1]);
    }

    // Reconstruire les lignes (approximation: une TextLine = une ligne)
    // Pour une meilleure reconstruction, il faudrait parser la structure complète
    let currentLine: string[] = [];
    const textLineMatches = content.match(/<TextLine[\s\S]*?<\/TextLine>/gi) || [];

    for (const textLineXml of textLineMatches) {
      const lineStrings: string[] = [];
      const localStringPattern = /<String[^>]*CONTENT="([^"]*)"/gi;
      let stringMatch;
      while ((stringMatch = localStringPattern.exec(textLineXml)) !== null) {
        lineStrings.push(stringMatch[1]);
      }
      if (lineStrings.length > 0) {
        textLines.push(lineStrings.join(' '));
      }
    }

    // Compter les pages
    while (pagePattern.exec(content) !== null) {
      pageCount++;
    }

    return {
      text: textLines.join('\n'),
      format: 'alto',
      pageCount: pageCount || undefined,
    };
  }

  /**
   * Parse un fichier PAGE XML (format standard pour HTR)
   */
  private parsePageXML(filePath: string): TranscriptionImportResult {
    const content = fs.readFileSync(filePath, 'utf-8');
    const textLines: string[] = [];

    // Extraire le texte des éléments <Unicode> dans les TextLine
    // Structure: <TextLine> ... <TextEquiv> <Unicode>texte</Unicode> </TextEquiv> </TextLine>
    const unicodePattern = /<Unicode>([^<]*)<\/Unicode>/gi;
    const pagePattern = /<Page\b/gi;

    let match;
    while ((match = unicodePattern.exec(content)) !== null) {
      const text = match[1].trim();
      if (text) {
        textLines.push(text);
      }
    }

    // Compter les pages
    let pageCount = 0;
    while (pagePattern.exec(content) !== null) {
      pageCount++;
    }

    return {
      text: textLines.join('\n'),
      format: 'page-xml',
      pageCount: pageCount || 1,
    };
  }

  /**
   * Lit un fichier texte brut
   */
  private parsePlainText(filePath: string): TranscriptionImportResult {
    const text = fs.readFileSync(filePath, 'utf-8');

    return {
      text: text.trim(),
      format: 'plain-text',
    };
  }
}

// MARK: - Factory

/**
 * Crée un nouveau TropyOCRPipeline
 */
export function createOCRPipeline(): TropyOCRPipeline {
  return new TropyOCRPipeline();
}

// MARK: - Supported Languages

/**
 * Langues supportées par Tesseract.js pour les documents historiques
 */
export const SUPPORTED_OCR_LANGUAGES = [
  { code: 'fra', name: 'Français' },
  { code: 'deu', name: 'Allemand' },
  { code: 'eng', name: 'Anglais' },
  { code: 'lat', name: 'Latin' },
  { code: 'ita', name: 'Italien' },
  { code: 'spa', name: 'Espagnol' },
  { code: 'por', name: 'Portugais' },
  { code: 'nld', name: 'Néerlandais' },
  { code: 'pol', name: 'Polonais' },
  { code: 'rus', name: 'Russe' },
  { code: 'grc', name: 'Grec ancien' },
  { code: 'heb', name: 'Hébreu' },
  { code: 'ara', name: 'Arabe' },
  { code: 'frm', name: 'Moyen français' },
  { code: 'deu_frak', name: 'Allemand Fraktur' },
] as const;

export type SupportedOCRLanguage = (typeof SUPPORTED_OCR_LANGUAGES)[number]['code'];
