import path from 'path';
import { mkdir, readFile } from 'fs/promises';
import { BibTeXParser } from '../../../backend/core/bibliography/BibTeXParser.js';
import { BibTeXExporter } from '../../../backend/core/bibliography/BibTeXExporter.js';
import { auditParsedBib, type BibAudit } from '../../../backend/core/bibliography/bibAudit.js';
import { mergeCitationLists } from '../../../backend/core/bibliography/mergeCitations.js';
import { keepOutsideEntries } from '../../../backend/core/bibliography/outsideEntries.js';
import {
  atomicWriteFile,
  readUserFile,
  UnreadableFileError,
  withFileLock,
  type UserFileRead,
} from '../../../backend/core/fs/user-files.js';
import { isInsideAsync } from '../../../backend/core/vector-store/file-identity.js';
import type { Citation } from '../../../backend/types/citation.js';
import {
  BibliographyMetadataService,
  MetadataUnreadableError,
  type BibliographyMetadataFile,
} from '../../../backend/services/BibliographyMetadataService.js';
import { BibliographyStatsEngine, type BibliographyStatistics } from '../../../backend/services/BibliographyStats.js';

/** Le `.bib` attendu n'est pas là : ce n'est pas une bibliographie vide. */
export class BibliographyMissingError extends Error {
  readonly code = 'bib-missing';
  readonly filePath: string;

  constructor(filePath: string) {
    super(`${path.basename(filePath)} est introuvable`);
    this.name = 'BibliographyMissingError';
    this.filePath = filePath;
  }
}

/**
 * Le `.bib` du projet n'a pas été lu en entier : le réécrire effacerait les entrées que le parseur
 * n'a pas rendues (S07-1-2). Rien n'est écrit, et les clés en cause sont rendues.
 */
export class BibNotFullyReadError extends Error {
  readonly code = 'bib-unread';
  readonly filePath: string;
  readonly unreadKeys: string[];

  constructor(filePath: string, unreadKeys: string[]) {
    super(`${path.basename(filePath)} n'a pas été lu en entier ; rien n'a été écrit.`);
    this.name = 'BibNotFullyReadError';
    this.filePath = filePath;
    this.unreadKeys = unreadKeys;
  }
}

export type BibFileRead =
  | { kind: 'absent' }
  | Extract<UserFileRead, { kind: 'unreadable' }>
  | ({ kind: 'ok'; content: string; citations: Citation[] } & BibAudit);

/**
 * Lit un `.bib` sans confondre absent, illisible et vide, puis contrôle le parse : les entrées du
 * texte que le parseur n'a pas rendues, et les `@string` qu'il n'a pas lus. UTF-8 strict : un
 * `.bib` Latin-1 est illisible, plutôt que relu avec des caractères de remplacement qu'une
 * réécriture rendrait définitifs.
 */
export async function readBibFile(filePath: string): Promise<BibFileRead> {
  const read = await readUserFile(filePath);
  if (read.kind !== 'ok') return read;
  const citations = new BibTeXParser().parse(read.content, path.dirname(path.resolve(filePath)));
  return { kind: 'ok', content: read.content, citations, ...auditParsedBib(read.content, citations) };
}

/**
 * La copie de sécurité du `.bib`, unique : l'état d'avant la dernière réécriture, et pas plus
 * loin. Hors de `workspaceFiles`, comme `bibliography-metadata.json`.
 */
export function bibBackupPath(projectPath: string): string {
  return path.join(projectPath, '.cliodeck', 'bibliography.bib.bak');
}

/**
 * Remplace le `.bib` du projet, tout entier ou pas du tout, après avoir copié la version en place
 * dans `.cliodeck/bibliography.bib.bak`, à l'octet. Une copie qui échoue arrête tout : le `.bib`
 * n'est pas touché. Un `.bib` encore absent n'a rien à copier.
 *
 * `keepOutsideEntries` : `content` n'a que des entrées, réécrites depuis les citations (synchronisation
 * Zotero, « Fusionner ») ; ce que la version en place porte hors de ses entrées — en-tête,
 * `@comment`, `@preamble`, `@string`, texte libre — y est repris (H2). « Remplacer » ne le passe
 * pas : le fichier importé arrive avec ses blocs à lui, pas ceux du fichier qu'il remplace.
 */
