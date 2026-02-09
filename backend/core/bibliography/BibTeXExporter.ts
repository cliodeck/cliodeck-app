import type { Citation } from '../../types/citation';
import * as fs from 'fs/promises';

/**
 * BibTeX Exporter
 *
 * Exports citations to BibTeX format, preserving all metadata including
 * custom fields, tags, keywords, and notes.
 */
export class BibTeXExporter {
  /**
   * Export citations to BibTeX file
   */
  async exportToFile(citations: Citation[], filePath: string): Promise<void> {
    const bibtexContent = this.exportToString(citations);
    await fs.writeFile(filePath, bibtexContent, 'utf-8');
  }

  /**
   * Export citations to BibTeX string
   */
  exportToString(citations: Citation[]): string {
    const entries: string[] = [];

    for (const citation of citations) {
      const entry = this.citationToBibTeX(citation);
      entries.push(entry);
    }

    return entries.join('\n\n') + '\n';
  }

  /**
   * Convert a single citation to BibTeX entry
   */
  private citationToBibTeX(citation: Citation): string {
    const lines: string[] = [];

    // Entry type and key
    lines.push(`@${citation.type}{${citation.key || citation.id},`);

    // Required fields
    lines.push(this.formatField('author', citation.author));
    lines.push(this.formatField('title', citation.title));
    lines.push(this.formatField('year', citation.year));

    // Optional standard fields
    if (citation.shortTitle) {
      lines.push(this.formatField('shorttitle', citation.shortTitle));
    }

    if (citation.journal) {
      lines.push(this.formatField('journal', citation.journal));
    }

    if (citation.publisher) {
      lines.push(this.formatField('publisher', citation.publisher));
    }

    if (citation.booktitle) {
      lines.push(this.formatField('booktitle', citation.booktitle));
    }

    // File path (if present)
    if (citation.file) {
      lines.push(this.formatField('file', citation.file));
    }

    // Tags (export as semicolon-separated list)
    if (citation.tags && citation.tags.length > 0) {
      const tagsString = citation.tags.join('; ');
      lines.push(this.formatField('tags', tagsString));
    }

    // Keywords
    if (citation.keywords) {
      lines.push(this.formatField('keywords', citation.keywords));
    }

    // Notes (export as note field)
    if (citation.notes) {
      lines.push(this.formatField('note', citation.notes));
    }

    // Zotero key (if present)
    if (citation.zoteroKey) {
      lines.push(this.formatField('zoterokey', citation.zoteroKey));
    }

    // Date metadata
    if (citation.dateAdded) {
      lines.push(this.formatField('dateadded', citation.dateAdded));
    }

    if (citation.dateModified) {
      lines.push(this.formatField('datemodified', citation.dateModified));
    }

    // Custom fields (preserve all non-standard fields)
    if (citation.customFields) {
      for (const [key, value] of Object.entries(citation.customFields)) {
        lines.push(this.formatField(key, value));
      }
    }

    // Close entry (remove trailing comma from last field)
    const lastLine = lines[lines.length - 1];
    if (lastLine.endsWith(',')) {
      lines[lines.length - 1] = lastLine.slice(0, -1);
    }

    lines.push('}');

    return lines.join('\n');
  }

  /**
   * Format a BibTeX field with proper escaping
   */
  private formatField(name: string, value: string): string {
    // Escape special characters in value
    const escapedValue = this.escapeValue(value);

    // Use braces for multi-word/special values, quotes for simple ones
    if (this.needsBraces(escapedValue)) {
      return `  ${name} = {${escapedValue}},`;
    } else {
      return `  ${name} = {${escapedValue}},`;
    }
  }

  /**
   * Escape special LaTeX characters in value
   */
  private escapeValue(value: string): string {
    let escaped = value;

    // Escape special LaTeX characters (but not Unicode characters)
    const escapeMap: Array<[string, string]> = [
      ['\\', '\\textbackslash{}'], // Must be first
      ['&', '\\&'],
      ['%', '\\%'],
      ['$', '\\$'],
      ['#', '\\#'],
      ['_', '\\_'],
      ['{', '\\{'],
      ['}', '\\}'],
    ];

    for (const [char, latex] of escapeMap) {
      escaped = escaped.replaceAll(char, latex);
    }

    return escaped;
  }

  /**
   * Check if value needs braces (always use braces for safety)
   */
  private needsBraces(value: string): boolean {
    // Always use braces for consistency and safety
    return true;
  }

