/**
 * Configuration and Ollama IPC handlers
 */
import { ipcMain } from 'electron';
import { configManager } from '../../services/config-manager.js';
import { pdfService } from '../../services/pdf-service.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';

export function setupConfigHandlers() {
  // Configuration handlers
  ipcMain.handle('config:get', (_event, key: string) => {
    console.log('📞 IPC Call: config:get', { key });
    const result = configManager.get(key as any);
    console.log('📤 IPC Response: config:get', result);
    return result;
  });

  ipcMain.handle('config:set', async (_event, key: string, value: any) => {
    console.log('📞 IPC Call: config:set', { key, value });
    try {
      configManager.set(key as any, value);

      // If LLM config changed and there's an active project, reinitialize services
      if (key === 'llm') {
        const currentProjectPath = pdfService.getCurrentProjectPath();
        if (currentProjectPath) {
          console.log('🔄 Reinitializing services with new LLM config...');
          await pdfService.init(currentProjectPath);
          console.log('✅ Services reinitialized successfully');
        }
      }

      console.log('📤 IPC Response: config:set - success');
      return successResponse();
    } catch (error: any) {
      console.error('❌ config:set error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('config:get-all', () => {
    console.log('📞 IPC Call: config:get-all');
    const result = configManager.getAll();
    console.log('📤 IPC Response: config:get-all');
    return result;
  });

  // Ollama handlers
  ipcMain.handle('ollama:list-models', async () => {
    console.log('📞 IPC Call: ollama:list-models');
    try {
      const ollamaClient = pdfService.getOllamaClient();
      if (!ollamaClient) {
        console.log('⚠️  Ollama client not initialized yet (no project loaded)');
        return successResponse({ models: [] });
      }

      const models = await ollamaClient.listAvailableModels();
      console.log('📤 IPC Response: ollama:list-models', { count: models.length });
      return successResponse({ models });
    } catch (error: any) {
      console.error('❌ ollama:list-models error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('ollama:check-availability', async () => {
    console.log('📞 IPC Call: ollama:check-availability');
    try {
      const ollamaClient = pdfService.getOllamaClient();
      if (!ollamaClient) {
        return successResponse({ available: false });
      }

      const available = await ollamaClient.isAvailable();
      console.log('📤 IPC Response: ollama:check-availability', { available });
      return successResponse({ available });
    } catch (error: any) {
      console.error('❌ ollama:check-availability error:', error);
      return { ...errorResponse(error), available: false };
    }
  });

  console.log('✅ Config handlers registered');
}
