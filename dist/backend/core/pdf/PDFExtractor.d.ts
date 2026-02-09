import type { DocumentPage, PDFMetadata } from '../../types/pdf-document';
export interface PDFStatistics {
    pageCount: number;
    totalWords: number;
    totalCharacters: number;
    averageWordsPerPage: number;
    nonEmptyPages: number;
}
export declare class PDFExtractor {
    extractDocument(filePath: string): Promise<{
        pages: DocumentPage[];
        metadata: PDFMetadata;
        title: string;
    }>;
    private extractMetadata;
    private parsePDFDate;
    private extractTitle;
    private cleanTitle;
    extractAuthor(filePath: string): Promise<string | undefined>;
    extractYear(filePath: string): Promise<string | undefined>;
    getPageCount(filePath: string): Promise<number | null>;
    extractText(filePath: string, pageNumber: number): Promise<string>;
    isPDFValid(filePath: string): boolean;
    getStatistics(filePath: string): Promise<PDFStatistics>;
}
