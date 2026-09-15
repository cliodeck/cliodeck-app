import path from 'path';
import { existsSync } from 'fs';
import { readFile, rename, writeFile } from 'fs/promises';
import { ZoteroAPI } from '../../../backend/integrations/zotero/ZoteroAPI.js';
import type { ZoteroItem } from '../../../backend/integrations/zotero/ZoteroAPI.js';
import { ZoteroLocalDB } from '../../../backend/integrations/zotero/ZoteroLocalDB.js';
import { IZoteroDataSource, ZoteroLibraryInfo } from '../../../backend/integrations/zotero/IZoteroDataSource.js';
import {
  ZoteroSynchronizer,
  type SyncReport,
} from '../../../backend/integrations/zotero/ZoteroSynchronizer.js';
import { BibTeXParser } from '../../../backend/core/bibliography/BibTeXParser.js';
import { BibliographyMetadataService } from '../../../backend/services/BibliographyMetadataService.js';
import { followRenamedCitekeys } from '../../../backend/core/bibliography/readingNotes.js';
import { indexReadingNotesInBackground } from './reading-notes-indexing.js';
import type { Citation } from '../../../backend/types/citation.js';

// Common options for Zotero data source selection
interface ZoteroSourceOptions {
  mode: 'api' | 'local';
  // API mode
  userId?: string;
  apiKey?: string;
  groupId?: string;
  // Local mode
  dataDirectory?: string;
  libraryID?: number;
}

class ZoteroService {
  /**
   * Factory: create the appropriate data source
   */
  private createDataSource(options: ZoteroSourceOptions): IZoteroDataSource {
    if (options.mode === 'local') {
      if (!options.dataDirectory) {
        throw new Error('dataDirectory is required for local mode');
      }
      const localDB = new ZoteroLocalDB({
        dataDirectory: options.dataDirectory,
        libraryID: options.libraryID,
      });
      localDB.open();
      return localDB;
    }
    // API mode
    if (!options.userId || !options.apiKey) {
      throw new Error('userId and apiKey are required for API mode');
    }
    return new ZoteroAPI({
      userId: options.userId,
      apiKey: options.apiKey,
      groupId: options.groupId,
    });
  }

  /**
   * Close a data source if it's a local DB
   */
  private closeDataSource(ds: IZoteroDataSource): void {
    if (ds instanceof ZoteroLocalDB) {
      ds.close();
    }
  }

