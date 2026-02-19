/**
 * Chat and RAG IPC handlers
 */
import { ipcMain, BrowserWindow } from 'electron';
import { projectManager } from '../../services/project-manager.js';
import { pdfService } from '../../services/pdf-service.js';
import { chatService } from '../../services/chat-service.js';
import { configManager } from '../../services/config-manager.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';
import { validate, ChatSendSchema } from '../utils/validation.js';
import { logger } from '../../utils/logger.js';

export function setupChatHandlers() {
  ipcMain.handle('chat:send', async (event, message: string, options?: any) => {
    logger.info('ipc', 'chat:send', { messageLength: message.length, hasOptions: !!options });
    try {
      // Validate input
      const validatedData = validate(ChatSendSchema, { message, options });

      // Initialize PDF service for RAG if context is requested
      if (validatedData.options?.context) {
        const projectPath = projectManager.getCurrentProjectPath();
        logger.debug('rag', 'chat:send:context-init', { projectPath });

        if (projectPath) {
          // Test search to verify RAG is working
          const stats = await pdfService.getStatistics();
          logger.debug('rag', 'chat:send:vector-db-stats', { ...stats });
        } else {
          logger.warn('rag', 'chat:send:no-project', { reason: 'No project path - RAG will not be used' });
        }
      } else {
        logger.debug('rag', 'chat:send:context-disabled', {});
      }

      const window = BrowserWindow.fromWebContents(event.sender);

      // Load RAG config and merge with passed options
      const ragConfig = configManager.getRAGConfig();
      const llmConfig = configManager.getLLMConfig();
      const enrichedOptions = {
        context: validatedData.options?.context,
        topK: validatedData.options?.topK || ragConfig.topK,
        includeSummaries: ragConfig.includeSummaries || false,
        useGraphContext: validatedData.options?.useGraphContext ?? ragConfig.useGraphContext ?? false,
        additionalGraphDocs: ragConfig.additionalGraphDocs || 3,
        window,
        // Source type selection (primary = Tropy archives, secondary = PDFs, both = all)
        sourceType: validatedData.options?.sourceType || 'both',
        // Collection filtering (from RAG settings panel)
        collectionKeys: validatedData.options?.collectionKeys,
        // Issue #16: Document filtering (from RAG settings panel)
        documentIds: validatedData.options?.documentIds,
        // Provider selection (from RAG settings panel)
        provider: validatedData.options?.provider || llmConfig.generationProvider || 'auto',
        // Per-query parameters (from RAG settings panel)
        model: validatedData.options?.model,
        timeout: validatedData.options?.timeout,
        numCtx: validatedData.options?.numCtx,  // Context window size for Ollama
        temperature: validatedData.options?.temperature,
        top_p: validatedData.options?.top_p,
        top_k: validatedData.options?.top_k,
        repeat_penalty: validatedData.options?.repeat_penalty,
        // System prompt configuration (Phase 2.3)
        systemPromptLanguage: validatedData.options?.systemPromptLanguage || ragConfig.systemPromptLanguage || 'fr',
        useCustomSystemPrompt: validatedData.options?.useCustomSystemPrompt || ragConfig.useCustomSystemPrompt || false,
        customSystemPrompt: validatedData.options?.customSystemPrompt || ragConfig.customSystemPrompt,
        // Context compression
        enableContextCompression: validatedData.options?.enableContextCompression ?? (ragConfig.enableContextCompression !== false),
        // Mode tracking
        modeId: validatedData.options?.modeId,
        noSystemPrompt: validatedData.options?.noSystemPrompt,
      };

      logger.debug('rag', 'chat:send:enriched-options', {
        context: enrichedOptions.context,
        sourceType: enrichedOptions.sourceType,
        provider: enrichedOptions.provider,
        modeId: enrichedOptions.modeId,
      });

      const result = await chatService.sendMessage(validatedData.message, enrichedOptions);

      logger.info('ipc', 'chat:send:response', {
        responseLength: result.response.length,
        ragUsed: result.ragUsed,
        sourcesCount: result.sourcesCount,
        hasExplanation: !!result.explanation,
      });
      return successResponse({
        response: result.response,
        ragUsed: result.ragUsed,
        sourcesCount: result.sourcesCount,
        explanation: result.explanation,
      });
    } catch (error: any) {
      logger.error('ipc', 'chat:send', { error: error instanceof Error ? error.message : String(error) });
      return { ...errorResponse(error), response: '' };
    }
  });

  ipcMain.handle('chat:cancel', async () => {
    logger.info('ipc', 'chat:cancel');
    try {
      chatService.cancelCurrentStream();
      logger.info('ipc', 'chat:cancel:response', { cancelled: true });
      return successResponse();
    } catch (error: any) {
      logger.error('ipc', 'chat:cancel', { error: error instanceof Error ? error.message : String(error) });
      return errorResponse(error);
    }
  });

  console.log('✅ Chat handlers registered');
}
