/**
 * Similarity Finder IPC handlers
 *
 * Handles communication between renderer and main process
 * for document similarity analysis.
 */
import { ipcMain, BrowserWindow } from 'electron';
import { z } from 'zod';
import { projectManager } from '../../services/project-manager.js';
import { similarityService, type SimilarityOptions } from '../../services/similarity-service.js';
import { successResponse, errorResponse, requireProject } from '../utils/error-handler.js';
import { validate } from '../utils/validation.js';

// MARK: - Validation Schemas

export const SimilarityAnalyzeSchema = z.object({
  text: z.string().min(1, 'Text cannot be empty'),
  options: z
    .object({
      granularity: z.enum(['section', 'paragraph', 'sentence']).optional(),
      maxResults: z.number().min(1).max(20).optional(),
      similarityThreshold: z.number().min(0).max(1).optional(),
      collectionFilter: z.array(z.string()).nullable().optional(),
      sourceType: z.enum(['secondary', 'primary', 'both']).optional(),
      useReranking: z.boolean().optional(),
      useContextualEmbedding: z.boolean().optional(),
    })
    .optional(),
});

// MARK: - Handlers

export function setupSimilarityHandlers() {
  /**
   * Analyze a document and find similar PDFs
   */
  ipcMain.handle('similarity:analyze', async (event, text: string, options?: Partial<SimilarityOptions>) => {
    console.log('📞 IPC Call: similarity:analyze', {
      textLength: text?.length,
      options,
    });

    try {
      const projectPath = projectManager.getCurrentProjectPath();
      requireProject(projectPath);

      // Validate input
      const validatedData = validate(SimilarityAnalyzeSchema, { text, options });

      const window = BrowserWindow.fromWebContents(event.sender);

      // Run analysis with progress reporting
      const results = await similarityService.analyzeDocument(
        validatedData.text,
        validatedData.options,
        (progress) => {
          if (window) {
            window.webContents.send('similarity:progress', progress);
          }
        }
      );

      console.log('📤 IPC Response: similarity:analyze', {
        segmentsAnalyzed: results.length,
        totalRecommendations: results.reduce((sum, r) => sum + r.recommendations.length, 0),
      });

      return successResponse({ results });
    } catch (error: any) {
      console.error('❌ similarity:analyze error:', error);
      return errorResponse(error);
    }
  });

  /**
   * Cancel ongoing analysis
   */
  ipcMain.handle('similarity:cancel', async () => {
    console.log('📞 IPC Call: similarity:cancel');

    try {
      similarityService.cancelAnalysis();
      console.log('📤 IPC Response: similarity:cancel - success');
      return successResponse();
    } catch (error: any) {
      console.error('❌ similarity:cancel error:', error);
      return errorResponse(error);
    }
  });

  /**
   * Get results for a specific segment
   */
  ipcMain.handle('similarity:get-segment-results', async (_event, segmentId: string) => {
    console.log('📞 IPC Call: similarity:get-segment-results', { segmentId });

    try {
      const projectPath = projectManager.getCurrentProjectPath();
      requireProject(projectPath);

      const result = await similarityService.getResultsForSegment(segmentId);

      console.log('📤 IPC Response: similarity:get-segment-results', {
        found: !!result,
        recommendations: result?.recommendations.length || 0,
      });

      return successResponse({ result });
    } catch (error: any) {
      console.error('❌ similarity:get-segment-results error:', error);
      return errorResponse(error);
    }
  });

  /**
   * Get all cached results
   */
  ipcMain.handle('similarity:get-all-results', async () => {
    console.log('📞 IPC Call: similarity:get-all-results');

    try {
      const projectPath = projectManager.getCurrentProjectPath();
      requireProject(projectPath);

      const results = await similarityService.getAllCachedResults();

      console.log('📤 IPC Response: similarity:get-all-results', {
        segments: results.length,
      });

      return successResponse({ results });
    } catch (error: any) {
      console.error('❌ similarity:get-all-results error:', error);
      return errorResponse(error);
    }
  });

  /**
   * Clear similarity cache
   */
  ipcMain.handle('similarity:clear-cache', async () => {
    console.log('📞 IPC Call: similarity:clear-cache');

    try {
      const projectPath = projectManager.getCurrentProjectPath();
      requireProject(projectPath);

      await similarityService.clearCache(projectPath);

      console.log('📤 IPC Response: similarity:clear-cache - success');
      return successResponse();
    } catch (error: any) {
      console.error('❌ similarity:clear-cache error:', error);
      return errorResponse(error);
    }
  });

  console.log('✅ Similarity handlers registered');
}
