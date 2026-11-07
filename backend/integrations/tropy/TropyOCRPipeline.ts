import * as fs from 'fs';
import * as path from 'path';
import type { RecognizeResult, Worker as TesseractWorker } from 'tesseract.js';
import { PDFConverter, PopplerNotFoundError, createPDFConverter } from './PDFConverter';

// MARK: - Types

export interface OCROptions {
  language: string; // ISO 639-2 codes: 'fra', 'deu', 'eng', 'lat', etc.
  oem?: number; // OCR Engine Mode (0-3), default 3 (LSTM)
}

export interface OCRResult {
  text: string;
  confidence: number; // 0-100, pondérée par la longueur du texte de chaque page
  language: string;
  /**
   * Pages passées à la reconnaissance : une par image, une par page de PDF
   * reconnue. Tropy crée une photo par page d'un PDF, toutes sur le même
   * fichier : compter les fichiers annonçait 1 page pour un registre de 120.
   */
  pageCount: number;
  /** Un outil manquait pour une partie des fichiers (les PDF, sans Poppler) : le texte est partiel. */
  missingTool?: 'poppler';
}

export interface TropyOCRPipelineOptions {
  /**
   * Dossier des modèles de langue. Sans lui, tesseract.js les range dans le
   * dossier courant du processus : `/` pour l'app lancée du Finder, non
   * inscriptible — le modèle se retéléchargeait à chaque session, et une salle
   * d'archives sans réseau suffisait à bloquer l'OCR (S08-1-29).
   */
  cachePath?: string;
  /** Délai laissé au moteur pour démarrer, téléchargement du modèle compris. */
  initTimeoutMs?: number;
}

/** De quoi télécharger un modèle de quelques Mo sur un réseau lent ; hors ligne, l'échec arrive bien avant. */
const DEFAULT_INIT_TIMEOUT_MS = 120_000;

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

/**
 * Le moteur ne démarre pas dans cette langue : modèle introuvable (hors ligne,
 * ou langue que le dépôt de tesseract.js ne connaît pas), ou aucune réponse
 * dans le délai. Vaut pour tous les fichiers de la passe, pas pour un seul.
 */
export class OcrEngineUnavailableError extends Error {
  constructor(
    readonly language: string,
    reason: unknown
  ) {
    super(`OCR engine unavailable for language "${language}": ${String(reason)}`);
    this.name = 'OcrEngineUnavailableError';
  }
}

/** Le moteur a été arrêté (changement de projet) pendant qu'on l'attendait. */
export class OcrEngineStoppedError extends Error {
  constructor() {
    super('OCR engine stopped while recognition was in progress (project closed)');
    this.name = 'OcrEngineStoppedError';
  }
}

/**
 * Confiance d'un ensemble de pages, pondérée par la longueur de leur texte.
 * Tesseract rend 0 pour une page blanche : comptée comme une autre, elle
 * tirait la moyenne vers le bas, et trois versos blancs faisaient jeter, sous
 * le seuil de la synchronisation, l'OCR d'un recto bien lu (S08-2-1). Sans
 * aucun texte, 0 : rien n'a été lu.
 */
function weightedConfidence(results: ReadonlyArray<{ text: string; confidence: number }>): number {
  let weight = 0;
  let sum = 0;
  for (const { text, confidence } of results) {
    weight += text.length;
    sum += confidence * text.length;
  }
  return weight > 0 ? sum / weight : 0;
}

