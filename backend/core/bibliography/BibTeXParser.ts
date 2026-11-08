import * as fs from 'fs';
import * as path from 'path';
import type { Citation } from '../../types/citation';
import { createCitation } from '../../types/citation';
import { isVerbatimField } from './BibTeXExporter';

/**
 * Position du délimiteur qui ferme une valeur, en partant de `from` : `}` au niveau de l'accolade
 * ouvrante, ou `"` hors de toute accolade. `escapes` : le caractère qui suit un antislash ne compte
 * pas, sauf un guillemet, qui ferme toujours une valeur entre guillemets, comme dans BibTeX.
 */
function scanToClose(text: string, from: number, closer: '}' | '"', escapes: boolean): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const char = text[i];
    if (escapes && char === '\\' && text[i + 1] !== '"') {
      i++;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      if (closer === '}' && depth === 0) return i;
      if (depth > 0) depth--;
    } else if (char === '"' && closer === '"' && depth === 0) {
      return i;
    }
  }
  return -1;
}

/**
 * Accolade qui ferme celle ouverte en `openIndex`, ou -1.
 *
 * Une accolade précédée d'un antislash ne compte pas : `\{` et `\}` sont des accolades écrites, et
 * c'est ainsi que l'exporteur écrit une accolade isolée. Comptées, elles empêchaient l'entrée de se
 * refermer, et elle disparaissait à la relecture du fichier que ClioDeck venait d'écrire
 * (S07-1-32). Sans fermeture à ce compte, on recompte toutes les accolades, comme BibTeX : une
 * valeur qui finit par un antislash (`{C:\dossier\}`) se referme quand même.
 *
 * `bibAudit` compte avec cette fonction : il contrôle ce que le parseur a lu.
 */
export function findMatchingBrace(text: string, openIndex: number): number {
  const closing = scanToClose(text, openIndex + 1, '}', true);
  return closing !== -1 ? closing : scanToClose(text, openIndex + 1, '}', false);
}

/**
 * Guillemet qui ferme la valeur ouverte en `openIndex`, hors accolades : le tréma s'écrit
 * `{\"u}`, et le premier guillemet venu coupait la valeur au milieu du nom (S07-1-15).
 */
function findClosingQuote(text: string, openIndex: number): number {
  const closing = scanToClose(text, openIndex + 1, '"', true);
  return closing !== -1 ? closing : scanToClose(text, openIndex + 1, '"', false);
}

/**
 * Nom de champ : tout sauf blancs, accolades, guillemets, `#`, `,` et `=`. Mendeley et BibDesk
 * écrivent `mendeley-groups`, `Date-Added`, `bdsk-url-1`.
 */