  /**
   * Test connection to Zotero (API or local database)
   */
  async testConnection(options: ZoteroSourceOptions): Promise<{ success: boolean; error?: string; itemCount?: number }> {
    try {
      const ds = this.createDataSource(options);
      try {
        const isConnected = await ds.testConnection();
        return { success: isConnected };
      } finally {
        this.closeDataSource(ds);
      }
    } catch (error: unknown) {
      console.error('Zotero test connection failed:', error);
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  /**
   * List available libraries (local mode only)
   */
  async listLibraries(dataDirectory: string): Promise<{
    success: boolean;
    libraries?: ZoteroLibraryInfo[];
    error?: string;
  }> {
    try {
      const localDB = new ZoteroLocalDB({ dataDirectory });
      localDB.open();
      try {
        const libraries = localDB.listLibraries();
        return { success: true, libraries };
      } finally {
        localDB.close();
      }
    } catch (error: unknown) {
      console.error('Failed to list Zotero libraries:', error);
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  /**
   * List all collections from Zotero with hierarchy
   */
  async listCollections(options: ZoteroSourceOptions): Promise<{
    success: boolean;
    collections?: Array<{ key: string; name: string; parentCollection?: string }>;
    error?: string;
  }> {
    try {
      const ds = this.createDataSource(options);
      try {
        const collections = await ds.listCollections();

        // Build hierarchical structure
        const collectionMap = collections.map((c) => ({
          key: c.key,
          name: c.data.name,
          parentCollection: c.data.parentCollection,
        }));

        // Sort to show top-level collections first, then their children
        const sortedCollections = this.sortCollectionsHierarchically(collectionMap);

        return {
          success: true,
          collections: sortedCollections,
        };
      } finally {
        this.closeDataSource(ds);
      }
    } catch (error: unknown) {
      console.error('Failed to list Zotero collections:', error);
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  /**
   * Sort collections hierarchically (top-level first, then children indented)
   */
  private sortCollectionsHierarchically(
    collections: Array<{ key: string; name: string; parentCollection?: string }>
  ): Array<{ key: string; name: string; parentCollection?: string }> {
    const result: Array<{ key: string; name: string; parentCollection?: string }> = [];
    const topLevel = collections.filter((c) => !c.parentCollection);

    const addWithChildren = (parent: { key: string; name: string; parentCollection?: string }, depth: number = 0) => {
      result.push(parent);
      const children = collections.filter((c) => c.parentCollection === parent.key);
      children.forEach((child) => addWithChildren(child, depth + 1));
    };

    topLevel.forEach((col) => addWithChildren(col));
    return result;
  }


  /**
   * Download a specific PDF attachment from Zotero
   */
  async downloadPDF(options: ZoteroSourceOptions & {
    attachmentKey: string;
    filename: string;
    targetDirectory: string;
  }): Promise<{
    success: boolean;
    filePath?: string;
    error?: string;
  }> {
    try {
      const ds = this.createDataSource(options);
      try {
        // Create PDFs directory if it doesn't exist
        const pdfDir = path.join(options.targetDirectory, 'PDFs');

        // Sanitize filename
        const sanitizedFilename = options.filename
          .replace(/[<>:"/\\|?*]/g, '_')
          .replace(/\s+/g, '_')
          .replace(/_+/g, '_')
          .substring(0, 200);

        const savePath = path.join(pdfDir, sanitizedFilename);

        // Download/copy the file
        await ds.downloadFile(options.attachmentKey, savePath);

        console.log(`✅ PDF obtained: ${sanitizedFilename}`);

        return {
          success: true,
          filePath: savePath,
        };
      } finally {
        this.closeDataSource(ds);
      }
    } catch (error: unknown) {
      console.error('Zotero PDF download failed:', error);
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }


  /**
   * Synchronise la bibliographie du projet avec sa collection Zotero — le
   * seul bouton « Synchroniser avec Zotero ». Premier import, mise à jour et
   * changement de collection sont le même geste (cf. `ZoteroSynchronizer`).
   *
   * Le fichier `.bib` est la source de vérité : c'est lui qu'on lit, pas
   * l'état du panneau, et c'est lui qu'on écrit.
   *
   * Premier appel sans `confirmed` : si la synchronisation retirerait des
   * références ou changerait de collection, rien n'est écrit et le rapport
   * revient pour confirmation.
   */
  async synchronizeProject(options: ZoteroSourceOptions & {
    projectPath: string;
    collectionKey: string;
    confirmed?: boolean;
  }): Promise<{
    success: boolean;
    status?: 'needs-confirmation' | 'applied';
    report?: SyncReport;
    /** Faux quand tout était déjà à jour : le fichier n'a pas été touché. */
    written?: boolean;
    bibtexPath?: string;
    collections?: Array<{ key: string; name: string; parentKey?: string }>;
    /** Clé BibTeX → collections Zotero, pour relier les documents indexés. */
    bibtexKeyToCollections?: Record<string, string[]>;
    error?: string;
  }> {
    try {
      const projectJsonPath = path.join(options.projectPath, 'project.json');
      const project = await readProjectJson(projectJsonPath);
      const relativeBib = project.bibliographySource?.filePath || 'bibliography.bib';
      const bibtexPath = path.isAbsolute(relativeBib)
        ? relativeBib
        : path.join(options.projectPath, relativeBib);
      const savedCollectionKey =
        project.zotero?.collectionKey || project.bibliographySource?.zoteroCollection || undefined;

      const local = await readLocalBibliography(bibtexPath, options.projectPath);

      const ds = this.createDataSource(options);
      try {
        const result = await new ZoteroSynchronizer(ds).synchronize({
          local,
          collectionKey: options.collectionKey,
          savedCollectionKey,
          confirmed: options.confirmed,
        });

        if (result.status === 'needs-confirmation') {
          return { success: true, status: result.status, report: result.report, bibtexPath };
        }

        const mustWrite = result.changed || !existsSync(bibtexPath);
        if (mustWrite) {
          // Écriture atomique : un fichier à moitié écrit (coupure, OneDrive
          // qui synchronise au mauvais moment) perdrait la bibliographie.
          const temporary = `${bibtexPath}.tmp`;
          await writeFile(temporary, result.bibtex, 'utf-8');
          await rename(temporary, bibtexPath);
          await BibliographyMetadataService.saveMetadata(options.projectPath, result.citations);
          // Une clé refaite ne doit pas couper une note de lecture de sa
          // référence : la note suit (front matter et nom de fichier).
          try {
            await followRenamedCitekeys(options.projectPath, result.report.renamedKeys);
            indexReadingNotesInBackground('clés de citation refaites');
          } catch (error) {
            console.warn('⚠️ Notes de lecture non renommées :', error);
          }
        }

        await recordProjectCollection(projectJsonPath, relativeBib, options.collectionKey);

        const collections = (await ds.listCollections()).map((c) => ({
          key: c.key,
          name: c.data.name,
          parentKey: c.data.parentCollection,
        }));

        return {
          success: true,
          status: 'applied',
          report: result.report,
          written: mustWrite,
          bibtexPath,
          collections,
          bibtexKeyToCollections: collectionsByCiteKey(result.citations, result.items),
        };
      } finally {
        this.closeDataSource(ds);
      }
    } catch (error: unknown) {
      console.error('Zotero synchronization failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

interface ProjectJson {
  bibliographySource?: { type: 'file' | 'zotero'; filePath?: string; zoteroCollection?: string };
  zotero?: { collectionKey?: string; groupId?: string; libraryID?: number };
  [key: string]: unknown;
}

async function readProjectJson(projectJsonPath: string): Promise<ProjectJson> {
  if (!existsSync(projectJsonPath)) return {};
  return JSON.parse(await readFile(projectJsonPath, 'utf-8')) as ProjectJson;
}

/**
 * Bibliographie actuelle du projet : le fichier, enrichi des métadonnées
 * (PDF Zotero, téléchargements). Un fichier présent mais illisible arrête
 * tout : le traiter comme vide ferait tout « ajouter » depuis Zotero et
 * effacerait à l'écriture les entrées qu'il contenait.
 */
async function readLocalBibliography(bibtexPath: string, projectPath: string): Promise<Citation[]> {
  if (!existsSync(bibtexPath)) return [];
  const content = await readFile(bibtexPath, 'utf-8');
  const citations = new BibTeXParser().parse(content, path.dirname(bibtexPath));
  if (citations.length === 0 && content.includes('@')) {
    throw new Error(`${path.basename(bibtexPath)} n'a pas pu être lu ; synchronisation interrompue pour ne rien effacer.`);
  }
  const metadata = await BibliographyMetadataService.loadMetadata(projectPath);
  return BibliographyMetadataService.mergeCitationsWithMetadata(citations, metadata);
}

/** Mémorise dans `project.json` la collection que suit la bibliographie. */
async function recordProjectCollection(
  projectJsonPath: string,
  bibFile: string,
  collectionKey: string
): Promise<void> {
  if (!existsSync(projectJsonPath)) return;
  const project = await readProjectJson(projectJsonPath);
  const already =
    project.bibliographySource?.type === 'zotero' &&
    project.bibliographySource.zoteroCollection === collectionKey &&
    project.bibliographySource.filePath === bibFile &&
    project.zotero?.collectionKey === collectionKey;
  if (already) return;

  project.bibliographySource = { type: 'zotero', filePath: bibFile, zoteroCollection: collectionKey };
  project.zotero = { ...(project.zotero ?? {}), collectionKey };
  project.updatedAt = new Date().toISOString();
  // `path` se déduit de l'emplacement du fichier : ne jamais l'y écrire (#13).
  const { path: _computed, ...toSave } = project;
  await writeFile(projectJsonPath, JSON.stringify(toSave, null, 2));
}

/** Clé BibTeX → collections Zotero de la notice correspondante. */
function collectionsByCiteKey(citations: Citation[], items: ZoteroItem[]): Record<string, string[]> {
  const collectionsOf = new Map(items.map((item) => [item.key, item.data.collections ?? []]));
  const map: Record<string, string[]> = {};
  for (const c of citations) {
    const collections = c.zoteroKey ? collectionsOf.get(c.zoteroKey) : undefined;
    if (collections && collections.length > 0) map[c.id] = collections;
  }
  return map;
}

export const zoteroService = new ZoteroService();