export async function rewriteProjectBibliography(
  projectPath: string,
  bibtexPath: string,
  content: string,
  options: { keepOutsideEntries?: boolean } = {}
): Promise<void> {
  const previous = await readFile(bibtexPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (previous) {
    const backup = bibBackupPath(projectPath);
    // `.cliodeck` lié hors du projet (D18) : la copie partirait dans le dossier d'un autre.
    if (!(await isInsideAsync(projectPath, backup))) {
      throw new Error(`Copie de sécurité refusée : ${backup} mène hors du projet`);
    }
    await mkdir(path.dirname(backup), { recursive: true });
    await atomicWriteFile(backup, previous);
  }
  await atomicWriteFile(bibtexPath, previous && options.keepOutsideEntries ? withOutsideEntriesOf(previous, content) : content);
}

/**
 * `content` avec ce que `previous` porte hors de ses entrées. Lu en UTF-8 strict, comme tout `.bib` :
 * devenu illisible depuis la lecture qui a précédé la réécriture, rien n'en est repris, plutôt que
 * des caractères de remplacement ; la copie de sécurité le garde tel quel.
 */
function withOutsideEntriesOf(previous: Buffer, content: string): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(previous);
  } catch {
    console.warn('⚠️ Le .bib en place n’est plus en UTF-8 : ce qu’il porte hors de ses entrées n’est pas repris (la copie de sécurité le garde).');
    return content;
  }
  return keepOutsideEntries(text, content);
}

/**
 * Les métadonnées du projet, pour retrouver ses PDF téléchargés. Illisibles, elles n'arrêtent pas la
 * fusion, qui ne les réécrit pas : les chemins se résolvent sans elles.
 */
async function metadataOrNull(projectPath: string): Promise<BibliographyMetadataFile | null> {
  try {
    return await BibliographyMetadataService.loadMetadata(projectPath);
  } catch (error: unknown) {
    if (!(error instanceof MetadataUnreadableError)) throw error;
    console.warn('⚠️ Métadonnées bibliographiques illisibles : PDF du projet résolus sans elles', error.message);
    return null;
  }
}

/**
 * Ajoute au `.bib` du projet les références d'`incoming` qu'il n'a pas encore (même item Zotero,
 * sinon même clé BibTeX), relu, fusionné et réécrit sous son verrou. Absent, il naît de la fusion,
 * sauf s'il est `expected` (nommé par `project.json`) : déplacé, renommé ou évincé par iCloud, le
 * recréer perdrait ce que l'ancien avait en propre, et rien n'est écrit (J1, la règle de la
 * synchronisation Zotero, H3). Illisible, ou une seule de ses entrées non lue : rien n'est écrit.
 * Rien de nouveau : il n'est pas réécrit, et la copie de sécurité garde l'état qu'elle gardait. Ce
 * qu'il porte hors de ses entrées (groupes BibDesk ou JabRef, `@preamble`, commentaires) reste ; ce
 * que le fichier importé porte hors des siennes n'y entre pas.
 */
export function mergeIntoProjectBibliography(
  projectPath: string,
  bibtexPath: string,
  incoming: Citation[],
  expected: boolean
): Promise<{ newCount: number; duplicates: number }> {
  return withFileLock(bibtexPath, async () => {
    const read = await readBibFile(bibtexPath);
    if (read.kind === 'absent' && expected) throw new BibliographyMissingError(bibtexPath);
    if (read.kind === 'unreadable') throw new UnreadableFileError(bibtexPath, read.reason, read.message);
    if (read.kind === 'ok' && read.unreadKeys.length > 0) throw new BibNotFullyReadError(bibtexPath, read.unreadKeys);

    // Les PDF du projet retrouvés où ils sont (projet renommé, copié, ouvert sur un autre Mac) : la
    // réécriture les range relatifs au `.bib` (S07-2-1). Les métadonnées disent quels PDF le projet a
    // téléchargés : sans elles, la copie d'un projet ancien réécrirait les chemins de l'original.
    // Seul `file` en est repris, et là seulement où le `.bib` en avait un : le reste ne change pas.
    const parsed = read.kind === 'ok' ? read.citations : [];
    const resolved = BibliographyMetadataService.mergeCitationsWithMetadata(parsed, await metadataOrNull(projectPath), projectPath);
    const local = parsed.map((citation, i) => (citation.file === undefined ? citation : { ...citation, file: resolved[i].file }));
    const { merged, newCount, duplicates } = mergeCitationLists(local, incoming);
    if (newCount > 0 || read.kind === 'absent') {
      const bibtex = new BibTeXExporter().exportToString(merged, { fileBaseDir: path.dirname(path.resolve(bibtexPath)) });
      await rewriteProjectBibliography(projectPath, bibtexPath, bibtex, { keepOutsideEntries: true });
    }
    return { newCount, duplicates };
  });
}