const FIELD_NAME = /^[^\s{}"#,=]+$/;

/**
 * Ce que l'exporteur échappe et que le nettoyage doit rendre tel quel : `\{` et `\}` (une accolade
 * écrite), `\textbackslash{}` (une barre oblique inverse) et `\textasciitilde{}` (un tilde, que `~`
 * seul ferait lire comme une espace). Mis de côté avant le nettoyage, remis après : sinon les
 * accolades de `\textbackslash{}` tombaient avec les autres, et il restait `\textbackslash` collé
 * au mot suivant, un de plus à chaque réécriture. `\textbackslash\{\}` est la forme qu'écrivaient
 * les versions précédentes. `\\` (saut de ligne) est lu d'un bloc, comme le fait le compte des
 * accolades : son second antislash n'échappe pas l'accolade qui suit.
 */
const ESCAPED_LITERAL = /\\textbackslash(?:\{\}|\\\{\\\})|\\textasciitilde\{\}|\\[{}]|\\\\/g;

/** Caractères de substitution, le temps du nettoyage (zone d'usage privé d'Unicode). */
const STAND_IN = { backslash: '\uE000', tilde: '\uE001', open: '\uE002', close: '\uE003' } as const;

function standInFor(escape: string): string {
  if (escape === '\\\\') return escape;
  if (escape.startsWith('\\textbackslash')) return STAND_IN.backslash;
  if (escape.startsWith('\\textasciitilde')) return STAND_IN.tilde;
  return escape === '\\{' ? STAND_IN.open : STAND_IN.close;
}

/**
 * Le champ `file` est un chemin : il échappe au nettoyage LaTeX, qui changeait `~` en espace
 * (iCloud : `com~apple~CloudDocs`) et `--` en tiret demi-cadratin (S07-1-16). En sont seulement
 * retirés les échappements LaTeX qu'y écrivaient les versions précédentes de ClioDeck (`\_`,
 * `\&`, `\textbackslash\{\}`…) — les noms de fichiers Zotero contiennent presque toujours un `_` —
 * et l'accolade échappée qu'il écrit encore.
 */
const LEGACY_FILE_ESCAPE = /\\textbackslash(?:\{\}|\\\{\\\})|\\([_&%#${}])/g;

function unescapeFilePath(value: string): string {
  return value.replace(LEGACY_FILE_ESCAPE, (_escape, char: string | undefined) => char ?? '\\');
}

/** Un chemin Windows à lettre de lecteur : `C:/…` ou `C:\…`. */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;

const skipBlanks = (text: string, index: number): number => {
  while (index < text.length && /\s/.test(text[index])) index++;
  return index;
};

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

  /**
   * Abréviations `@string` du parse en cours, par nom en minuscules : BibTeX ne distingue pas
   * `AN` de `an`. Les valeurs qui les citent sont développées ; ignorées, elles étaient lues
   * comme du texte (`publisher = {AN}`), et la définition disparaissait à la réécriture (S07-1-26).
   */
  private strings = new Map<string, string>();

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
    this.strings = new Map();
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

      // Mémoriser les abréviations @string, pour les entrées qui suivent
      if (typeString.toLowerCase() === 'string') {
        const closing = findMatchingBrace(content, openBraceIndex);
        if (closing === -1) {
          currentIndex = openBraceIndex + 1;
          continue;
        }
        for (const [name, value] of this.readFields(content.slice(openBraceIndex + 1, closing))) {
          this.strings.set(name, value);
        }
        currentIndex = closing + 1;
        continue;
      }

      // Ignorer @comment, @preamble
      if (['comment', 'preamble'].includes(typeString.toLowerCase())) {
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
      const closingBraceIndex = findMatchingBrace(content, openBraceIndex);
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

  // Parse les champs d'une entrée BibTeX de manière robuste
  private parseFields(fieldsString: string): Record<string, string> {
    const fields: Record<string, string> = {};

    for (const [fieldName, value] of this.readFields(fieldsString)) {
      // Nettoyer et stocker la valeur. Les champs verbatim de BibLaTeX
      // (URL, DOI…) et les adresses de BibDesk (bdsk-url-1…) échappent au
      // nettoyage LaTeX : il changerait `~` en espace et `--` en tiret
      // demi-cadratin, donc l'adresse elle-même. Le chemin du PDF aussi,
      // cf. unescapeFilePath.
      if (value) {
        if (fieldName === 'file') {
          fields.file = unescapeFilePath(value.trim());
        } else {
          fields[fieldName] = isVerbatimField(fieldName) ? value.trim() : this.cleanValue(value);
        }
      }
    }

    return fields;
  }

  // Lit les champs « nom = valeur » d'une entrée ou d'un @string : valeurs brutes,
  // abréviations développées. La valeur d'un nom invalide est sautée quand même :
  // sinon elle passait pour le nom du champ suivant, et plus aucun champ n'était
  // lu (S07-1-14).
  private readFields(text: string): Array<[string, string]> {
    const fields: Array<[string, string]> = [];
    let currentIndex = 0;

    while (currentIndex < text.length) {
      // Chercher "nom ="
      const equalsIndex = text.indexOf('=', currentIndex);
      if (equalsIndex === -1) break;

      const fieldName = text.slice(currentIndex, equalsIndex).trim().toLowerCase();
      const { value, end } = this.readValue(text, equalsIndex + 1);
      currentIndex = end;

      if (FIELD_NAME.test(fieldName)) {
        fields.push([fieldName, value]);
      }

      // Passer au champ suivant (chercher la virgule)
      while (currentIndex < text.length) {
        if (text[currentIndex] === ',') {
          currentIndex++;
          break;
        }
        currentIndex++;
      }
    }

    return fields;
  }

  // Lit une valeur et ses concaténations `#` : rend le texte brut, abréviations
  // développées, et la position qui la suit.
  private readValue(text: string, from: number): { value: string; end: number } {
    let value = '';
    let index = skipBlanks(text, from);

    for (;;) {
      const part = this.readPart(text, index);
      if (!part) break;
      value += part.value;
      index = skipBlanks(text, part.end);
      if (text[index] !== '#') break;
      index = skipBlanks(text, index + 1);
    }

    return { value, end: index };
  }

  // Une valeur entre accolades, entre guillemets, ou brute (nombre, abréviation).
  // `null` si son délimiteur ne se ferme pas.
  private readPart(text: string, index: number): { value: string; end: number } | null {
    const firstChar = text[index];

    if (firstChar === '{' || firstChar === '"') {
      const closing = firstChar === '{' ? findMatchingBrace(text, index) : findClosingQuote(text, index);
      if (closing === -1) return null;
      return { value: text.slice(index + 1, closing), end: closing + 1 };
    }

    // Valeur brute jusqu'à la virgule, au `#` ou à la fin de ligne ; une abréviation
    // jamais définie reste écrite telle quelle.
    let end = index;
    while (end < text.length && !',#\n\r'.includes(text[end])) {
      end++;
    }
    const token = text.slice(index, end).trim();
    return { value: this.strings.get(token.toLowerCase()) ?? token, end };
  }

  // ✅ Nettoie une valeur BibTeX (convertit les commandes LaTeX en Unicode)
  private cleanValue(value: string): string {
    // 0. Mettre de côté les caractères échappés (cf. ESCAPED_LITERAL), remis en 9
    let cleaned = value.replace(ESCAPED_LITERAL, standInFor);

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

    // 8. Nettoyer les espaces multiples — ASCII seulement. `\s` couvre aussi
    // les espaces insécables (U+00A0, U+202F) de la typographie française
    // (« Lire : un braconnage ») : les fusionner les effaçait du .bib dès
    // qu'une synchronisation le réécrivait depuis sa relecture.
    cleaned = cleaned.replace(/[ \t\r\n\f\v]+/g, ' ');

    // 9. Remettre les caractères échappés mis de côté en 0
    cleaned = cleaned
      .replaceAll(STAND_IN.backslash, '\\')
      .replaceAll(STAND_IN.tilde, '~')
      .replaceAll(STAND_IN.open, '{')
      .replaceAll(STAND_IN.close, '}');

    return cleaned.trim();
  }

  // Crée un objet Citation à partir des champs parsés
  private createCitation(
    type: string,
    key: string,
    fields: Record<string, string>,
    bibDir?: string
  ): Citation | null {
    // Champ obligatoire : title. `author` peut être vide — volume dirigé
    // (les noms sont alors dans `editor`) ou œuvre anonyme : l'exiger
    // rejetait silencieusement des entrées légitimes (#32). displayString
    // retombe sur l'éditeur, puis sur le titre.
    const author = fields.author || '';
    // Pas d'année inventée : `n.d.` relu ici était réécrit tel quel à
    // l'export, puis vu « modifié » à chaque synchronisation face à
    // Zotero, qui n'en a pas. L'affichage se charge de l'absence.
    const year = fields.year || fields.date || '';
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
    // `date` n'y figure pas : il sert de repli pour l'année, mais porte
    // souvent davantage (jour et mois d'un article de presse) et doit
    // survivre à un aller-retour par le fichier. `abstract` non plus : lu
    // comme `notes`, il était réécrit en `note`, que biblatex imprime dans
    // la bibliographie, ou perdu quand l'entrée avait déjà une note (S07-2-3).
    const knownFields = new Set([
      'author', 'editor', 'year', 'title', 'shorttitle', 'journal', 'journaltitle',
      'publisher', 'booktitle', 'file', 'keywords', 'tags', 'note',
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
      editor: fields.editor,
      year: this.extractYear(year),
      title,
      shortTitle: fields.shorttitle,
      journal: fields.journal || fields.journaltitle,
      publisher: fields.publisher,
      booktitle: fields.booktitle,
      file: filePath,
      tags,
      keywords: fields.keywords,
      notes: fields.note,
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

    // Format Zotero avec description: "Nom:chemin:application/pdf", plusieurs
    // pièces jointes séparées par `;` : le chemin de la première, tout ce qui
    // est entre son premier et son dernier deux-points — lettre de lecteur
    // comprise ("PDF:C:/x/a.pdf:application/pdf").
    const attachment = fileField.split(';')[0];
    const firstColon = attachment.indexOf(':');
    const lastColon = attachment.lastIndexOf(':');
    if (lastColon > firstColon) {
      filePath = attachment.slice(firstColon + 1, lastColon);
    } else if (firstColon !== -1 && !DRIVE_PATH.test(attachment)) {
      // Format: chemin:mimetype ou description:chemin
      // Si le deuxième segment ressemble à un mimetype, prendre le premier.
      // Jamais le deux-points d'une lettre de lecteur (C:/x/a.pdf), qui fait
      // partie du chemin : on n'en gardait que « C ».
      const [head, tail] = [attachment.slice(0, firstColon), attachment.slice(firstColon + 1)];
      filePath = tail.includes('/') ? head : tail;
    }

    // Si le chemin est déjà absolu, le retourner tel quel — un chemin Windows
    // aussi, même relu sur un Mac : rattaché au dossier du .bib, il serait faux
    // partout, et réécrit tel quel à la synchronisation suivante.
    if (path.isAbsolute(filePath) || DRIVE_PATH.test(filePath)) {
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
