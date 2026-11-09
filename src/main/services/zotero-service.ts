import path from 'path';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readdir, readFile, rename, rm, stat } from 'fs/promises';
import { ZoteroAPI } from '../../../backend/integrations/zotero/ZoteroAPI.js';
import type { ZoteroItem } from '../../../backend/integrations/zotero/ZoteroAPI.js';
import { ZoteroLocalDB } from '../../../backend/integrations/zotero/ZoteroLocalDB.js';
import { collectionsForProject } from '../../../backend/integrations/zotero/projectCollections.js';
import {
  assertInside,
  assertSafeAttachmentKey,
  chooseAttachmentDestination,
  sanitizeAttachmentFilename,
  type AttachmentOwner,
} from '../../../backend/integrations/zotero/attachmentDestination.js';
import { IZoteroDataSource, ZoteroLibraryInfo } from '../../../backend/integrations/zotero/IZoteroDataSource.js';
import {
  ZoteroSynchronizer,
  type SyncConfirmation,
  type SyncReport,
} from '../../../backend/integrations/zotero/ZoteroSynchronizer.js';
import { parseUserJson, UnreadableFileError, updateJsonFile, withFileLock } from '../../../backend/core/fs/user-files.js';
import {
  BibliographyMetadataService,
  MetadataUnreadableError,
  type BibliographyMetadataFile,
} from '../../../backend/services/BibliographyMetadataService.js';
import { readBibFile, rewriteProjectBibliography } from './bibliography-service.js';
import type { BibAudit } from '../../../backend/core/bibliography/bibAudit.js';
import { fromStoredPath } from '../../../backend/core/bibliography/stored-path.js';
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
        const pdfDir = path.join(options.targetDirectory, 'PDFs');

        // Téléchargement dans un fichier temporaire : un transfert interrompu
        // ne laisse jamais un PDF tronqué à la place d'un bon. Un temporaire
        // par appel : nommé par la seule clé, il était commun à deux
        // téléchargements de la même pièce jointe, et le premier fini emportait
        // celui de l'autre (ENOENT au rename, S07-1-4). La clé sert à le
        // nommer : elle est validée avant, et le chemin doit rester dans PDFs/.
        assertSafeAttachmentKey(options.attachmentKey);
        await mkdir(pdfDir, { recursive: true });
        const temporary = path.join(pdfDir, `.${options.attachmentKey}.${randomUUID()}.part`);
        assertInside(pdfDir, temporary);
        transfersInProgress.add(path.basename(temporary));
        let savePath: string;
        try {
          await sweepAbandonedTemporaries(pdfDir);
          await ds.downloadFile(options.attachmentKey, temporary);
          // Le nom se décide une fois le fichier là, un téléchargement à la fois
          // dans ce dossier : décidé avant le transfert, il paraissait libre aux
          // deux appels simultanés, et le second écrasait le premier (S07-1-4).
          // Le verrou ne couvre jamais le réseau.
          savePath = await withFileLock(pdfDir, () => moveIntoPdfDir(temporary, pdfDir, options));
        } finally {
          await rm(temporary, { force: true });
          transfersInProgress.delete(path.basename(temporary));
        }

        if (savePath !== path.join(pdfDir, sanitizeAttachmentFilename(options.filename))) {
          console.log(`✅ PDF obtained under a unique name (name already taken): ${path.basename(savePath)}`);
        } else {
          console.log(`✅ PDF obtained: ${path.basename(savePath)}`);
        }

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
   * Premier appel sans `confirmation` : si la synchronisation retirerait des
   * références ou changerait de collection, rien n'est écrit et le rapport
   * revient pour confirmation. L'accord renvoyé ne couvre que ce rapport :
   * une suppression qu'il ne montrait pas en redemande un.
   */
  async synchronizeProject(options: ZoteroSourceOptions & {
    projectPath: string;
    collectionKey: string;
    confirmation?: SyncConfirmation;
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
    /** `metadata-unreadable-after-bib` : le nom du `.bib`, déjà réécrit. */
    bibFile?: string;
  } & SyncRefusalDetails> {
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
          confirmation: options.confirmation,
          bibDir: path.dirname(bibtexPath),
        });

        if (result.status === 'needs-confirmation') {
          return { success: true, status: result.status, report: result.report, bibtexPath };
        }

        const mustWrite = result.changed || !existsSync(bibtexPath);
        if (mustWrite) {
          // Écriture atomique, après une copie de l'état d'avant : un fichier à moitié écrit
          // (coupure, OneDrive au mauvais moment) perdrait la bibliographie. `result.bibtex` n'a
          // que des entrées : ce que le fichier porte hors d'elles (groupes BibDesk et JabRef,
          // @comment, @preamble, texte libre) est repris du fichier en place (H2).
          await rewriteProjectBibliography(options.projectPath, bibtexPath, result.bibtex, { keepOutsideEntries: true });
          // Une clé refaite ne doit pas couper une note de lecture de sa
          // référence : la note suit (front matter et nom de fichier). Elle
          // suit le `.bib`, qui porte déjà les nouvelles clés, avant les
          // métadonnées : un échec de celles-ci la laissait sur l'ancienne
          // clé, et la synchronisation suivante, qui ne refait plus rien, ne
          // la rattrapait pas.
          try {
            await followRenamedCitekeys(options.projectPath, result.report.renamedKeys);
            indexReadingNotesInBackground('clés de citation refaites');
          } catch (error) {
            console.warn('⚠️ Notes de lecture non renommées :', error);
          }
          await saveSyncedMetadata(options.projectPath, bibtexPath, result.citations);
        }

        await recordProjectCollection(projectJsonPath, relativeBib, options.collectionKey);

        const bibtexKeyToCollections = collectionsByCiteKey(result.citations, result.items);
        const allCollections = (await ds.listCollections()).map((c) => ({
          key: c.key,
          name: c.data.name,
          parentKey: c.data.parentCollection || undefined,
        }));
        // Seulement les collections du projet, pas toute la bibliothèque (#130).
        const collections = collectionsForProject(
          allCollections,
          options.collectionKey || savedCollectionKey,
          bibtexKeyToCollections,
        );

        return {
          success: true,
          status: 'applied',
          report: result.report,
          written: mustWrite,
          bibtexPath,
          collections,
          bibtexKeyToCollections,
        };
      } finally {
        this.closeDataSource(ds);
      }
    } catch (error: unknown) {
      console.error('Zotero synchronization failed:', error);
      if (error instanceof MetadataUnreadableAfterBibError) {
        return { success: false, error: error.code, file: error.metadataFile, bibFile: error.bibFile };
      }
      return syncRefusal(error) ?? { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

/**
 * Le `.bib` du projet ne se lit pas, avant toute lecture de Zotero. Distinct des autres
 * `UnreadableFileError` : un `project.json` illisible à la fin de la synchronisation arrive après
 * l'écriture, et ne doit pas se dire « rien n'a été écrit ».
 */
class BibFileUnreadableError extends UnreadableFileError {}

/** Le `.bib` lu, mais pas en entier : le réécrire effacerait ce que le parseur a laissé. */
class BibUnreadError extends Error {
  readonly code = 'bib-unread';
  readonly filePath: string;
  readonly unreadKeys: string[];
  readonly unreadFromZotero: string[];

  constructor(filePath: string, audit: BibAudit) {
    super(`${path.basename(filePath)} n'a pas été lu en entier ; synchronisation interrompue pour ne rien effacer.`);
    this.name = 'BibUnreadError';
    this.filePath = filePath;
    this.unreadKeys = audit.unreadKeys;
    this.unreadFromZotero = audit.unreadFromZotero;
  }
}

/**
 * Une synchronisation refusée avant toute lecture de Zotero, parce que le `.bib` ou les
 * métadonnées sont mal lus : `error` vaut `bib-unread`, `bib-unreadable` ou `metadata-unreadable`,
 * et ces champs disent ce qui est en cause. Le renderer en fait un message : le code ne s'affiche
 * jamais tel quel.
 */
interface SyncRefusalDetails {
  /** Le fichier en cause, relatif au projet. */
  file?: string;
  unreadKeys?: string[];
  /** Parmi `unreadKeys`, les entrées venues de Zotero : à corriger sans les supprimer. */
  unreadFromZotero?: string[];
  /** Raison de `readUserFile` (`encoding`, `permission`…), et message du système. */
  reason?: string;
  detail?: string;
}

function syncRefusal(error: unknown): ({ success: false; error: string } & SyncRefusalDetails) | null {
  if (error instanceof BibUnreadError) {
    return {
      success: false,
      error: 'bib-unread',
      file: path.basename(error.filePath),
      unreadKeys: error.unreadKeys,
      unreadFromZotero: error.unreadFromZotero,
    };
  }
  if (error instanceof BibFileUnreadableError) {
    return {
      success: false,
      error: 'bib-unreadable',
      file: path.basename(error.filePath),
      reason: error.reason,
      detail: error.message,
    };
  }
  if (error instanceof MetadataUnreadableError) {
    return { success: false, error: 'metadata-unreadable', file: path.join('.cliodeck', path.basename(error.filePath)) };
  }
  return null;
}

interface ProjectJson {
  bibliographySource?: { type: 'file' | 'zotero'; filePath?: string; zoteroCollection?: string };
  zotero?: { collectionKey?: string; groupId?: string; libraryID?: number };
  [key: string]: unknown;
}

async function readProjectJson(projectJsonPath: string): Promise<ProjectJson> {
  if (!existsSync(projectJsonPath)) return {};
  return parseUserJson<ProjectJson>(await readFile(projectJsonPath, 'utf-8'));
}

/**
 * Bibliographie actuelle du projet : le fichier, enrichi des métadonnées
 * (PDF Zotero, téléchargements). Un fichier présent mais illisible arrête
 * tout : le traiter comme vide ferait tout « ajouter » depuis Zotero et
 * effacerait à l'écriture les entrées qu'il contenait. Une seule entrée que
 * le parseur n'a pas rendue, ou une définition `@string` qu'il n'a pas lue,
 * arrête tout aussi : la réécriture partirait des seules entrées lues
 * (S07-1-2). Celles qu'il lit, il les développe, et la réécriture écrit les
 * valeurs développées (L05-7). Des métadonnées illisibles, même sans `.bib`
 * encore écrit, de même (S07-1-10).
 */
async function readLocalBibliography(bibtexPath: string, projectPath: string): Promise<Citation[]> {
  const read = await readBibFile(bibtexPath);
  if (read.kind === 'unreadable') throw new BibFileUnreadableError(bibtexPath, read.reason, read.message);
  if (read.kind === 'ok' && read.unreadKeys.length > 0) {
    throw new BibUnreadError(bibtexPath, read);
  }
  const metadata = await BibliographyMetadataService.loadMetadata(projectPath);
  return BibliographyMetadataService.mergeCitationsWithMetadata(read.kind === 'ok' ? read.citations : [], metadata, projectPath);
}

/**
 * Les métadonnées, devenues illisibles pendant la synchronisation, après la réécriture du `.bib` :
 * `error` vaut `metadata-unreadable-after-bib`, et le renderer en fait le message (le `.bib` mis à
 * jour, les métadonnées non réécrites). Ce n'est pas le refus `metadata-unreadable` d'avant toute
 * lecture de Zotero, qui dit « rien n'a été écrit ».
 */
class MetadataUnreadableAfterBibError extends Error {
  readonly code = 'metadata-unreadable-after-bib';
  /** Nommés comme dans les refus : le `.bib` par son nom, les métadonnées relatives au projet. */
  readonly bibFile: string;
  readonly metadataFile: string;

  constructor(bibtexPath: string, cause: MetadataUnreadableError) {
    super(`${path.basename(bibtexPath)} mis à jour, mais ${cause.filePath} est devenu illisible : ${cause.message}`);
    this.name = 'MetadataUnreadableAfterBibError';
    this.bibFile = path.basename(bibtexPath);
    this.metadataFile = path.join('.cliodeck', path.basename(cause.filePath));
  }
}

/**
 * Les métadonnées que la synchronisation a lues, écrites sur le fichier relu à ce moment : un PDF
 * rattaché pendant la lecture de Zotero garde son rattachement (S07-1-6). Devenues illisibles
 * entre-temps, elles ne sont pas réécrites (`MetadataUnreadableAfterBibError`).
 */
async function saveSyncedMetadata(projectPath: string, bibtexPath: string, citations: Citation[]): Promise<void> {
  try {
    await BibliographyMetadataService.saveFromSync(projectPath, citations);
  } catch (error: unknown) {
    if (!(error instanceof MetadataUnreadableError)) throw error;
    throw new MetadataUnreadableAfterBibError(bibtexPath, error);
  }
}

/**
 * Mémorise dans `project.json` la collection que suit la bibliographie, sous le verrou du fichier :
 * la synchronisation dure, et le plan ou les réglages ont pu changer pendant ce temps.
 */
export async function recordProjectCollection(
  projectJsonPath: string,
  bibFile: string,
  collectionKey: string
): Promise<void> {
  await updateJsonFile<ProjectJson>(projectJsonPath, (project) => {
    if (project === null) return null;
    if (typeof project !== 'object' || Array.isArray(project)) {
      throw new UnreadableFileError(projectJsonPath, 'invalid-json', `${projectJsonPath} n'est pas un manifeste de projet`);
    }
    const already =
      project.bibliographySource?.type === 'zotero' &&
      project.bibliographySource.zoteroCollection === collectionKey &&
      project.bibliographySource.filePath === bibFile &&
      project.zotero?.collectionKey === collectionKey;
    if (already) return null;

    // `path` se déduit de l'emplacement du fichier : ne jamais l'y écrire (#13).
    const { path: _computed, ...toSave } = project;
    return {
      ...toSave,
      bibliographySource: { type: 'zotero', filePath: bibFile, zoteroCollection: collectionKey },
      zotero: { ...(project.zotero ?? {}), collectionKey },
      updatedAt: new Date().toISOString(),
    };
  });
}

/**
 * Les temporaires des transferts en cours dans ce processus, par leur nom (unique par son uuid,
 * quel que soit le chemin qui désigne le projet) : le balayage n'y touche jamais.
 */
const transfersInProgress = new Set<string>();

/**
 * Un temporaire de téléchargement : `.<clé>.<uuid>.part`, ou `.<clé Zotero>.part` des versions
 * d'avant le temporaire par appel. Rien d'autre : un fichier de l'historien n'a pas ce nom.
 */
const DOWNLOAD_TEMPORARY =
  /^\.(?:[A-Za-z0-9]{1,32}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Z0-9]{8})\.part$/;

/** Un temporaire que rien n'a modifié depuis ce délai n'est plus celui d'un transfert. */
const TEMPORARY_ABANDONED_AFTER_MS = 60 * 60 * 1000;

/**
 * Retire de `PDFs/` les temporaires de transferts interrompus : l'app tuée ou plantée pendant un
 * transfert n'exécute pas le `finally` qui les retire, et un nom par appel ne se réécrit plus au
 * téléchargement suivant ; ils restaient à jamais, cachés. Jamais le temporaire d'un transfert en
 * cours : ni ceux de ce processus, ni un fichier modifié depuis moins d'une heure (un autre
 * ClioDeck ouvert sur ce projet). Un échec du balayage n'arrête pas le téléchargement.
 */
async function sweepAbandonedTemporaries(pdfDir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(pdfDir);
  } catch (error: unknown) {
    console.warn('⚠️ Temporaires de téléchargement non balayés :', error);
    return;
  }
  for (const name of names) {
    if (!DOWNLOAD_TEMPORARY.test(name)) continue;
    const file = path.join(pdfDir, name);
    try {
      const { mtimeMs } = await stat(file);
      // Après l'attente : un transfert de ce processus a pu commencer entre-temps.
      if (transfersInProgress.has(name) || Date.now() - mtimeMs < TEMPORARY_ABANDONED_AFTER_MS) continue;
      await rm(file, { force: true });
      console.log(`🧹 Temporaire de téléchargement abandonné retiré : ${name}`);
    } catch (error: unknown) {
      // Parti entre-temps (transfert fini), ou pas le droit : le suivant.
      console.warn(`⚠️ Temporaire de téléchargement non balayé : ${name}`, error);
    }
  }
}

