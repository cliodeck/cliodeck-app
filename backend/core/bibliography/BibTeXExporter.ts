import type { Citation } from '../../types/citation';
import * as fs from 'fs/promises';

/**
 * Champs que BibLaTeX — et pandoc, qui lit les `.bib` en BibLaTeX — prend
 * tels quels. Les échapper à la LaTeX les corrompt : mesuré avec pandoc 3.9,
 * `a\_b?x=1\&y=2` reste littéralement `a\_b?x=1\&y=2` dans l'URL
 * produite. Seules les accolades, qui délimitent la valeur, doivent être
 * neutralisées — par encodage d'URL, qui ne change pas l'adresse.
 */
export const VERBATIM_FIELDS = new Set(['url', 'doi', 'eprint', 'date', 'urldate']);

/**
 * Champs à tiret de BibDesk qui portent une adresse ou un fichier : `bdsk-url-1`, `bdsk-url-2`…,
 * `bdsk-file-1`… (un alias en base64), et `local-url`, où d'anciennes versions de BibDesk
 * rangeaient le fichier lié. Lus depuis que les noms à tiret le sont (S07-1-14), ils passaient par
 * le nettoyage LaTeX puis par l'échappement : la première réécriture abîmait l'adresse (`~` en
 * espace, `--` en tiret demi-cadratin, `_` en `\_`).
 */
const BIBDESK_VERBATIM = /^(?:bdsk-(?:url|file)-\d+|local-url)$/;

/**
 * Champ lu et écrit tel quel : ceux de {@link VERBATIM_FIELDS} et les adresses de BibDesk. Une
 * seule règle pour le parseur et l'exporteur, sans égard à la casse (BibDesk écrit `Bdsk-Url-1`).
 */
export function isVerbatimField(name: string): boolean {
  const lower = name.toLowerCase();
  return VERBATIM_FIELDS.has(lower) || BIBDESK_VERBATIM.test(lower);
}

/**
 * Valeur verbatim écrivable entre accolades : les accolades, qui
 * délimiteraient la valeur, sont encodées comme dans une URL.
 */
export function verbatimSafe(value: string): string {
  return value.trim().replaceAll('{', '%7B').replaceAll('}', '%7D');
}

/**
 * Caractères spéciaux de LaTeX et leur forme échappée, appliqués en un seul passage : échapper
 * d'abord `\` en `\textbackslash{}`, puis toutes les accolades, échappait aussi les siennes
 * (`\textbackslash\{\}`), que la relecture ne savait pas défaire — un `\textbackslash` de plus à
 * chaque réécriture (S07-1-30). `~` serait relu comme une espace insécable.
 */
const LATEX_ESCAPES: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '&': '\\&',
  '%': '\\%',
  '$': '\\$',
  '#': '\\#',
  '_': '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
};

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
    // `author` est omis quand il est vide : un ouvrage dirigé n'a pas
    // d'auteur, et `author = {}` ferait afficher une parenthèse vide par
    // pandoc au lieu de laisser la main au champ `editor`.
    if (citation.author) {
      lines.push(this.formatField('author', citation.author));
    }
    if (citation.editor) {
      lines.push(this.formatField('editor', citation.editor));
    }
    lines.push(this.formatField('title', citation.title));
    // Une notice sans date n'écrit pas `year = {}` : pandoc l'afficherait
    // vide, et la relecture ne saurait qu'en faire.
    if (citation.year) {
      lines.push(this.formatField('year', citation.year));
    }

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
      lines.push(this.formatFileField(citation.file));
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
        lines.push(this.formatCustomField(key, value));
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
   * Champ libre : verbatim pour ceux que BibLaTeX lit tels quels et pour les adresses de BibDesk
   * (cf. {@link isVerbatimField}), échappé pour les autres.
   */
  private formatCustomField(name: string, value: string): string {
    if (isVerbatimField(name)) {
      return `  ${name} = {${verbatimSafe(value)}},`;
    }
    return this.formatField(name, value);
  }

  /**
   * Chemin du PDF, verbatim comme les champs de {@link VERBATIM_FIELDS} : l'échappement LaTeX le
   * corrompait à la relecture (S07-1-16). Barres obliques normales, que Windows accepte : `\`
   * serait relu comme un échappement. Pas de {@link verbatimSafe}, dont le `%7B` changerait le
   * nom du fichier : une accolade, qui déséquilibrerait l'entrée, s'écrit `\{` ou `\}`.
   */
  private formatFileField(filePath: string): string {
    const written = filePath.replaceAll('\\', '/').replace(/[{}]/g, (brace) => `\\${brace}`);
    return `  file = {${written}},`;
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
    // Escape special LaTeX characters (but not Unicode characters), cf. LATEX_ESCAPES
    return value.replace(/[\\&%$#_{}~]/g, (char) => LATEX_ESCAPES[char]);
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
    if (citation.author) {
      lines.push(this.formatFieldLegacy('author', citation.author));
    }
    if (citation.editor) {
      lines.push(this.formatFieldLegacy('editor', citation.editor));
    }
    lines.push(this.formatFieldLegacy('title', citation.title));
    if (citation.year) {
      lines.push(this.formatFieldLegacy('year', citation.year));
    }

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
      lines.push(this.formatFileField(citation.file)); // Don't convert file paths
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
        lines.push(
          isVerbatimField(key)
            ? this.formatCustomField(key, value)
            : this.formatFieldLegacy(key, value)
        );
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
