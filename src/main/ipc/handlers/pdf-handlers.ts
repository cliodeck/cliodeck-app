/**
 * PDF indexing and search IPC handlers
 */
import { ipcMain, BrowserWindow } from 'electron';
import path from 'path';
import { projectManager } from '../../services/project-manager.js';
import { pdfService } from '../../services/pdf-service.js';
import { historyService } from '../../services/history-service.js';
import { successResponse, errorResponse, requireProject } from '../utils/error-handler.js';
import {
  validate,
  PDFSearchSchema,
  PDFExtractMetadataSchema,
  PDFIndexFullSchema,
  PDFCheckModifiedSchema,
  StringIdSchema,
} from '../utils/validation.js';
import { PDFModificationDetector } from '../../../../backend/services/PDFModificationDetector.js';
import { logger } from '../../utils/logger.js';

export function setupPDFHandlers() {
  ipcMain.handle('pdf:extractMetadata', async (_event, rawFilePath: unknown) => {
    const { filePath } = validate(PDFExtractMetadataSchema, { filePath: rawFilePath });
    logger.info('ipc', 'pdf:extractMetadata', { filePath });
    try {
      const metadata = await pdfService.extractPDFMetadata(filePath);
      logger.info('ipc', 'pdf:extractMetadata:response', { metadata });
      return successResponse({ metadata });
    } catch (error: any) {
      logger.error('ipc', 'pdf:extractMetadata', { error: error instanceof Error ? error.message : String(error) });
      return errorResponse(error);
    }
  });

  ipcMain.handle('pdf:index', async (event, rawFilePath: unknown, rawBibtexKey?: unknown, rawBibliographyMetadata?: unknown) => {
    const { filePath, bibtexKey, bibliographyMetadata } = validate(PDFIndexFullSchema, { filePath: rawFilePath, bibtexKey: rawBibtexKey, bibliographyMetadata: rawBibliographyMetadata });
    logger.info('ipc', 'pdf:index', { filePath, bibtexKey, bibliographyMetadata });
    const elapsed = logger.startTimer();

    try {
      const projectPath = projectManager.getCurrentProjectPath();
      requireProject(projectPath);
      logger.debug('ipc', 'pdf:index:project', { projectPath });

      // Initialize PDF service for this project

      const window = BrowserWindow.fromWebContents(event.sender);

      const document = await pdfService.indexPDF(filePath, bibtexKey, (progress) => {
        // Send progress updates to renderer
        if (window) {
          window.webContents.send('pdf:indexing-progress', progress);
        }
      }, bibliographyMetadata);

      const durationMs = elapsed();

      // Log PDF operation to history
      const hm = historyService.getHistoryManager();
      if (hm) {
        hm.logPDFOperation({
          operationType: 'import',
          documentId: document.id,
          filePath: path.basename(filePath),
          pageCount: document.pageCount,
          chunksCreated: (document as any).chunkCount || 0,
          citationsExtracted: (document as any).citationsCount || 0,
          durationMs,
          metadata: {
            title: document.title,
            author: document.author,
            year: document.year,
            bibtexKey: bibtexKey || document.bibtexKey,
          },
        });

        logger.info('ipc', 'pdf:index:history', {
          title: document.title,
          pageCount: document.pageCount,
          durationMs,
        });
      }

      logger.info('ipc', 'pdf:index:response', { durationMs });
      return successResponse({ document });
    } catch (error: any) {
      logger.error('ipc', 'pdf:index', { error: error instanceof Error ? error.message : String(error) });
      return errorResponse(error);
    }
  });

  ipcMain.handle('pdf:search', async (_event, query: string, options?: any) => {
    logger.info('ipc', 'pdf:search', { query: query.substring(0, 80) });
    try {
      const projectPath = projectManager.getCurrentProjectPath();
      requireProject(projectPath);

      // Validate search parameters
      const validatedData = validate(PDFSearchSchema, { query, options });

      const results = await pdfService.search(validatedData.query, validatedData.options);
      logger.info('ipc', 'pdf:search:response', { resultCount: results.length });
      return successResponse({ results });
    } catch (error: any) {
      logger.error('ipc', 'pdf:search', { error: error instanceof Error ? error.message : String(error) });
      return { ...errorResponse(error), results: [] };
    }
  });

  ipcMain.handle('pdf:delete', async (_event, rawDocumentId: unknown) => {
    const documentId = validate(StringIdSchema, rawDocumentId);
    try {
      const projectPath = projectManager.getCurrentProjectPath();
      requireProject(projectPath);

      await pdfService.deleteDocument(documentId);
      return successResponse();
    } catch (error: any) {
      console.error('❌ pdf:delete error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('pdf:purge', async () => {
    console.log('📞 IPC Call: pdf:purge');
    try {
      const projectPath = projectManager.getCurrentProjectPath();
      requireProject(projectPath);

      pdfService.purgeAllData();
      console.log('📤 IPC Response: pdf:purge - success');
      return successResponse();
    } catch (error: any) {
      console.error('❌ pdf:purge error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('pdf:clean-orphaned-chunks', async () => {
    console.log('📞 IPC Call: pdf:clean-orphaned-chunks');
    try {
      const projectPath = projectManager.getCurrentProjectPath();
      requireProject(projectPath);

      pdfService.cleanOrphanedChunks();
      console.log('📤 IPC Response: pdf:clean-orphaned-chunks - success');
      return successResponse();
    } catch (error: any) {
      console.error('❌ pdf:clean-orphaned-chunks error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('pdf:get-all', async () => {
    console.log('📞 IPC Call: pdf:get-all');
    try {
      const projectPath = projectManager.getCurrentProjectPath();
      requireProject(projectPath);

      const documents = await pdfService.getAllDocuments();
      console.log(`📤 IPC Response: pdf:get-all { documentCount: ${documents.length} }`);
      return successResponse({ documents });
    } catch (error: any) {
      console.error('❌ pdf:get-all error:', error);
      return { ...errorResponse(error), documents: [] };
    }
  });

  ipcMain.handle('pdf:get-document', async (_event, rawDocumentId: unknown) => {
    const documentId = validate(StringIdSchema, rawDocumentId);
    console.log('📞 IPC Call: pdf:get-document', { documentId });
    try {
      const projectPath = projectManager.getCurrentProjectPath();
      requireProject(projectPath);

      const document = await pdfService.getDocument(documentId);
      if (!document) {
        return { success: false, error: 'Document not found', document: null };
      }
      console.log(`📤 IPC Response: pdf:get-document { title: ${document.title} }`);
      return successResponse({ document });
    } catch (error: any) {
      console.error('❌ pdf:get-document error:', error);
      return { ...errorResponse(error), document: null };
    }
  });

  ipcMain.handle('pdf:get-statistics', async () => {
    console.log('📞 IPC Call: pdf:get-statistics');
    try {
      const projectPath = projectManager.getCurrentProjectPath();
      if (!projectPath) {
        console.log('⚠️ No project currently open');
        return {
          success: false,
          statistics: { totalDocuments: 0, totalChunks: 0, totalEmbeddings: 0 },
          error: 'No project is currently open.',
        };
      }

      console.log('📁 Using project path:', projectPath);
      const stats = await pdfService.getStatistics();
      console.log('📤 IPC Response: pdf:get-statistics', stats);

      // Map backend names to frontend names
      const statistics = {
        totalDocuments: stats.documentCount,
        totalChunks: stats.chunkCount,
        totalEmbeddings: stats.embeddingCount,
        databasePath: stats.databasePath,
      };
      return successResponse({ statistics });
    } catch (error: any) {
      console.error('❌ pdf:get-statistics error:', error);
      return {
        ...errorResponse(error),
        statistics: { totalDocuments: 0, totalChunks: 0, totalEmbeddings: 0 },
      };
    }
  });

  ipcMain.handle('pdf:check-modified-pdfs', async (_event, rawOptions: unknown) => {
    const options = validate(PDFCheckModifiedSchema, rawOptions);
    console.log('📞 IPC Call: pdf:check-modified-pdfs', {
      citationCount: options.citations.length,
      projectPath: options.projectPath
    });
    try {
      const detector = new PDFModificationDetector();
      const result = await detector.detectModifiedPDFs(options.citations as any);
      console.log('📤 IPC Response: pdf:check-modified-pdfs', {
        totalChecked: result.totalChecked,
        totalModified: result.totalModified
      });
      return successResponse(result);
    } catch (error: any) {
      console.error('❌ pdf:check-modified-pdfs error:', error);
      return errorResponse(error);
    }
  });

  console.log('✅ PDF handlers registered');
}