/** Le dossier courant, ou rien s'il a disparu (un terminal dans un dossier supprimé). */
function currentDirectory(): string | null {
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

// MARK: - TropyOCRPipeline

/**
 * Pipeline OCR pour les sources primaires Tropy
 * Supporte:
 * - OCR avec Tesseract.js (texte imprimé)
 * - Import de transcriptions externes (Transkribus, ALTO, PAGE XML, texte brut)
 */
export class TropyOCRPipeline {
  private tesseractWorker: TesseractWorker | null = null;
  private isInitialized: boolean = false;
  /** La langue du moteur en marche : `recognize` n'en prend pas, elle se fixe au démarrage. */
  private engineLanguage: string | null = null;
  private pdfConverter: PDFConverter | null = null;
  private readonly cachePath: string | undefined;
  private readonly initTimeoutMs: number;
  /** Où tesseract.js rangeait les modèles sans `cachePath` : son `'.'`, le dossier courant. */
  private readonly legacyCachePath = currentDirectory();
  /**
   * Ce qui attend le moteur (démarrage, reconnaissance) : `dispose` le rejette.
   * `terminate` ne règle pas une reconnaissance en cours, qui attendrait sinon
   * pour toujours un moteur détruit.
   */
  private readonly waiting = new Set<() => void>();

  constructor(options: TropyOCRPipelineOptions = {}) {
    this.cachePath = options.cachePath;
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
  }

  /**
   * Initialise le worker Tesseract.js dans cette langue. Un moteur qui tourne
   * dans une autre est arrêté, et un neuf démarre.
   * @param language Langue pour l'OCR (default: 'fra')
   */
  async initialize(language: string = 'fra'): Promise<void> {
    if (this.isInitialized) {
      if (this.engineLanguage === language) return;
      // Le moteur gardait la langue du premier appel : un fonds allemand
      // relancé en « Allemand » repassait au modèle français (S08-1-5).
      // Un moteur neuf plutôt que `reinitialize` : tesseract.js 7 y tient la
      // langue pour chargée avant de l'avoir chargée, et son second essai d'un
      // modèle introuvable arrête le moteur en marche puis lève dans son
      // gestionnaire de messages, hors de toute promesse — mesuré, de quoi
      // faire tomber le processus. Il n'a, de plus, ni délai ni erreur typée.
      // Un démarrage coûte quelques dizaines de millisecondes, modèle en
      // cache, une fois par changement de langue.
      await this.dispose();
    }

    const Tesseract = await import('tesseract.js');
    this.prepareCache();

    // Modèle introuvable (hors ligne, langue absente du dépôt) : tesseract.js 7
    // ne règle jamais la promesse de `createWorker` et ne prévient que
    // `errorHandler` — sans lui, il lève dans son gestionnaire de messages.
    // D'où le gestionnaire, et un délai contre le silence.
    this.tesseractWorker = await new Promise<TesseractWorker>((resolve, reject) => {
      let settled = false;
      const settle = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiting.delete(stop);
        outcome();
      };
      const fail = (reason: unknown): void => settle(() => reject(new OcrEngineUnavailableError(language, reason)));
      const stop = (): void => settle(() => reject(new OcrEngineStoppedError()));
      const timer = setTimeout(() => fail(`no answer after ${this.initTimeoutMs} ms`), this.initTimeoutMs);
      this.waiting.add(stop);

      Tesseract.createWorker(language, 1, {
        cachePath: this.cachePath,
        errorHandler: (data: unknown) => {
          if (settled) console.warn('⚠️ Tesseract:', data);
          else fail(data);
        },
      }).then(
        (worker) => {
          // Arrivé après le délai ou l'arrêt : personne ne s'en servira.
          if (settled) void worker.terminate();
          else settle(() => resolve(worker));
        },
        fail
      );
    });

    this.isInitialized = true;
    this.engineLanguage = language;
    console.log(`🔤 OCR initialized with language: ${language}`);
  }

  /**
   * Crée le dossier des modèles. À sa création — une fois, à la première OCR
   * après la mise à jour —, il reprend les modèles déjà téléchargés dans
   * l'ancien emplacement, sans les déplacer : un historien qui les avait n'a
   * pas besoin du réseau pour sa première OCR. Un modèle repris mais illisible
   * est effacé par tesseract.js, qui le retélécharge ensuite.
   */
  private prepareCache(): void {
    const cachePath = this.cachePath;
    if (!cachePath || fs.existsSync(cachePath)) return;
    try {
      fs.mkdirSync(cachePath, { recursive: true });
      if (!this.legacyCachePath || path.resolve(this.legacyCachePath) === path.resolve(cachePath)) return;
      for (const { code } of SUPPORTED_OCR_LANGUAGES) {
        const legacy = path.join(this.legacyCachePath, `${code}.traineddata`);
        if (fs.existsSync(legacy) && fs.statSync(legacy).isFile()) {
          fs.copyFileSync(legacy, path.join(cachePath, `${code}.traineddata`));
        }
      }
    } catch (error) {
      // Sans dossier, tesseract.js retélécharge le modèle : l'OCR marche en ligne.
      console.warn(`⚠️ OCR model cache unavailable (${cachePath}):`, error);
    }
  }

  /** Reconnaissance qui s'arrête avec le moteur au lieu de l'attendre. */
  private recognize(filePath: string): Promise<RecognizeResult> {
    const worker = this.tesseractWorker;
    if (!worker) return Promise.reject(new OcrEngineStoppedError());
    return new Promise((resolve, reject) => {
      const stop = (): void => reject(new OcrEngineStoppedError());
      this.waiting.add(stop);
      worker.recognize(filePath).then(resolve, reject).finally(() => this.waiting.delete(stop));
    });
  }

  /**
   * Change la langue du worker Tesseract : un moteur neuf (voir `initialize`).
   */
  async setLanguage(language: string): Promise<void> {
    await this.initialize(language);
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

    // Le moteur, dans la langue demandée
    await this.initialize(language);

    try {
      console.log(`🔍 Performing OCR on: ${path.basename(filePath)}`);

      const result = await this.recognize(filePath);

      return {
        text: result.data.text.trim(),
        confidence: result.data.confidence,
        language,
        pageCount: 1,
      };
    } catch (error) {
      if (error instanceof OcrEngineStoppedError) throw error;
      console.error('OCR failed:', error);
      throw new Error(`OCR failed for ${filePath}: ${error}`);
    }
  }

  /**
   * Effectue l'OCR sur un fichier PDF
   * Convertit chaque page en image puis applique l'OCR
   * @param pdfPath Chemin vers le PDF
   * @param options Options OCR
   * @returns Texte combiné des pages, confiance pondérée et pages reconnues
   */
  async performPDFOCR(pdfPath: string, options?: OCROptions): Promise<OCRResult> {
    const language = options?.language || 'fra';

    console.log(`📄 Performing OCR on PDF: ${path.basename(pdfPath)}`);

    // Le moteur avant la conversion, dans la langue demandée : un moteur qui
    // ne démarre pas ne coûte pas une conversion à 300 dpi par PDF (S08-1-13).
    await this.initialize(language);

    // Initialiser le convertisseur PDF
    const pdfConverter = await this.getPDFConverter();

    // Convertir le PDF en fichiers temporaires
    let tempResult: { tempDir: string; files: string[]; pageCount: number };
    try {
      tempResult = await pdfConverter.convertToTempFiles(pdfPath, {
        dpi: 300, // Bonne qualité pour OCR
      });
    } catch (error) {
      if (error instanceof PopplerNotFoundError) throw error;
      console.error('PDF conversion failed:', error);
      throw new Error(`Failed to convert PDF ${pdfPath}: ${error}`);
    }

    console.log(`📄 PDF converted: ${tempResult.pageCount} pages`);

    // Effectuer l'OCR sur chaque page. Le numéro voyage avec le texte : une
    // page en échec, sautée, décalait d'un cran toutes les suivantes (S08-1-12).
    const pages: Array<{ page: number; text: string; confidence: number }> = [];
    try {
      for (let i = 0; i < tempResult.files.length; i++) {
        const pageFile = tempResult.files[i];
        try {
          console.log(`  📃 OCR page ${i + 1}/${tempResult.files.length}`);
          const result = await this.recognize(pageFile);
          pages.push({
            page: i + 1,
            text: result.data.text.trim(),
            confidence: result.data.confidence,
          });
        } catch (error) {
          if (error instanceof OcrEngineStoppedError) throw error;
          console.warn(`⚠️ OCR failed for page ${i + 1}: ${error}`);
        }
      }
    } finally {
      // Nettoyer les fichiers temporaires, même sur un moteur arrêté
      pdfConverter.cleanupTempFiles(tempResult.tempDir);
    }

    // Combiner les textes des pages. Une page blanche n'a rien à citer : sans
    // en-tête, elle ne laisse pas un « --- Page 1 --- » seul passer pour une
    // transcription.
    const combinedText = pages
      .filter((p) => p.text)
      .map((p) => `--- Page ${p.page} ---\n\n${p.text}`)
      .join('\n\n');
    const confidence = weightedConfidence(pages);

    console.log(`📄 PDF OCR completed: ${pages.length} pages, confidence: ${confidence.toFixed(1)}%`);

    return {
      text: combinedText,
      confidence,
      language,
      pageCount: pages.length,
    };
  }

  /**
   * Effectue l'OCR sur plusieurs fichiers (images ou PDF) et concatène les résultats
   * @param filePaths Liste des chemins de fichiers (images ou PDF)
   * @param options Options OCR
   * @returns Texte combiné, confiance pondérée et pages reconnues
   */
  async performBatchOCR(
    filePaths: string[],
    options?: OCROptions
  ): Promise<OCRResult> {
    // Deduplicate file paths to avoid processing the same file multiple times
    const uniquePaths = [...new Set(filePaths)];
    const results: OCRResult[] = [];
    let popplerMissing: PopplerNotFoundError | null = null;

    for (const filePath of uniquePaths) {
      try {
        // performOCR gère automatiquement les PDF et les images
        const result = await this.performOCR(filePath, options);
        results.push(result);
      } catch (error) {
        // Un moteur qui ne démarre pas, ou arrêté, vaut pour tous les fichiers.
        if (error instanceof OcrEngineUnavailableError || error instanceof OcrEngineStoppedError) throw error;
        // Poppler manquant n'est pas l'échec d'un fichier : c'est un outil
        // absent pour tous les PDF. Les images passent quand même ; l'outil
        // manquant est rendu avec elles, pour que la synchronisation le dise
        // au lieu de conclure « pas de texte » (#138).
        if (error instanceof PopplerNotFoundError) {
          popplerMissing = error;
          continue;
        }
        console.warn(`Skipping ${filePath}: ${error}`);
      }
    }

    if (results.length === 0) {
      // Rien de reconnu : l'outil manquant est tout ce qu'il y a à dire.
      if (popplerMissing) throw popplerMissing;
      return {
        text: '',
        confidence: 0,
        language: options?.language || 'fra',
        pageCount: 0,
      };
    }

    // Combiner les textes ; un fichier blanc n'ajouterait qu'un séparateur.
    const combinedText = results
      .filter((r) => r.text)
      .map((r) => r.text)
      .join('\n\n---\n\n');

    return {
      text: combinedText,
      confidence: weightedConfidence(results),
      language: results[0].language,
      // Un PDF illisible, sauté, ou sans Poppler ne compte pas : il n'a pas été reconnu.
      pageCount: results.reduce((sum, r) => sum + r.pageCount, 0),
      ...(popplerMissing ? { missingTool: 'poppler' as const } : {}),
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
    const waiting = [...this.waiting];
    this.waiting.clear();
    try {
      if (this.tesseractWorker) {
        const worker = this.tesseractWorker;
        this.tesseractWorker = null;
        this.isInitialized = false;
        this.engineLanguage = null;
        await worker.terminate();
        console.log('🔤 OCR worker terminated');
      }
    } finally {
      for (const stop of waiting) stop();
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
    const currentLine: string[] = [];
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
  // 'frk' : le modèle LSTM du Fraktur. 'deu_frak' n'existait que dans les
  // données 3.x de Tesseract, absentes du dépôt de tesseract.js (S08-2-3).
  { code: 'frk', name: 'Allemand Fraktur' },
] as const;

export type SupportedOCRLanguage = (typeof SUPPORTED_OCR_LANGUAGES)[number]['code'];
