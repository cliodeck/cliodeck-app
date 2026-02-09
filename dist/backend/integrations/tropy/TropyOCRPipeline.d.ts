export interface OCROptions {
    language: string;
    oem?: number;
}
export interface OCRResult {
    text: string;
    confidence: number;
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
/**
 * Pipeline OCR pour les sources primaires Tropy
 * Supporte:
 * - OCR avec Tesseract.js (texte imprimé)
 * - Import de transcriptions externes (Transkribus, ALTO, PAGE XML, texte brut)
 */
export declare class TropyOCRPipeline {
    private tesseractWorker;
    private isInitialized;
    private pdfConverter;
    /**
     * Initialise le worker Tesseract.js
     * @param language Langue pour l'OCR (default: 'fra')
     */
    initialize(language?: string): Promise<void>;
    /**
     * Change la langue du worker Tesseract
     */
    setLanguage(language: string): Promise<void>;
    /**
     * Check if a file is a PDF
     */
    isPDF(filePath: string): boolean;
    /**
     * Get or create PDF converter instance
     */
    private getPDFConverter;
    /**
     * Effectue l'OCR sur une image ou un PDF
     * @param filePath Chemin vers l'image ou le PDF
     * @param options Options OCR
     * @returns Texte extrait avec score de confiance
     */
    performOCR(filePath: string, options?: OCROptions): Promise<OCRResult>;
    /**
     * Effectue l'OCR sur un fichier PDF
     * Convertit chaque page en image puis applique l'OCR
     * @param pdfPath Chemin vers le PDF
     * @param options Options OCR
     * @returns Texte combiné de toutes les pages avec confiance moyenne
     */
    performPDFOCR(pdfPath: string, options?: OCROptions): Promise<OCRResult>;
    /**
     * Effectue l'OCR sur plusieurs fichiers (images ou PDF) et concatène les résultats
     * @param filePaths Liste des chemins de fichiers (images ou PDF)
     * @param options Options OCR
     * @returns Texte combiné avec confiance moyenne
     */
    performBatchOCR(filePaths: string[], options?: OCROptions): Promise<OCRResult>;
    /**
     * Importe une transcription externe
     * @param config Configuration d'import
     * @returns Texte importé
     */
    importTranscription(config: TranscriptionImportConfig): Promise<TranscriptionImportResult>;
    /**
     * Détecte automatiquement le format d'un fichier de transcription
     */
    detectFormat(filePath: string): TranscriptionFormat | null;
    /**
     * Termine le worker Tesseract
     */
    dispose(): Promise<void>;
    /**
     * Parse un export Transkribus (format XML propriétaire ou PAGE XML)
     */
    private parseTranskribusExport;
    /**
     * Parse un fichier ALTO XML (standard de la BnF, etc.)
     * ALTO = Analyzed Layout and Text Object
     */
    private parseALTO;
    /**
     * Parse un fichier PAGE XML (format standard pour HTR)
     */
    private parsePageXML;
    /**
     * Lit un fichier texte brut
     */
    private parsePlainText;
}
/**
 * Crée un nouveau TropyOCRPipeline
 */
export declare function createOCRPipeline(): TropyOCRPipeline;
/**
 * Langues supportées par Tesseract.js pour les documents historiques
 */
export declare const SUPPORTED_OCR_LANGUAGES: readonly [{
    readonly code: "fra";
    readonly name: "Français";
}, {
    readonly code: "deu";
    readonly name: "Allemand";
}, {
    readonly code: "eng";
    readonly name: "Anglais";
}, {
    readonly code: "lat";
    readonly name: "Latin";
}, {
    readonly code: "ita";
    readonly name: "Italien";
}, {
    readonly code: "spa";
    readonly name: "Espagnol";
}, {
    readonly code: "por";
    readonly name: "Portugais";
}, {
    readonly code: "nld";
    readonly name: "Néerlandais";
}, {
    readonly code: "pol";
    readonly name: "Polonais";
}, {
    readonly code: "rus";
    readonly name: "Russe";
}, {
    readonly code: "grc";
    readonly name: "Grec ancien";
}, {
    readonly code: "heb";
    readonly name: "Hébreu";
}, {
    readonly code: "ara";
    readonly name: "Arabe";
}, {
    readonly code: "frm";
    readonly name: "Moyen français";
}, {
    readonly code: "deu_frak";
    readonly name: "Allemand Fraktur";
}];
export type SupportedOCRLanguage = (typeof SUPPORTED_OCR_LANGUAGES)[number]['code'];
