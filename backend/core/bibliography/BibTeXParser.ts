import * as fs from 'fs';
import * as path from 'path';
import type { Citation } from '../../types/citation';
import { createCitation } from '../../types/citation';

export class BibTeXParser {
  /**
   * Entrées rejetées lors du DERNIER parse (réinitialisé à chaque appel).
   * Un import qui perd des entrées ne doit plus être silencieux : les
   * appelants peuvent journaliser/afficher ce compte (#32).
   */
  private rejected: Array<{ key: string; reason: 'missing-title' }> = [];

  get lastRejected(): ReadonlyArray<{ key: string; reason: 'missing-title' }> {
    return this.rejected;
  }

  // Parse un fichier BibTeX et retourne une liste de citations
  parseFile(filePath: string): Citation[] {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const bibDir = path.dirname(path.resolve(filePath));
      return this.parse(content, bibDir);
    } catch (error) {
      console.error(`❌ Erreur lecture fichier BibTeX: ${error}`);
      return [];
    }
  }

  // Parse le contenu d'un fichier BibTeX
  // bibDir: répertoire de base pour résoudre les chemins relatifs des fichiers
  parse(content: string, bibDir?: string): Citation[] {
    this.rejected = [];
    const citations: Citation[] = [];

    // ✅ APPROCHE SIMPLIFIÉE : Trouver chaque @type{key, et parser jusqu'au } correspondant
    let currentIndex = 0;

    while (currentIndex < content.length) {
      // Chercher @type{
      const atIndex = content.indexOf('@', currentIndex);
      if (atIndex === -1) break;

      currentIndex = atIndex + 1;

      // Extraire le type
      const openBraceIndex = content.indexOf('{', currentIndex);
      if (openBraceIndex === -1) continue;

      const typeString = content.slice(currentIndex, openBraceIndex).trim();

      // Ignorer @comment, @string, @preamble
      if (['comment', 'string', 'preamble'].includes(typeString.toLowerCase())) {
        currentIndex = openBraceIndex + 1;
        continue;
      }

      currentIndex = openBraceIndex + 1;

      // Trouver la virgule après la clé
      const commaIndex = content.indexOf(',', currentIndex);
      if (commaIndex === -1) continue;

      const key = content.slice(currentIndex, commaIndex).trim();

      currentIndex = commaIndex + 1;

      // Trouver le } fermant (en comptant les accolades)
      const closingBraceIndex = this.findMatchingBrace(content, openBraceIndex);
      if (closingBraceIndex === -1) continue;

      const fieldsString = content.slice(commaIndex + 1, closingBraceIndex);

      // Parser les champs
      const fields = this.parseFields(fieldsString);

      // Créer la citation
      const citation = this.createCitation(typeString, key, fields, bibDir);
      if (citation) {
        citations.push(citation);
      }

      currentIndex = closingBraceIndex + 1;
    }

    console.log(`✅ ${citations.length} références chargées depuis le fichier BibTeX`);
    return citations;
  }

  // Trouve l'accolade fermante correspondante
  private findMatchingBrace(content: string, startIndex: number): number {
    let braceCount = 1;
    let i = startIndex + 1;

    while (i < content.length && braceCount > 0) {
      if (content[i] === '{') {
        braceCount++;
      } else if (content[i] === '}') {
        braceCount--;
      }

      if (braceCount === 0) {
        return i;
      }

      i++;
    }

    return -1;
  }

  // Parse les champs d'une entrée BibTeX de manière robuste
  private parseFields(fieldsString: string): Record<string, string> {
    const fields: Record<string, string> = {};

    let currentIndex = 0;

    while (currentIndex < fieldsString.length) {
      // Chercher "nom ="
      const equalsIndex = fieldsString.indexOf('=', currentIndex);
      if (equalsIndex === -1) break;

      // Extraire le nom du champ
      const fieldName = fieldsString
        .slice(currentIndex, equalsIndex)
        .trim()
        .toLowerCase();

      // Ignorer si pas un nom valide
      if (!fieldName || !/^[a-z0-9_]+$/i.test(fieldName)) {
        currentIndex = equalsIndex + 1;
        continue;
      }

      currentIndex = equalsIndex + 1;

      // Passer les espaces après le =
      while (currentIndex < fieldsString.length && /\s/.test(fieldsString[currentIndex])) {
        currentIndex++;
      }

      if (currentIndex >= fieldsString.length) break;

      // Déterminer le type de valeur
      const firstChar = fieldsString[currentIndex];
      let value = '';

      if (firstChar === '{') {
        // Valeur entre accolades
        const closingBrace = this.findMatchingBrace(fieldsString, currentIndex);
        if (closingBrace !== -1) {
          value = fieldsString.slice(currentIndex + 1, closingBrace);
          currentIndex = closingBrace + 1;
        }
      } else if (firstChar === '"') {
        // Valeur entre guillemets
        currentIndex++;
        const quoteEnd = fieldsString.indexOf('"', currentIndex);
        if (quoteEnd !== -1) {
          value = fieldsString.slice(currentIndex, quoteEnd);
          currentIndex = quoteEnd + 1;
        }
      } else {
        // Valeur brute (nombre, variable) jusqu'à la virgule ou fin
        let endIndex = currentIndex;
        while (endIndex < fieldsString.length) {
          const char = fieldsString[endIndex];
          if (char === ',' || char === '\n' || char === '\r') {
            break;
          }
          endIndex++;
        }
        value = fieldsString.slice(currentIndex, endIndex).trim();
        currentIndex = endIndex;
      }

      // Nettoyer et stocker la valeur
      if (value) {
        fields[fieldName] = this.cleanValue(value);
      }

      // Passer au champ suivant (chercher la virgule)
      while (currentIndex < fieldsString.length) {
        if (fieldsString[currentIndex] === ',') {
          currentIndex++;
          break;
        }
        currentIndex++;
      }
    }

    return fields;
  }

  // ✅ Nettoie une valeur BibTeX (convertit les commandes LaTeX en Unicode)
  private cleanValue(value: string): string {
    let cleaned = value;

    // ⚠️ IMPORTANT : L'ordre est crucial !
    // On traite d'abord les variantes avec accolades (plus spécifiques)
    // puis les variantes simples (plus générales)

    // 1. Variantes avec accolades : {\'e} -> é, {\'{e}} -> é
    const bracedAccentMap: Array<[string, string]> = [
      // Accent aigu avec accolades
      ["{\\'{e}}", 'é'], ["{\\'{E}}", 'É'],
      ["{\\'{a}}", 'á'], ["{\\'{A}}", 'Á'],
      ["{\\'{i}}", 'í'], ["{\\'{I}}", 'Í'],
      ["{\\'{o}}", 'ó'], ["{\\'{O}}", 'Ó'],
      ["{\\'{u}}", 'ú'], ["{\\'{U}}", 'Ú'],
      ["{\\'e}", 'é'], ["{\\'E}", 'É'],
      ["{\\'a}", 'á'], ["{\\'A}", 'Á'],
      ["{\\'i}", 'í'], ["{\\'I}", 'Í'],
      ["{\\'o}", 'ó'], ["{\\'O}", 'Ó'],
      ["{\\'u}", 'ú'], ["{\\'U}", 'Ú'],

      // Accent grave avec accolades
      ["{\\`{e}}", 'è'], ["{\\`{E}}", 'È'],
      ["{\\`{a}}", 'à'], ["{\\`{A}}", 'À'],
      ["{\\`{i}}", 'ì'], ["{\\`{I}}", 'Ì'],
      ["{\\`{o}}", 'ò'], ["{\\`{O}}", 'Ò'],
      ["{\\`{u}}", 'ù'], ["{\\`{U}}", 'Ù'],
      ["{\\`e}", 'è'], ["{\\`E}", 'È'],
      ["{\\`a}", 'à'], ["{\\`A}", 'À'],
      ["{\\`i}", 'ì'], ["{\\`I}", 'Ì'],
      ["{\\`o}", 'ò'], ["{\\`O}", 'Ò'],
      ["{\\`u}", 'ù'], ["{\\`U}", 'Ù'],

      // Circonflexe avec accolades
      ["{\\^{e}}", 'ê'], ["{\\^{E}}", 'Ê'],
      ["{\\^{a}}", 'â'], ["{\\^{A}}", 'Â'],
      ["{\\^{i}}", 'î'], ["{\\^{I}}", 'Î'],
      ["{\\^{o}}", 'ô'], ["{\\^{O}}", 'Ô'],
      ["{\\^{u}}", 'û'], ["{\\^{U}}", 'Û'],
      ["{\\^e}", 'ê'], ["{\\^E}", 'Ê'],
      ["{\\^a}", 'â'], ["{\\^A}", 'Â'],
      ["{\\^i}", 'î'], ["{\\^I}", 'Î'],
      ["{\\^o}", 'ô'], ["{\\^O}", 'Ô'],
      ["{\\^u}", 'û'], ["{\\^U}", 'Û'],

      // Tréma avec accolades
      ['{\\"e}', 'ë'], ['{\\"E}', 'Ë'],
      ['{\\"a}', 'ä'], ['{\\"A}', 'Ä'],
      ['{\\"i}', 'ï'], ['{\\"I}', 'Ï'],
      ['{\\"o}', 'ö'], ['{\\"O}', 'Ö'],
      ['{\\"u}', 'ü'], ['{\\"U}', 'Ü'],
      ['{\\"y}', 'ÿ'], ['{\\"Y}', 'Ÿ'],
      ['{\\\"{e}}', 'ë'], ['{\\\"{E}}', 'Ë'],
      ['{\\\"{a}}', 'ä'], ['{\\\"{A}}', 'Ä'],
      ['{\\\"{i}}', 'ï'], ['{\\\"{I}}', 'Ï'],
      ['{\\\"{o}}', 'ö'], ['{\\\"{O}}', 'Ö'],
      ['{\\\"{u}}', 'ü'], ['{\\\"{U}}', 'Ü'],
      ['{\\\"{y}}', 'ÿ'], ['{\\\"{Y}}', 'Ÿ'],

      // Tilde avec accolades
      ['{\\~{n}}', 'ñ'], ['{\\~{N}}', 'Ñ'],
      ['{\\~{a}}', 'ã'], ['{\\~{A}}', 'Ã'],
      ['{\\~{o}}', 'õ'], ['{\\~{O}}', 'Õ'],
      ['{\\~n}', 'ñ'], ['{\\~N}', 'Ñ'],
      ['{\\~a}', 'ã'], ['{\\~A}', 'Ã'],
      ['{\\~o}', 'õ'], ['{\\~O}', 'Õ'],
    ];

    for (const [latex, unicode] of bracedAccentMap) {
      cleaned = cleaned.replaceAll(latex, unicode);
    }

    // 2. Convertir les accents LaTeX simples en Unicode
    const accentMap: Array<[string, string]> = [
      // Accent aigu (´)
      ["\\'e", 'é'], ["\\'E", 'É'],
      ["\\'a", 'á'], ["\\'A", 'Á'],
      ["\\'i", 'í'], ["\\'I", 'Í'],
      ["\\'o", 'ó'], ["\\'O", 'Ó'],
      ["\\'u", 'ú'], ["\\'U", 'Ú'],
      ["\\'y", 'ý'], ["\\'Y", 'Ý'],
      ["\\'c", 'ć'], ["\\'C", 'Ć'],
      ["\\'n", 'ń'], ["\\'N", 'Ń'],
      ["\\'s", 'ś'], ["\\'S", 'Ś'],
      ["\\'z", 'ź'], ["\\'Z", 'Ź'],

      // Accent grave (`)
      ['\\`e', 'è'], ['\\`E', 'È'],
      ['\\`a', 'à'], ['\\`A', 'À'],
      ['\\`i', 'ì'], ['\\`I', 'Ì'],
      ['\\`o', 'ò'], ['\\`O', 'Ò'],
      ['\\`u', 'ù'], ['\\`U', 'Ù'],

      // Accent circonflexe (^)
      ['\\^e', 'ê'], ['\\^E', 'Ê'],
      ['\\^a', 'â'], ['\\^A', 'Â'],
      ['\\^i', 'î'], ['\\^I', 'Î'],
      ['\\^o', 'ô'], ['\\^O', 'Ô'],
      ['\\^u', 'û'], ['\\^U', 'Û'],

      // Tréma (¨)
      ['\\"e', 'ë'], ['\\"E', 'Ë'],
      ['\\"a', 'ä'], ['\\"A', 'Ä'],
      ['\\"i', 'ï'], ['\\"I', 'Ï'],
      ['\\"o', 'ö'], ['\\"O', 'Ö'],
      ['\\"u', 'ü'], ['\\"U', 'Ü'],
      ['\\"y', 'ÿ'], ['\\"Y', 'Ÿ'],

      // Tilde (~)
      ['\\~n', 'ñ'], ['\\~N', 'Ñ'],
      ['\\~a', 'ã'], ['\\~A', 'Ã'],
      ['\\~o', 'õ'], ['\\~O', 'Õ'],

      // Cédille
      ['\\c{c}', 'ç'], ['\\c{C}', 'Ç'],
      ['\\c c', 'ç'], ['\\c C', 'Ç'],

      // Autres diacritiques
      ['\\=a', 'ā'], ['\\=A', 'Ā'],
      ['\\=e', 'ē'], ['\\=E', 'Ē'],
      ['\\=i', 'ī'], ['\\=I', 'Ī'],
      ['\\=o', 'ō'], ['\\=O', 'Ō'],
      ['\\=u', 'ū'], ['\\=U', 'Ū'],
    ];

    for (const [latex, unicode] of accentMap) {
      cleaned = cleaned.replaceAll(latex, unicode);
    }

    // 3. Ligatures et caractères spéciaux LaTeX
    const specialCharMap: Array<[string, string]> = [
      ['\\oe', 'œ'], ['\\OE', 'Œ'],
      ['\\ae', 'æ'], ['\\AE', 'Æ'],
      ['\\aa', 'å'], ['\\AA', 'Å'],
      ['\\o', 'ø'], ['\\O', 'Ø'],
      ['\\l', 'ł'], ['\\L', 'Ł'],
      ['\\ss', 'ß'],
      ['---', '—'],
      ['--', '–'],
      ['``', '"'],
      ["''", '"'],
    ];

    for (const [latex, unicode] of specialCharMap) {
      cleaned = cleaned.replaceAll(latex, unicode);
    }

    // 4. Caractères échappés
    const escapedCharMap: Array<[string, string]> = [
      ['\\&', '&'],
      ['\\%', '%'],
      ['\\$', '$'],
      ['\\_', '_'],
      ['\\#', '#'],
      ['\\{', '{'],
      ['\\}', '}'],
    ];

    for (const [latex, char] of escapedCharMap) {
      cleaned = cleaned.replaceAll(latex, char);
    }

    // 5. Espace insécable LaTeX
    cleaned = cleaned.replaceAll('~', ' ');

    // 6. Enlever les commandes de formatage LaTeX basiques
    const formatCommands = [
      '\\textit',
      '\\textbf',
      '\\emph',
      '\\textrm',
      '\\textsc',
      '\\textsf',
      '\\texttt',
    ];
    for (const command of formatCommands) {
      cleaned = cleaned.replaceAll(command, '');
    }

    // 7. Enlever les accolades LaTeX restantes
    cleaned = cleaned.replaceAll('{', '').replaceAll('}', '');

    // 8. Nettoyer les espaces multiples
    cleaned = cleaned.replace(/\s+/g, ' ');

    return cleaned.trim();
  }

  // Crée un objet Citation à partir des champs parsés
  private createCitation(
    type: string,
    key: string,
    fields: Record<string, string>,
    bibDir?: string
  ): Citation | null {
    // Champ obligatoire : title. author retombe sur editor (volumes
    // dirigés, actes) puis sur vide (œuvres anonymes) : exiger author
    // rejetait silencieusement des entrées légitimes (#32) —
    // displayString retombe sur le titre quand author est vide.
    const author = fields.author || fields.editor || '';
    const year = fields.year || fields.date || 'n.d.';
    const title = fields.title;

    if (!title) {
      console.warn(`⚠️ Citation incomplète ignorée: ${key} (title manquant)`);
      this.rejected.push({ key, reason: 'missing-title' });
      return null;
    }

    // Résoudre le chemin du fichier si présent
    let filePath = fields.file;
    if (filePath && bibDir) {
      filePath = this.resolveFilePath(filePath, bibDir);
    }

    // Parse tags from keywords field
    let tags: string[] | undefined = undefined;
    if (fields.tags) {
      tags = fields.tags.split(/[;,]/).map(tag => tag.trim()).filter(tag => tag.length > 0);
    }

    // Known BibTeX fields to exclude from custom fields
    const knownFields = new Set([
      'author', 'year', 'date', 'title', 'shorttitle', 'journal', 'journaltitle',
      'publisher', 'booktitle', 'file', 'keywords', 'tags', 'note', 'abstract',
      'zoterokey', 'dateadded', 'datemodified'
    ]);

    // Collect custom fields (any field not in the known set)
    const customFields: Record<string, string> = {};
    Object.keys(fields).forEach(fieldKey => {
      if (!knownFields.has(fieldKey.toLowerCase())) {
        customFields[fieldKey] = fields[fieldKey];
      }
    });

    return createCitation({
      id: key,
      key: key,
      type,
      author,
      year: this.extractYear(year),
      title,
      shortTitle: fields.shorttitle,
      journal: fields.journal || fields.journaltitle,
      publisher: fields.publisher,
      booktitle: fields.booktitle,
      file: filePath,
      tags,
      keywords: fields.keywords,
      notes: fields.note || fields.abstract,
      customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
      // Carry zoterokey through: ZoteroDiffEngine matches local↔remote
      // citations by zoteroKey. Dropping it here made every remote item
      // look new on the next sync (68 → 136 duplicate documents) and
      // also prevented metadata from being re-merged after bibtex
      // collisions on `id`.
      zoteroKey: fields.zoterokey,
      dateAdded: fields.dateadded,
      dateModified: fields.datemodified,
    });
  }

  // Résout le chemin du fichier PDF depuis le champ BibTeX file
  // Gère les formats Zotero: "Attachments/file.pdf" ou "Description:chemin:mimetype"
  private resolveFilePath(fileField: string, bibDir: string): string {
    let filePath = fileField;

    // Format Zotero avec description: "Nom:chemin:application/pdf"
    // Peut aussi être "chemin:application/pdf" sans description
    if (fileField.includes(':')) {
      const parts = fileField.split(':');
      // Le chemin est généralement la partie avant le dernier segment (mimetype)
      // ou la partie du milieu si 3 segments (description:chemin:mimetype)
      if (parts.length >= 3) {
        // Format: description:chemin:mimetype
        filePath = parts[1];
      } else if (parts.length === 2) {
        // Format: chemin:mimetype ou description:chemin
        // Si le deuxième segment ressemble à un mimetype, prendre le premier
        if (parts[1].includes('/')) {
          filePath = parts[0];
        } else {
          filePath = parts[1];
        }
      }
    }

    // Si le chemin est déjà absolu, le retourner tel quel
    if (path.isAbsolute(filePath)) {
      return filePath;
    }

    // Résoudre le chemin relatif par rapport au répertoire du fichier BibTeX
    return path.resolve(bibDir, filePath);
  }

  // Extrait l'année d'une date
  private extractYear(dateString: string): string {
    const match = dateString.match(/\d{4}/);
    return match ? match[0] : dateString;
  }
}