  /**
   * Convert Unicode characters to LaTeX commands (optional, for maximum compatibility)
   */
  private unicodeToLatex(value: string): string {
    // This is optional - modern BibTeX processors handle Unicode well
    // Only convert if explicitly needed for old LaTeX systems

    const unicodeMap: Array<[string, string]> = [
      // Accent aigu (´)
      ['é', "\\'e"], ['É', "\\'E"],
      ['á', "\\'a"], ['Á', "\\'A"],
      ['í', "\\'i"], ['Í', "\\'I"],
      ['ó', "\\'o"], ['Ó', "\\'O"],
      ['ú', "\\'u"], ['Ú', "\\'U"],

      // Accent grave (`)
      ['è', '\\`e'], ['È', '\\`E'],
      ['à', '\\`a'], ['À', '\\`A'],
      ['ì', '\\`i'], ['Ì', '\\`I'],
      ['ò', '\\`o'], ['Ò', '\\`O'],
      ['ù', '\\`u'], ['Ù', '\\`U'],

      // Accent circonflexe (^)
      ['ê', '\\^e'], ['Ê', '\\^E'],
      ['â', '\\^a'], ['Â', '\\^A'],
      ['î', '\\^i'], ['Î', '\\^I'],
      ['ô', '\\^o'], ['Ô', '\\^O'],
      ['û', '\\^u'], ['Û', '\\^U'],

      // Tréma (¨)
      ['ë', '\\"e'], ['Ë', '\\"E'],
      ['ä', '\\"a'], ['Ä', '\\"A'],
      ['ï', '\\"i'], ['Ï', '\\"I'],
      ['ö', '\\"o'], ['Ö', '\\"O'],
      ['ü', '\\"u'], ['Ü', '\\"U'],
      ['ÿ', '\\"y'], ['Ÿ', '\\"Y'],

      // Tilde (~)
      ['ñ', '\\~n'], ['Ñ', '\\~N'],
      ['ã', '\\~a'], ['Ã', '\\~A'],
      ['õ', '\\~o'], ['Õ', '\\~O'],

      // Cédille
      ['ç', '\\c{c}'], ['Ç', '\\c{C}'],

      // Ligatures
      ['œ', '\\oe'], ['Œ', '\\OE'],
      ['æ', '\\ae'], ['Æ', '\\AE'],
      ['å', '\\aa'], ['Å', '\\AA'],
      ['ø', '\\o'], ['Ø', '\\O'],
      ['ł', '\\l'], ['Ł', '\\L'],
      ['ß', '\\ss'],
    ];

    let converted = value;
    for (const [unicode, latex] of unicodeMap) {
      converted = converted.replaceAll(unicode, latex);
    }

    return converted;
  }

  /**
   * Export citations with LaTeX-compatible encoding (converts Unicode to LaTeX commands)
   */
  exportToStringLegacy(citations: Citation[]): string {
    const entries: string[] = [];

    for (const citation of citations) {
      const entry = this.citationToBibTeXLegacy(citation);
      entries.push(entry);
    }

    return entries.join('\n\n') + '\n';
  }

  /**
   * Convert citation to BibTeX with Unicode → LaTeX conversion
   */
  private citationToBibTeXLegacy(citation: Citation): string {
    // Same as citationToBibTeX but applies unicodeToLatex to all values
    const lines: string[] = [];

    lines.push(`@${citation.type}{${citation.key || citation.id},`);

    // Convert all fields to LaTeX
    lines.push(this.formatFieldLegacy('author', citation.author));
    lines.push(this.formatFieldLegacy('title', citation.title));
    lines.push(this.formatFieldLegacy('year', citation.year));

    if (citation.shortTitle) {
      lines.push(this.formatFieldLegacy('shorttitle', citation.shortTitle));
    }

    if (citation.journal) {
      lines.push(this.formatFieldLegacy('journal', citation.journal));
    }

    if (citation.publisher) {
      lines.push(this.formatFieldLegacy('publisher', citation.publisher));
    }

    if (citation.booktitle) {
      lines.push(this.formatFieldLegacy('booktitle', citation.booktitle));
    }

    if (citation.file) {
      lines.push(this.formatField('file', citation.file)); // Don't convert file paths
    }

    if (citation.tags && citation.tags.length > 0) {
      const tagsString = citation.tags.join('; ');
      lines.push(this.formatFieldLegacy('tags', tagsString));
    }

    if (citation.keywords) {
      lines.push(this.formatFieldLegacy('keywords', citation.keywords));
    }

    if (citation.notes) {
      lines.push(this.formatFieldLegacy('note', citation.notes));
    }

    if (citation.zoteroKey) {
      lines.push(this.formatField('zoterokey', citation.zoteroKey));
    }

    if (citation.dateAdded) {
      lines.push(this.formatField('dateadded', citation.dateAdded));
    }

    if (citation.dateModified) {
      lines.push(this.formatField('datemodified', citation.dateModified));
    }

    if (citation.customFields) {
      for (const [key, value] of Object.entries(citation.customFields)) {
        lines.push(this.formatFieldLegacy(key, value));
      }
    }

    const lastLine = lines[lines.length - 1];
    if (lastLine.endsWith(',')) {
      lines[lines.length - 1] = lastLine.slice(0, -1);
    }

    lines.push('}');

    return lines.join('\n');
  }

  /**
   * Format field with Unicode → LaTeX conversion
   */
  private formatFieldLegacy(name: string, value: string): string {
    const convertedValue = this.unicodeToLatex(value);
    const escapedValue = this.escapeValue(convertedValue);
    return `  ${name} = {${escapedValue}},`;
  }
}
