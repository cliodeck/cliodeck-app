/**
 * Tropy integration IPC handlers
 */
import { ipcMain } from 'electron';
import { tropyService } from '../../services/tropy-service.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';

export function setupTropyHandlers() {
  // MARK: - Project Management

  /**
   * Ouvre un projet Tropy (.tpy) en lecture seule
   */
  ipcMain.handle('tropy:open-project', async (_event, tpyPath: string) => {
    console.log('📞 IPC Call: tropy:open-project', { tpyPath });
    try {
      const result = await tropyService.openProject(tpyPath);
      console.log('📤 IPC Response: tropy:open-project', result);
      return result;
    } catch (error: any) {
      console.error('❌ tropy:open-project error:', error);
      return errorResponse(error);
    }
  });

  /**
   * Retourne les informations du projet Tropy actuel
   */
  ipcMain.handle('tropy:get-project-info', async () => {
    console.log('📞 IPC Call: tropy:get-project-info');
    try {
      const info = tropyService.getProjectInfo();
      return { success: true, info };
    } catch (error: any) {
      console.error('❌ tropy:get-project-info error:', error);
      return errorResponse(error);
    }
  });

  // MARK: - Synchronization

  /**
   * Synchronise le projet Tropy
   */
  ipcMain.handle(
    'tropy:sync',
    async (
      _event,
      options: {
        performOCR: boolean;
        ocrLanguage: string;
        transcriptionDirectory?: string;
        forceReindex?: boolean;
      }
    ) => {
      console.log('📞 IPC Call: tropy:sync', options);
      try {
        const result = await tropyService.sync(options);
        console.log('📤 IPC Response: tropy:sync', {
          success: result.success,
          totalItems: result.totalItems,
          newItems: result.newItems,
          errors: result.errors.length,
        });
        return result;
      } catch (error: any) {
        console.error('❌ tropy:sync error:', error);
        return errorResponse(error);
      }
    }
  );

  /**
   * Vérifie si une synchronisation est nécessaire
   */
  ipcMain.handle('tropy:check-sync-needed', async () => {
    console.log('📞 IPC Call: tropy:check-sync-needed');
    try {
      const needed = tropyService.checkSyncNeeded();
      return { success: true, needed };
    } catch (error: any) {
      console.error('❌ tropy:check-sync-needed error:', error);
      return errorResponse(error);
    }
  });

  // MARK: - File Watching

  /**
   * Démarre la surveillance du fichier .tpy
   */
  ipcMain.handle('tropy:start-watching', async (_event, tpyPath?: string) => {
    console.log('📞 IPC Call: tropy:start-watching', { tpyPath });
    try {
      const result = tropyService.startWatching(tpyPath);
      console.log('📤 IPC Response: tropy:start-watching', result);
      return result;
    } catch (error: any) {
      console.error('❌ tropy:start-watching error:', error);
      return errorResponse(error);
    }
  });

  /**
   * Arrête la surveillance
   */
  ipcMain.handle('tropy:stop-watching', async () => {
    console.log('📞 IPC Call: tropy:stop-watching');
    try {
      tropyService.stopWatching();
      return { success: true };
    } catch (error: any) {
      console.error('❌ tropy:stop-watching error:', error);
      return errorResponse(error);
    }
  });

  /**
   * Vérifie si le watcher est actif
   */
  ipcMain.handle('tropy:is-watching', async () => {
    try {
      const isWatching = tropyService.isWatching();
      return { success: true, isWatching };
    } catch (error: any) {
      return errorResponse(error);
    }
  });

  // MARK: - OCR

  /**
   * Effectue l'OCR sur une image
   */
  ipcMain.handle('tropy:perform-ocr', async (_event, imagePath: string, language: string) => {
    console.log('📞 IPC Call: tropy:perform-ocr', { imagePath, language });
    try {
      const result = await tropyService.performOCR(imagePath, language);
      console.log('📤 IPC Response: tropy:perform-ocr', {
        success: result.success,
        textLength: result.text?.length,
        confidence: result.confidence,
      });
      return result;
    } catch (error: any) {
      console.error('❌ tropy:perform-ocr error:', error);
      return errorResponse(error);
    }
  });

  /**
   * Effectue l'OCR sur plusieurs images
   */
  ipcMain.handle(
    'tropy:perform-batch-ocr',
    async (_event, imagePaths: string[], language: string) => {
      console.log('📞 IPC Call: tropy:perform-batch-ocr', { imageCount: imagePaths.length, language });
      try {
        const result = await tropyService.performBatchOCR(imagePaths, language);
        console.log('📤 IPC Response: tropy:perform-batch-ocr', {
          success: result.success,
          textLength: result.text?.length,
        });
        return result;
      } catch (error: any) {
        console.error('❌ tropy:perform-batch-ocr error:', error);
        return errorResponse(error);
      }
    }
  );

  /**
   * Retourne les langues OCR supportées
   */
  ipcMain.handle('tropy:get-ocr-languages', async () => {
    try {
      const languages = tropyService.getSupportedOCRLanguages();
      return { success: true, languages };
    } catch (error: any) {
      return errorResponse(error);
    }
  });

  // MARK: - Transcription Import

  /**
   * Importe une transcription externe
   */
  ipcMain.handle('tropy:import-transcription', async (_event, filePath: string, type?: string) => {
    console.log('📞 IPC Call: tropy:import-transcription', { filePath, type });
    try {
      const result = await tropyService.importTranscription(filePath, type as any);
      console.log('📤 IPC Response: tropy:import-transcription', {
        success: result.success,
        format: result.format,
        textLength: result.text?.length,
      });
      return result;
    } catch (error: any) {
      console.error('❌ tropy:import-transcription error:', error);
      return errorResponse(error);
    }
  });

  // MARK: - Sources

  /**
   * Récupère toutes les sources primaires
   */
  ipcMain.handle('tropy:get-all-sources', async () => {
    console.log('📞 IPC Call: tropy:get-all-sources');
    try {
      const sources = tropyService.getAllSources();
      console.log('📤 IPC Response: tropy:get-all-sources', { count: sources.length });
      return { success: true, sources };
    } catch (error: any) {
      console.error('❌ tropy:get-all-sources error:', error);
      return errorResponse(error);
    }
  });

  /**
   * Récupère une source par son ID
   */
  ipcMain.handle('tropy:get-source', async (_event, sourceId: string) => {
    console.log('📞 IPC Call: tropy:get-source', { sourceId });
    try {
      const source = tropyService.getSource(sourceId);
      return { success: true, source };
    } catch (error: any) {
      console.error('❌ tropy:get-source error:', error);
      return errorResponse(error);
    }
  });

  /**
   * Met à jour la transcription d'une source
   */
  ipcMain.handle(
    'tropy:update-transcription',
    async (
      _event,
      sourceId: string,
      transcription: string,
      source: 'tesseract' | 'transkribus' | 'manual'
    ) => {
      console.log('📞 IPC Call: tropy:update-transcription', { sourceId, source });
      try {
        const result = await tropyService.updateSourceTranscription(sourceId, transcription, source);
        return result;
      } catch (error: any) {
        console.error('❌ tropy:update-transcription error:', error);
        return errorResponse(error);
      }
    }
  );

  // MARK: - Statistics

  /**
   * Retourne les statistiques des sources primaires
   */
  ipcMain.handle('tropy:get-statistics', async () => {
    console.log('📞 IPC Call: tropy:get-statistics');
    try {
      const stats = tropyService.getStatistics();
      const databasePath = tropyService.getDatabasePath();
      return { success: true, statistics: stats, databasePath };
    } catch (error: any) {
      console.error('❌ tropy:get-statistics error:', error);
      return errorResponse(error);
    }
  });

  /**
   * Purge la base de données des sources primaires
   */
  ipcMain.handle('tropy:purge', async () => {
    console.log('📞 IPC Call: tropy:purge');
    try {
      const result = await tropyService.purge();
      console.log('📤 IPC Response: tropy:purge', result);
      return result;
    } catch (error: any) {
      console.error('❌ tropy:purge error:', error);
      return errorResponse(error);
    }
  });

  /**
   * Retourne tous les tags des sources primaires
   */
  ipcMain.handle('tropy:get-all-tags', async () => {
    try {
      const tags = tropyService.getAllTags();
      return { success: true, tags };
    } catch (error: any) {
      return errorResponse(error);
    }
  });

  console.log('✅ Tropy handlers registered');
}
