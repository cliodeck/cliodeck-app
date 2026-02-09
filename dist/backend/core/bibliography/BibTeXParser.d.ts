import type { Citation } from '../../types/citation';
export declare class BibTeXParser {
    parseFile(filePath: string): Citation[];
    parse(content: string, bibDir?: string): Citation[];
    private findMatchingBrace;
    private parseFields;
    private cleanValue;
    private createCitation;
    private resolveFilePath;
    private extractYear;
}
