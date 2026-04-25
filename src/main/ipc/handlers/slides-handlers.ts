/**
 * Slides generation and preview IPC handlers
 */
import { ipcMain, BrowserWindow } from 'electron';
import { slidesGenerationService } from '../../services/slides-generation-service.js';
import { generatePreviewHtml } from '../../services/revealjs-export.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';
import { logger } from '../../utils/logger.js';
import { configManager } from '../../services/config-manager.js';
import { createRegistryFromClioDeckConfig } from '../../../../backend/core/llm/providers/cliodeck-config-adapter.js';

export function setupSlidesHandlers() {
  ipcMain.handle('slides:generate', async (event, options: { text: string; language: string; citations?: any[] }) => {
    logger.info('ipc', 'slides:generate', { textLength: options.text?.length, language: options.language });

    let registry: ReturnType<typeof createRegistryFromClioDeckConfig> | null = null;
    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) {
        return errorResponse(new Error('No window found'));
      }

      // Build a typed-provider registry for this generation. The service
      // streams through `llm.chat()` instead of the legacy
      // `LLMProviderManager.generateWithoutSources` path.
      registry = createRegistryFromClioDeckConfig(configManager.getLLMConfig());
      slidesGenerationService.setLLMProvider(registry.getLLM());

      const content = await slidesGenerationService.generateSlides(
        options.text,
        options.language ?? 'fr',
        window,
        options.citations
      );

      return successResponse({ content });
    } catch (error: any) {
      logger.error('ipc', 'slides:generate', { error: error.message });
      return errorResponse(error);
    } finally {
      slidesGenerationService.setLLMProvider(null);
      if (registry) {
        await registry.dispose().catch(() => undefined);
      }
    }
  });

  ipcMain.handle('slides:cancel', async () => {
    logger.info('ipc', 'slides:cancel');
    try {
      slidesGenerationService.cancelGeneration();
      return successResponse();
    } catch (error: any) {
      return errorResponse(error);
    }
  });

  // Phase 2 — Live preview: returns HTML string for srcdoc rendering
  ipcMain.handle('slides:get-preview-html', async (_event, options: { content: string; config?: any }) => {
    try {
      const html = generatePreviewHtml(options.content || '', {
        projectPath: '',
        content: options.content || '',
        config: options.config,
      });
      return successResponse({ html });
    } catch (error: any) {
      return errorResponse(error);
    }
  });

  console.log('✅ Slides handlers registered');
}