/**
 * Met le PDF téléchargé à sa place dans `PDFs/`, sous le verrou de ce dossier : les propriétaires
 * relus ici voient les rattachements écrits pendant le transfert. Jamais écraser le fichier d'une
 * autre pièce jointe (#131) : deux pièces jointes de même nom — « AAAA - Documents
 * sauvegardés.pdf » d'Europresse — se remplaçaient, et une référence perdait son PDF.
 */
async function moveIntoPdfDir(
  temporary: string,
  pdfDir: string,
  options: { attachmentKey: string; filename: string; targetDirectory: string }
): Promise<string> {
  const decision = chooseAttachmentDestination({
    pdfDir,
    filename: options.filename,
    attachmentKey: options.attachmentKey,
    owners: await downloadedAttachmentOwners(options.targetDirectory),
    exists: existsSync,
  });
  assertInside(pdfDir, decision.path);
  if (decision.kind === 'compare') assertInside(pdfDir, decision.fallback);

  let savePath = decision.path;
  if (decision.kind === 'compare') {
    // Un fichier de ce nom existe sans propriétaire connu : identique,
    // on le garde ; différent, on ne le remplace pas.
    if (await sameContent(temporary, decision.path)) {
      console.log(`✅ PDF déjà présent, identique : ${path.basename(savePath)}`);
      return savePath;
    }
    savePath = decision.fallback;
  }
  await rename(temporary, savePath);
  return savePath;
}

