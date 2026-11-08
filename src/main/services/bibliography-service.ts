import path from 'path';
import { mkdir, readFile } from 'fs/promises';
import { BibTeXParser } from '../../../backend/core/bibliography/BibTeXParser.js';
import { BibTeXExporter } from '../../../backend/core/bibliography/BibTeXExporter.js';
import { auditParsedBib, type BibAudit } from '../../../backend/core/bibliography/bibAudit.js';
import { mergeCitationLists } from '../../../backend/core/bibliography/mergeCitations.js';
import {
  atomicWriteFile,
  readUserFile,
  UnreadableFileError,
  withFileLock,
  type UserFileRead,
} from '../../../backend/core/fs/user-files.js';
import { isInsideAsync } from '../../../backend/core/vector-store/file-identity.js';
import type { Citation } from '../../../backend/types/citation.js';
import { BibliographyMetadataService } from '../../../backend/services/BibliographyMetadataService.js';
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
 */
export async function rewriteProjectBibliography(projectPath: string, bibtexPath: string, content: string): Promise<void> {
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
  await atomicWriteFile(bibtexPath, content);
}

/**
 * Ajoute au `.bib` du projet les références d'`incoming` qu'il n'a pas encore (même item Zotero,
 * sinon même clé BibTeX), relu, fusionné et réécrit sous son verrou. Absent, il naît de la fusion.
 * Illisible, ou une seule de ses entrées non lue : rien n'est écrit. Rien de nouveau : il n'est pas
 * réécrit, et la copie de sécurité garde l'état qu'elle gardait.
 */
export function mergeIntoProjectBibliography(
  projectPath: string,
  bibtexPath: string,
  incoming: Citation[]
): Promise<{ newCount: number; duplicates: number }> {
  return withFileLock(bibtexPath, async () => {
    const read = await readBibFile(bibtexPath);
    if (read.kind === 'unreadable') throw new UnreadableFileError(bibtexPath, read.reason, read.message);
    if (read.kind === 'ok' && read.unreadKeys.length > 0) throw new BibNotFullyReadError(bibtexPath, read.unreadKeys);

    // Les PDF du projet retrouvés où ils sont (projet renommé, ouvert sur un autre Mac) : la
    // réécriture les range relatifs au `.bib` (S07-2-1).
    const local = BibliographyMetadataService.mergeCitationsWithMetadata(read.kind === 'ok' ? read.citations : [], null, projectPath);
    const { merged, newCount, duplicates } = mergeCitationLists(local, incoming);
    if (newCount > 0 || read.kind === 'absent') {
      const bibtex = new BibTeXExporter().exportToString(merged, { fileBaseDir: path.dirname(path.resolve(bibtexPath)) });
      await rewriteProjectBibliography(projectPath, bibtexPath, bibtex);
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
   * La bibliographie du projet ouvert ne s'est pas chargée : plus aucune référence, comme le
   * panneau. Ces citations résolvent les exports PDF et Word et l'aperçu ; garder celles du
   * projet d'avant les imprimerait dans celui-ci, sans un mot.
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
