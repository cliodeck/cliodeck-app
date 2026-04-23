/**
 * Bibliography IPC handlers
 */
import { ipcMain } from 'electron';
import { bibliographyService } from '../../services/bibliography-service.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';
import { OrphanPDFDetector } from '../../../../backend/services/OrphanPDFDetector.js';
import { BibliographyMetadataService } from '../../../../backend/services/BibliographyMetadataService.js';
import {
  validate,
  StringPathSchema,
  StringContentSchema,
  BibliographyExportSchema,
  BibliographyExportStringSchema,
  BibliographyDetectOrphanPdfsSchema,
  BibliographyDeleteOrphanPdfsSchema,
  BibliographyArchiveOrphanPdfsSchema,
  BibliographySaveMetadataSchema,
  BibliographyLoadWithMetadataSchema,
  BibliographyGetStatisticsSchema,
} from '../utils/validation.js';

export function setupBibliographyHandlers() {
  ipcMain.handle('bibliography:load', async (_event, rawFilePath: unknown) => {
    try {
      const filePath = validate(StringPathSchema, rawFilePath);
      const citations = await bibliographyService.loadFromFile(filePath);
      return successResponse({ citations });
    } catch (error: any) {
      console.error('❌ bibliography:load error:', error);
      return { ...errorResponse(error), citations: [] };
    }
  });

  ipcMain.handle('bibliography:parse', async (_event, rawContent: unknown) => {
    try {
      const content = validate(StringContentSchema, rawContent);
      const citations = await bibliographyService.parseContent(content);
      return successResponse({ citations });
    } catch (error: any) {
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
    } catch (error: any) {
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
    } catch (error: any) {
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
    } catch (error: any) {
      console.error('❌ bibliography:export error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('bibliography:export-string', async (_event, rawOptions: unknown) => {
    const options = validate(BibliographyExportStringSchema, rawOptions);
    console.log('📞 IPC Call: bibliography:export-string', {
      citationCount: options.citations.length,
      format: options.format || 'modern'
    });
    try {
      const content = options.format === 'legacy'
        ? bibliographyService.exportToStringLegacy(options.citations as any[])
        : bibliographyService.exportToString(options.citations as any[]);
      console.log('📤 IPC Response: bibliography:export-string - Success');
      return successResponse({ content });
    } catch (error: any) {
      console.error('❌ bibliography:export-string error:', error);
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
      const detector = new OrphanPDFDetector();
      const result = await detector.detectOrphans(options as any);
      console.log('📤 IPC Response: bibliography:detect-orphan-pdfs', {
        totalOrphans: result.totalOrphans,
        totalSize: OrphanPDFDetector.formatFileSize(result.totalSize),
        scannedFiles: result.scannedFiles
      });
      return successResponse(result);
    } catch (error: any) {
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
      const detector = new OrphanPDFDetector();
      const result = await detector.deleteOrphans(filePaths);
      console.log('📤 IPC Response: bibliography:delete-orphan-pdfs', {
        deleted: result.deleted,
        failed: result.failed.length
      });
      return successResponse(result);
    } catch (error: any) {
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
      const detector = new OrphanPDFDetector();
      const result = await detector.archiveOrphans(
        options.filePaths,
        options.projectPath,
        options.archiveSubdir
      );
      console.log('📤 IPC Response: bibliography:archive-orphan-pdfs', {
        archived: result.archived,
        failed: result.failed.length,
        archivePath: result.archivePath
      });
      return successResponse(result);
    } catch (error: any) {
      console.error('❌ bibliography:archive-orphan-pdfs error:', error);
      return errorResponse(error);
    }
  });

  // Save bibliography metadata (zoteroAttachments, etc.)
  ipcMain.handle('bibliography:save-metadata', async (_event, rawOptions: unknown) => {
    const options = validate(BibliographySaveMetadataSchema, rawOptions);
    console.log('📞 IPC Call: bibliography:save-metadata', {
      projectPath: options.projectPath,
      citationCount: options.citations.length
    });
    try {
      await BibliographyMetadataService.saveMetadata(options.projectPath, options.citations as any[]);
      console.log('📤 IPC Response: bibliography:save-metadata - Success');
      return successResponse({ success: true });
    } catch (error: any) {
      console.error('❌ bibliography:save-metadata error:', error);
      return errorResponse(error);
    }
  });

  // Load bibliography metadata
  ipcMain.handle('bibliography:load-metadata', async (_event, rawProjectPath: unknown) => {
    const projectPath = validate(StringPathSchema, rawProjectPath);
    console.log('📞 IPC Call: bibliography:load-metadata', { projectPath });
    try {
      const metadata = await BibliographyMetadataService.loadMetadata(projectPath);
      console.log('📤 IPC Response: bibliography:load-metadata', {
        hasMetadata: !!metadata,
        citationCount: metadata ? Object.keys(metadata.citations).length : 0
      });
      return successResponse({ metadata });
    } catch (error: any) {
      console.error('❌ bibliography:load-metadata error:', error);
      return errorResponse(error);
    }
  });

  // Load bibliography with metadata merged
  ipcMain.handle('bibliography:load-with-metadata', async (_event, rawOptions: unknown) => {
    const options = validate(BibliographyLoadWithMetadataSchema, rawOptions);
    console.log('📞 IPC Call: bibliography:load-with-metadata', {
      filePath: options.filePath,
      projectPath: options.projectPath
    });
    try {
      // Load citations from BibTeX
      const citations = await bibliographyService.loadFromFile(options.filePath);

      // Load and merge metadata
      const metadata = await BibliographyMetadataService.loadMetadata(options.projectPath);
      const mergedCitations = BibliographyMetadataService.mergeCitationsWithMetadata(citations, metadata);

      console.log('📤 IPC Response: bibliography:load-with-metadata', {
        totalCitations: mergedCitations.length,
        withMetadata: metadata ? Object.keys(metadata.citations).length : 0
      });

      return successResponse({ citations: mergedCitations });
    } catch (error: any) {
      console.error('❌ bibliography:load-with-metadata error:', error);
      return { ...errorResponse(error), citations: [] };
    }
  });

  console.log('✅ Bibliography handlers registered');
}
