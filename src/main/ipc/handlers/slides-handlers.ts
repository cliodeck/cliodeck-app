/**
 * Slides generation and preview IPC handlers
 */
import { ipcMain, BrowserWindow } from 'electron';
import { slidesGenerationService } from '../../services/slides-generation-service.js';
import { generatePreviewHtml } from '../../services/revealjs-export.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';
import {
  validate,
  SlidesGenerateSchema,
  SlidesPreviewSchema,
} from '../utils/validation.js';
import { logger } from '../../utils/logger.js';
import { configManager } from '../../services/config-manager.js';
import { createRegistryFromClioDeckConfig } from '../../../../backend/core/llm/providers/cliodeck-config-adapter.js';

export function setupSlidesHandlers() {
  ipcMain.handle('slides:generate', async (event, rawOptions: unknown) => {
    let options;
    try {
      options = validate(SlidesGenerateSchema, rawOptions);
    } catch (e) {
      return errorResponse(e as Error);
    }
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
      const llm = registry.getLLM();
      slidesGenerationService.setLLMProvider(llm);

      const content = await slidesGenerationService.generateSlides(
        options.text,
        options.language ?? 'fr',
        window,
        options.citations
      );

      // Le modèle remonte au renderer : la proposition d'application (contrat
      // Phase 4) doit porter un `source.model` réel, pas 'unknown'.
      return successResponse({ content, model: llm.model });
    } catch (error: unknown) {
      logger.error('ipc', 'slides:generate', {
        error: error instanceof Error ? error.message : String(error),
      });
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
    } catch (error: unknown) {
      return errorResponse(error);
    }
  });

  // Phase 2 — Live preview: returns HTML string for srcdoc rendering
  ipcMain.handle('slides:get-preview-html', async (_event, rawOptions: unknown) => {
    let options;
    try {
      options = validate(SlidesPreviewSchema, rawOptions);
    } catch (e) {
      return errorResponse(e as Error);
    }
    try {
      const html = generatePreviewHtml(
        options.content || '',
        {
          projectPath: '',
          content: options.content || '',
          config: options.config,
        },
        typeof options.activeSlideIndex === 'number' ? options.activeSlideIndex : 0
      );
      return successResponse({ html });
    } catch (error: unknown) {
      return errorResponse(error);
    }
  });

  console.log('✅ Slides handlers registered');
}
