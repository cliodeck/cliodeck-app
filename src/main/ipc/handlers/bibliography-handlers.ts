/**
 * Bibliography IPC handlers
 */
import path from 'path';
import { ipcMain } from 'electron';
import {
  BibliographyMissingError,
  BibNotFullyReadError,
  bibliographyService,
  mergeIntoProjectBibliography,
  readBibFile,
  rewriteProjectBibliography,
  type BibFileRead,
} from '../../services/bibliography-service.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';
import { OrphanPDFDetector } from '../../../../backend/services/OrphanPDFDetector.js';
import {
  BibliographyMetadataService,
  MetadataUnreadableError,
  type BibliographyMetadataFile,
} from '../../../../backend/services/BibliographyMetadataService.js';
import { validateReadPath, validateWritePath } from '../utils/path-validator.js';
import { authorizeDocumentPath } from '../utils/document-path-authorization.js';
import {
  validate,
  StringPathSchema,
  StringContentSchema,
  BibliographyExportSchema,
  BibliographyExportStringSchema,
  BibliographyDetectOrphanPdfsSchema,
  BibliographyDeleteOrphanPdfsSchema,
  BibliographyArchiveOrphanPdfsSchema,
  BibliographyUpdateAttachmentSchema,
  BibliographyLoadWithMetadataSchema,
  BibliographyGetStatisticsSchema,
  BibliographyImportSchema,
  ReadingNoteOpenSchema,
  ReadingNoteSetTagsSchema,
} from '../utils/validation.js';
import { projectManager } from '../../services/project-manager.js';
import { indexReadingNotesInBackground } from '../../services/reading-notes-indexing.js';
import {
  ensureReadingNote,
  listReadingNotes,
  setProjectTags,
} from '../../../../backend/core/bibliography/readingNotes.js';
import { UnreadableFileError, withFileLock } from '../../../../backend/core/fs/user-files.js';
import { isInsideAsync, sameFile } from '../../../../backend/core/vector-store/file-identity.js';

/**
 * Confine renderer-supplied orphan-PDF paths to the current project. Rejected
 * paths are reported through the same `failed` channel the UI already renders,
 * so one bad path never blocks the rest of the batch.
 */