/** Clé BibTeX → collections Zotero de la notice correspondante. */
/**
 * Pièces jointes déjà téléchargées du projet, et le fichier de chacune. Des métadonnées
 * illisibles n'en disent rien : aucun propriétaire connu, et la comparaison de contenu protège
 * alors les fichiers en place.
 */
async function downloadedAttachmentOwners(projectPath: string): Promise<AttachmentOwner[]> {
  let metadata: BibliographyMetadataFile | null = null;
  try {
    metadata = await BibliographyMetadataService.loadMetadata(projectPath);
  } catch (error: unknown) {
    if (!(error instanceof MetadataUnreadableError)) throw error;
    console.warn('⚠️ Métadonnées bibliographiques illisibles : propriétaires des PDF inconnus', error.message);
  }
  const owners: AttachmentOwner[] = [];
  for (const entry of Object.values(metadata?.citations ?? {})) {
    for (const attachment of entry.zoteroAttachments ?? []) {
      if (attachment.downloaded && attachment.localPath) {
        // Rangé relatif au projet, ou absolu d'un projet depuis renommé (S07-2-1).
        owners.push({ attachmentKey: attachment.key, localPath: fromStoredPath(attachment.localPath, projectPath) });
      }
    }
  }
  return owners;
}

async function sameContent(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([readFile(a), readFile(b)]);
  return x.equals(y);
}

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
