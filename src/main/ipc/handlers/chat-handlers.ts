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

export function setupChatHandlers() {
  ipcMain.handle('chat:send', async (event, message: string, options?: any) => {
    console.log('📞 IPC Call: chat:send', { message: message.substring(0, 50) + '...', options });
    try {
      // Validate input
      const validatedData = validate(ChatSendSchema, { message, options });

      // Initialize PDF service for RAG if context is requested
      if (validatedData.options?.context) {
        const projectPath = projectManager.getCurrentProjectPath();
        console.log('🔍 [RAG DEBUG] Current project path:', projectPath);

        if (projectPath) {
          console.log('🔍 [RAG DEBUG] Initializing PDF service for:', projectPath);
          console.log('✅ [RAG DEBUG] PDF service initialized successfully');

          // Test search to verify RAG is working
          const stats = await pdfService.getStatistics();
          console.log('🔍 [RAG DEBUG] Vector DB statistics:', stats);
        } else {
          console.warn('⚠️  [RAG DEBUG] No project path - RAG will not be used');
        }
      } else {
        console.log('🔍 [RAG DEBUG] Context not requested - RAG disabled');
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

      console.log('🔍 [RAG DEBUG] Enriched options:', enrichedOptions);

      const result = await chatService.sendMessage(validatedData.message, enrichedOptions);

      console.log('📤 IPC Response: chat:send', {
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
      console.error('❌ chat:send error:', error);
      return { ...errorResponse(error), response: '' };
    }
  });

  ipcMain.handle('chat:cancel', async () => {
    try {
      chatService.cancelCurrentStream();
      return successResponse();
    } catch (error: any) {
      console.error('❌ chat:cancel error:', error);
      return errorResponse(error);
    }
  });

  console.log('✅ Chat handlers registered');
}