class BibliographyService {
  private parser: BibTeXParser;
  private exporter: BibTeXExporter;
  private statsEngine: BibliographyStatsEngine;
  private citations: Citation[] = [];

  constructor() {
    this.parser = new BibTeXParser();
    this.exporter = new BibTeXExporter();
    this.statsEngine = new BibliographyStatsEngine();
  }

  /**
   * Absent ou illisible lève, et les citations déjà chargées restent : un fichier manquant n'est
   * pas une bibliographie vide (S07-1-11). Les entrées que le parseur a laissées sont rendues.
   */
  async loadFromFile(filePath: string): Promise<{ citations: Citation[]; unreadKeys: string[] }> {
    const read = await readBibFile(filePath);
    if (read.kind === 'absent') throw new BibliographyMissingError(filePath);
    if (read.kind === 'unreadable') throw new UnreadableFileError(filePath, read.reason, read.message);
    this.citations = read.citations;
    console.log(`✅ Bibliography loaded: ${this.citations.length} citations, ${read.unreadKeys.length} non lue(s)`);
    return { citations: this.citations, unreadKeys: read.unreadKeys };
  }

  /**
   * Plus aucune référence, comme le panneau : la bibliographie du projet ouvert ne s'est pas
   * chargée, ou le projet se ferme (service `bibliography` de `project-services`, L03-4). Ces
   * citations résolvent les exports PDF et Word et l'aperçu ; garder celles du projet d'avant les
   * imprimerait dans le suivant, sans un mot.
   */
  forget(): void {
    this.citations = [];
  }

  async parseContent(content: string): Promise<Citation[]> {
    try {
      this.citations = this.parser.parse(content);
      console.log(`✅ Bibliography parsed: ${this.citations.length} citations`);
      return this.citations;
    } catch (error) {
      console.error('❌ Failed to parse bibliography:', error);
      throw error;
    }
  }

  searchCitations(query: string): Citation[] {
    if (!query) return this.citations;

    const lowerQuery = query.toLowerCase();
    return this.citations.filter(
      (citation) =>
        citation.title?.toLowerCase().includes(lowerQuery) ||
        citation.author?.toLowerCase().includes(lowerQuery) ||
        citation.key?.toLowerCase().includes(lowerQuery) ||
        citation.year?.toString().includes(query)
    );
  }

  getCitations(): Citation[] {
    return this.citations;
  }

  getCitationByKey(key: string): Citation | undefined {
    return this.citations.find((c) => c.key === key);
  }

  /**
   * Resolve a bibliographic key to a Citation.
   * Matches both the BibTeX `id` (primary key as written `[@key]`) and the
   * optional `key` alias field for legacy compatibility.
   */
  getByCitationKey(key: string): Citation | undefined {
    return this.citations.find((c) => c.id === key || c.key === key);
  }

  /**
   * Generate statistics for the current bibliography
   */
  generateStatistics(citations?: Citation[]): BibliographyStatistics {
    const citationsToAnalyze = citations || this.citations;
    return this.statsEngine.generateStatistics(citationsToAnalyze);
  }

  /**
   * Export citations to BibTeX file
   */
  async exportToFile(citations: Citation[], filePath: string): Promise<void> {
    try {
      await this.exporter.exportToFile(citations, filePath);
      console.log(`✅ Bibliography exported: ${citations.length} citations to ${filePath}`);
    } catch (error) {
      console.error('❌ Failed to export bibliography:', error);
      throw error;
    }
  }

  /**
   * Export citations to BibTeX string
   */
  exportToString(citations: Citation[]): string {
    return this.exporter.exportToString(citations);
  }

  /**
   * Export citations to BibTeX string with LaTeX encoding (legacy mode)
   */
  exportToStringLegacy(citations: Citation[]): string {
    return this.exporter.exportToStringLegacy(citations);
  }
}

export const bibliographyService = new BibliographyService();