async function partitionWritablePaths(filePaths: string[]): Promise<{
  allowed: string[];
  rejected: { path: string; error: string }[];
}> {
  const allowed: string[] = [];
  const rejected: { path: string; error: string }[] = [];
  for (const filePath of filePaths) {
    try {
      allowed.push(await validateWritePath(filePath));
    } catch (error) {
      rejected.push({
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { allowed, rejected };
}

/**
 * Un `.bib` absent ou illisible n'est pas une bibliographie vide : le panneau le dit en bandeau,
 * au lieu de se montrer vide (S07-1-11).
 */
function bibliographyLoadFailure(error: unknown) {
  if (error instanceof BibliographyMissingError) {
    return { ...errorResponse(error), citations: [], problem: 'missing' as const };
  }
  if (error instanceof UnreadableFileError) {
    return { ...errorResponse(error), citations: [], problem: 'unreadable' as const, reason: error.reason };
  }
  return { ...errorResponse(error), citations: [] };
}

/**
 * La fusion refusée, avant toute écriture, parce que le `.bib` du projet ne s'est pas lu en entier :
 * les codes de la synchronisation Zotero, que le renderer traduit. Ils ne s'affichent jamais tels quels.
 */
function mergeRefusal(error: unknown) {
  if (error instanceof BibNotFullyReadError) {
    return { success: false as const, error: 'bib-unread', file: path.basename(error.filePath), unreadKeys: error.unreadKeys };
  }
  if (error instanceof UnreadableFileError) {
    return {
      success: false as const,
      error: 'bib-unreadable',
      file: path.basename(error.filePath),
      reason: error.reason,
      detail: error.message,
    };
  }
  return null;
}

/**
 * Le `.bib` du projet tel qu'il est sur le disque après l'import : le total annoncé est le sien. Le
 * main le reprend pour les exports et l'aperçu, si le projet ouvert est encore celui de l'import.
 */
async function rereadAfterImport(projectPath: string, bibPath: string): Promise<number> {
  const current = projectManager.getCurrentProjectPath();
  if (current && sameFile(current, projectPath)) {
    return (await bibliographyService.loadFromFile(bibPath)).citations.length;
  }
  const read = await readBibFile(bibPath);
  if (read.kind === 'absent') throw new BibliographyMissingError(bibPath);
  if (read.kind === 'unreadable') throw new UnreadableFileError(bibPath, read.reason, read.message);
  return read.citations.length;
}

export function setupBibliographyHandlers() {
  ipcMain.handle('bibliography:load', async (_event, rawFilePath: unknown) => {
    try {
      const filePath = validate(StringPathSchema, rawFilePath);
      const { citations, unreadKeys } = await bibliographyService.loadFromFile(filePath);
      return successResponse({ citations, unreadKeys });
    } catch (error: unknown) {
      console.error('❌ bibliography:load error:', error);
      return bibliographyLoadFailure(error);
    }
  });

  // Importer un `.bib` dans le projet ouvert (S07-1-3). Le main lit la source, écrit le fichier du
  // projet et le relit : « Fusionner » y écrit la fusion, « Remplacer » y met le fichier importé sous
  // son nom. Avant, la fusion ne vivait que dans le panneau, et la copie du renderer écrasait.
  ipcMain.handle('bibliography:import', async (_event, rawOptions: unknown) => {
    const { sourcePath, mode, expectedProjectPath } = validate(BibliographyImportSchema, rawOptions);
    // Le projet vient du processus principal : c'est lui qu'on va réécrire. Lu une fois, avant tout
    // `await`, et refusé si ce n'est plus celui où l'on a cliqué.
    const projectPath = projectManager.getCurrentProjectPath();
    if (!projectPath) {
      return errorResponse(new Error('Aucun projet ouvert.'));
    }
    if (!sameFile(projectPath, expectedProjectPath)) {
      console.warn('⚠️ bibliography:import refusé : le projet a changé depuis la demande');
      return errorResponse('project-changed');
    }
    console.log('📞 IPC Call: bibliography:import', { sourcePath, mode });

    // La source, lue sans passer par le singleton : un import qui échoue ne doit rien y laisser.
    let source: string;
    let read: Extract<BibFileRead, { kind: 'ok' }>;
    try {
      // Hors du projet, seul un fichier choisi dans le dialogue se lit (S11-1-9).
      source = await authorizeDocumentPath(sourcePath, 'read');
      const sourceRead = await readBibFile(source);
      if (sourceRead.kind === 'absent') throw new BibliographyMissingError(source);
      if (sourceRead.kind === 'unreadable') throw new UnreadableFileError(source, sourceRead.reason, sourceRead.message);
      read = sourceRead;
    } catch (error: unknown) {
      console.error('❌ bibliography:import, source refusée ou illisible :', error);
      return bibliographyLoadFailure(error);
    }

    try {
      const projectFile = path.join(projectPath, 'project.json');
      // Sur le disque, et non en mémoire : une synchronisation Zotero a pu y poser la source.
      const manifest = await projectManager.getConfig(projectFile);
      const declared = manifest?.bibliographySource;
      let bibPath: string;
      let newCitations = 0;
      let duplicates = 0;
      if (mode === 'merge') {
        // Sans project.json, on ne sait pas dans quel fichier fusionner : rien n'est écrit.
        if (!manifest) return { success: false, error: 'project-unreadable' };
        bibPath = path.resolve(projectPath, declared?.filePath || 'bibliography.bib');
        try {
          ({ newCount: newCitations, duplicates } = await mergeIntoProjectBibliography(projectPath, bibPath, read.citations));
        } catch (error: unknown) {
          const refusal = mergeRefusal(error);
          if (!refusal) throw error;
          console.warn('⚠️ bibliography:import, fusion refusée :', error);
          return refusal;
        }
      } else {
        // Un homonyme rangé ailleurs ne remplace le `.bib` du projet qu'après sa copie de sécurité.
        // Le contenu brut, pas réexporté : un `@comment` ou un `@preamble` de la source reste.
        bibPath = path.join(projectPath, path.basename(source));
        if (!sameFile(source, bibPath)) {
          // Ce nom, dans le projet, peut être un lien vers un fichier rangé ailleurs (une bibliographie
          // commune, un lien venu avec un projet partagé) : l'écriture le suivrait, et la copie de
          // sécurité ferait entrer ce fichier dans le projet. `fs:copy-file` le refusait, cet import aussi.
          if (!(await isInsideAsync(projectPath, bibPath))) {
            console.warn('⚠️ bibliography:import, remplacement refusé : la cible mène hors du projet', bibPath);
            return { success: false, error: 'bib-outside-project', file: path.basename(bibPath) };
          }
          await withFileLock(bibPath, () => rewriteProjectBibliography(projectPath, bibPath, read.content));
        }
      }

      // `setBibliographySource` efface ce qu'on ne lui repasse pas : le type et la collection Zotero
      // en place y retournent. « Fusionner » n'y touche pas si le projet avait déjà son fichier.
      const saved =
        mode === 'merge' && declared?.filePath
          ? { success: true }
          : await projectManager.setBibliographySource({
              projectPath: projectFile,
              type: declared?.type ?? 'file',
              filePath: path.basename(bibPath),
              zoteroCollection: declared?.zoteroCollection,
            });

      const total = await rereadAfterImport(projectPath, bibPath);
      console.log('📤 IPC Response: bibliography:import', { bibPath, total, newCitations, duplicates, sourceSaved: saved.success });
      return successResponse({
        bibPath,
        total,
        newCitations,
        duplicates,
        unreadKeys: read.unreadKeys,
        sourceSaved: saved.success === true,
        ...('error' in saved && saved.error ? { sourceError: saved.error } : {}),
      });
    } catch (error: unknown) {
      console.error('❌ bibliography:import error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('bibliography:parse', async (_event, rawContent: unknown) => {
    try {
      const content = validate(StringContentSchema, rawContent);
      const citations = await bibliographyService.parseContent(content);
      return successResponse({ citations });
    } catch (error: unknown) {
      console.error('❌ bibliography:parse error:', error);
      return { ...errorResponse(error), citations: [] };
    }
  });

  ipcMain.handle('bibliography:search', async (_event, rawQuery: unknown) => {
    try {
      // Accept an empty string: the renderer calls search('') as a
      // "list all" shortcut (e.g. CitationStyleSection). The service
      // itself handles the empty case by returning every citation.
      const query = typeof rawQuery === 'string' ? rawQuery : '';
      const citations = bibliographyService.searchCitations(query);
      return successResponse({ citations });
    } catch (error: unknown) {
      console.error('❌ bibliography:search error:', error);
      return { ...errorResponse(error), citations: [] };
    }
  });

  ipcMain.handle('bibliography:get-statistics', async (_event, rawCitations?: unknown) => {
    const { citations } = validate(BibliographyGetStatisticsSchema, { citations: rawCitations });
    console.log('📞 IPC Call: bibliography:get-statistics', {
      citationCount: citations?.length || 'using stored citations'
    });
    try {
      const statistics = bibliographyService.generateStatistics(citations as any);
      console.log('📤 IPC Response: bibliography:get-statistics', {
        totalCitations: statistics.totalCitations,
        totalAuthors: statistics.totalAuthors,
        yearRange: statistics.yearRange
      });
      return successResponse({ statistics });
    } catch (error: unknown) {
      console.error('❌ bibliography:get-statistics error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('bibliography:export', async (_event, rawOptions: unknown) => {
    const options = validate(BibliographyExportSchema, rawOptions);
    console.log('📞 IPC Call: bibliography:export', {
      citationCount: options.citations.length,
      filePath: options.filePath,
      format: options.format || 'modern'
    });
    try {
      await bibliographyService.exportToFile(options.citations as any[], options.filePath);
      console.log('📤 IPC Response: bibliography:export - Success');
      return successResponse({ success: true });
    } catch (error: unknown) {
      console.error('❌ bibliography:export error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('bibliography:detect-orphan-pdfs', async (_event, rawOptions: unknown) => {
    const options = validate(BibliographyDetectOrphanPdfsSchema, rawOptions);
    console.log('📞 IPC Call: bibliography:detect-orphan-pdfs', {
      projectPath: options.projectPath,
      citationCount: options.citations.length,
      includeSubdirectories: options.includeSubdirectories,
      pdfSubdirectory: options.pdfSubdirectory
    });
    try {
      await validateReadPath(options.projectPath);
      const detector = new OrphanPDFDetector();
      const result = await detector.detectOrphans(options as any);
      console.log('📤 IPC Response: bibliography:detect-orphan-pdfs', {
        totalOrphans: result.totalOrphans,
        totalSize: OrphanPDFDetector.formatFileSize(result.totalSize),
        scannedFiles: result.scannedFiles
      });
      return successResponse(result);
    } catch (error: unknown) {
      console.error('❌ bibliography:detect-orphan-pdfs error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('bibliography:delete-orphan-pdfs', async (_event, rawFilePaths: unknown) => {
    const filePaths = validate(BibliographyDeleteOrphanPdfsSchema, rawFilePaths);
    console.log('📞 IPC Call: bibliography:delete-orphan-pdfs', {
      fileCount: filePaths.length
    });
    try {
      const { allowed, rejected } = await partitionWritablePaths(filePaths);
      const detector = new OrphanPDFDetector();
      const result = await detector.deleteOrphans(allowed);
      result.failed.push(...rejected);
      console.log('📤 IPC Response: bibliography:delete-orphan-pdfs', {
        deleted: result.deleted,
        failed: result.failed.length
      });
      return successResponse(result);
    } catch (error: unknown) {
      console.error('❌ bibliography:delete-orphan-pdfs error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('bibliography:archive-orphan-pdfs', async (_event, rawOptions: unknown) => {
    const options = validate(BibliographyArchiveOrphanPdfsSchema, rawOptions);
    console.log('📞 IPC Call: bibliography:archive-orphan-pdfs', {
      fileCount: options.filePaths.length,
      projectPath: options.projectPath,
      archiveSubdir: options.archiveSubdir
    });
    try {
      const projectPath = await validateWritePath(options.projectPath);
      const { allowed, rejected } = await partitionWritablePaths(options.filePaths);
      const detector = new OrphanPDFDetector();
      const result = await detector.archiveOrphans(
        allowed,
        projectPath,
        options.archiveSubdir
      );
      result.failed.push(...rejected);
      console.log('📤 IPC Response: bibliography:archive-orphan-pdfs', {
        archived: result.archived,
        failed: result.failed.length,
        archivePath: result.archivePath
      });
      return successResponse(result);
    } catch (error: unknown) {
      console.error('❌ bibliography:archive-orphan-pdfs error:', error);
      return errorResponse(error);
    }
  });

  // Rattache un PDF Zotero téléchargé à sa pièce jointe, et rien d'autre : le fichier relu sous son
  // verrou, pas la liste du renderer, prise avant le téléchargement (S07-1-5).
  ipcMain.handle('bibliography:update-attachment', async (_event, rawOptions: unknown) => {
    const options = validate(BibliographyUpdateAttachmentSchema, rawOptions);
    console.log('📞 IPC Call: bibliography:update-attachment', {
      projectPath: options.projectPath,
      citationId: options.citation.id,
      attachmentKey: options.attachmentKey,
    });
    // Les références d'un autre projet, enregistrées sous celui-ci par un lot qui a survécu à la
    // bascule, y écrivaient leurs rattachements (S18-2-0).
    const currentProject = projectManager.getCurrentProjectPath();
    if (!currentProject) {
      return errorResponse(new Error('Aucun projet ouvert.'));
    }
    if (!sameFile(currentProject, options.projectPath)) {
      console.warn('⚠️ bibliography:update-attachment refusé : ce n\'est pas le projet ouvert');
      return errorResponse('project-changed');
    }
    try {
      await BibliographyMetadataService.patchAttachment(
        options.projectPath,
        options.citation,
        options.attachmentKey,
        options.localPath
      );
      console.log('📤 IPC Response: bibliography:update-attachment - Success');
      return successResponse({ success: true });
    } catch (error: unknown) {
      console.error('❌ bibliography:update-attachment error:', error);
      // Illisibles, les métadonnées ne sont pas réécrites : le PDF reste dans PDFs/ sans rattachement,
      // et le renderer le dit dans les mots du bandeau.
      return error instanceof MetadataUnreadableError
        ? { ...errorResponse(error), code: error.code }
        : errorResponse(error);
    }
  });

  // Load bibliography metadata
  // Load bibliography with metadata merged
  ipcMain.handle('bibliography:load-with-metadata', async (_event, rawOptions: unknown) => {
    const options = validate(BibliographyLoadWithMetadataSchema, rawOptions);
    console.log('📞 IPC Call: bibliography:load-with-metadata', {
      filePath: options.filePath,
      projectPath: options.projectPath
    });
    try {
      // Load citations from BibTeX
      const { citations, unreadKeys } = await bibliographyService.loadFromFile(options.filePath);

      // Des métadonnées illisibles ne cachent pas les références : elles s'affichent sans leurs
      // PDF Zotero, et le bandeau dit pourquoi. La synchronisation, elle, refuse de les réécrire.
      let metadata: BibliographyMetadataFile | null = null;
      let metadataUnreadable = false;
      try {
        metadata = await BibliographyMetadataService.loadMetadata(options.projectPath);
      } catch (error: unknown) {
        if (!(error instanceof MetadataUnreadableError)) throw error;
        console.warn('⚠️ Métadonnées bibliographiques illisibles :', error.message);
        metadataUnreadable = true;
      }
      const mergedCitations = BibliographyMetadataService.mergeCitationsWithMetadata(citations, metadata);

      console.log('📤 IPC Response: bibliography:load-with-metadata', {
        totalCitations: mergedCitations.length,
        withMetadata: metadata ? Object.keys(metadata.citations).length : 0,
        unread: unreadKeys.length,
        metadataUnreadable,
      });

      return successResponse({ citations: mergedCitations, unreadKeys, metadataUnreadable });
    } catch (error: unknown) {
      console.error('❌ bibliography:load-with-metadata error:', error);
      // C'est le chargement de la bibliographie du projet ouvert (à l'ouverture, après une
      // synchronisation) : le panneau se vide, le main aussi. `bibliography:load`, qui sert à
      // l'import, garde la sienne quand le fichier importé ne se lit pas.
      bibliographyService.forget();
      return bibliographyLoadFailure(error);
    }
  });

  // MARK: - Notes de lecture et étiquettes du projet
  //
  // Le projet vient du processus principal : le renderer ne désigne qu'une
  // référence, jamais un chemin où écrire.

  ipcMain.handle('bibliography:reading-notes:list', async () => {
    const projectPath = projectManager.getCurrentProjectPath();
    if (!projectPath) return successResponse({ notes: [] });
    try {
      const notes = await listReadingNotes(projectPath);
      return successResponse({ notes });
    } catch (error: unknown) {
      console.error('❌ bibliography:reading-notes:list error:', error);
      return { ...errorResponse(error), notes: [] };
    }
  });

  ipcMain.handle('bibliography:reading-notes:open', async (_event, rawReference: unknown) => {
    const reference = validate(ReadingNoteOpenSchema, rawReference);
    const projectPath = projectManager.getCurrentProjectPath();
    if (!projectPath) return errorResponse(new Error('Aucun projet ouvert.'));
    try {
      const file = await ensureReadingNote(projectPath, reference);
      return successResponse({ file });
    } catch (error: unknown) {
      console.error('❌ bibliography:reading-notes:open error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('bibliography:reading-notes:set-tags', async (_event, rawOptions: unknown) => {
    const { tags, ...reference } = validate(ReadingNoteSetTagsSchema, rawOptions);
    const projectPath = projectManager.getCurrentProjectPath();
    if (!projectPath) return errorResponse(new Error('Aucun projet ouvert.'));
    try {
      const note = await setProjectTags(projectPath, reference, tags);
      // Les étiquettes font partie de ce que la recherche retrouve.
      indexReadingNotesInBackground('étiquettes');
      return successResponse({ note });
    } catch (error: unknown) {
      console.error('❌ bibliography:reading-notes:set-tags error:', error);
      return error instanceof UnreadableFileError
        ? { ...errorResponse(error), code: 'unreadable', reason: error.reason }
        : errorResponse(error);
    }
  });

  console.log('✅ Bibliography handlers registered');
}
