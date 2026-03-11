/**
 * Configuration and Ollama IPC handlers
 */
import { ipcMain } from 'electron';
import { configManager } from '../../services/config-manager.js';
import { pdfService } from '../../services/pdf-service.js';
import { isSensitiveKey } from '../../services/secure-storage.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';
import {
  validate,
  StringIdSchema,
  ConfigSetSchema,
} from '../utils/validation.js';
import type { AppConfig, LLMConfig, ZoteroConfig } from '../../../../backend/types/config.js';

/** Mask an API key for display in the renderer (show first 4 and last 4 chars). */
function maskAPIKey(key: string | undefined): string {
  if (!key) return '';
  if (key.length <= 12) return '****';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

/**
 * Return a copy of AppConfig with all sensitive API key values redacted.
 * The renderer should display the masked values and only send full values
 * when the user explicitly edits and saves a key.
 */
function redactConfig(config: AppConfig): AppConfig {
  const redacted = { ...config };

  // Redact LLM API keys
  if (redacted.llm) {
    const claudeAPIKey = configManager.getAPIKey('llm.claudeAPIKey');
    const openaiAPIKey = configManager.getAPIKey('llm.openaiAPIKey');
    redacted.llm = {
      ...redacted.llm,
      ...(claudeAPIKey ? { claudeAPIKey: maskAPIKey(claudeAPIKey) } : {}),
      ...(openaiAPIKey ? { openaiAPIKey: maskAPIKey(openaiAPIKey) } : {}),
    };
  }

  // Redact Zotero API key
  if (redacted.zotero) {
    const zoteroApiKey = configManager.getAPIKey('zotero.apiKey');
    redacted.zotero = {
      ...redacted.zotero,
      ...(zoteroApiKey ? { apiKey: maskAPIKey(zoteroApiKey) } : {}),
    };
  }

  return redacted;
}

export function setupConfigHandlers() {
  // Configuration handlers
  ipcMain.handle('config:get', (_event, rawKey: unknown) => {
    const key = validate(StringIdSchema, rawKey);
    console.log('IPC Call: config:get', { key });

    // If requesting a sensitive key directly, route through secure storage
    if (isSensitiveKey(key)) {
      const value = configManager.getAPIKey(key);
      console.log('IPC Response: config:get (secure)', { key, hasValue: !!value });
      return value;
    }

    // For top-level section keys that contain API keys, inject them
    if (key === 'llm') {
      const result = configManager.getLLMConfig();
      console.log('IPC Response: config:get', { key });
      return result;
    }
    if (key === 'zotero') {
      const result = configManager.getZoteroConfig();
      console.log('IPC Response: config:get', { key });
      return result;
    }

    const result = configManager.get(key as keyof AppConfig);
    console.log('IPC Response: config:get', result);
    return result;
  });

  ipcMain.handle('config:set', async (_event, rawKey: unknown, rawValue: unknown) => {
    const { key, value } = validate(ConfigSetSchema, { key: rawKey, value: rawValue });
    console.log('IPC Call: config:set', { key });
    try {
      // If setting a sensitive key directly, route through secure storage
      if (isSensitiveKey(key)) {
        configManager.setAPIKey(key, value as string);
        console.log('IPC Response: config:set (secure) - success');
        return successResponse();
      }

      // For top-level section keys that contain API keys, use dedicated setters
      if (key === 'llm') {
        configManager.setLLMConfig(value as Partial<LLMConfig>);
      } else if (key === 'zotero') {
        configManager.setZoteroConfig(value as ZoteroConfig);
      } else {
        configManager.set(key as keyof AppConfig, value);
      }

      // If LLM config changed and there's an active project, reinitialize services
      if (key === 'llm') {
        const currentProjectPath = pdfService.getCurrentProjectPath();
        if (currentProjectPath) {
          console.log('Reinitializing services with new LLM config...');
          await pdfService.init(currentProjectPath);
          console.log('Services reinitialized successfully');
        }
      }

      console.log('IPC Response: config:set - success');
      return successResponse();
    } catch (error: any) {
      console.error('config:set error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('config:get-all', () => {
    console.log('IPC Call: config:get-all');
    const config = configManager.getAll();
    const result = redactConfig(config);
    console.log('IPC Response: config:get-all (API keys redacted)');
    return result;
  });

  // Ollama handlers
  ipcMain.handle('ollama:list-models', async () => {
    console.log('IPC Call: ollama:list-models');
    try {
      const ollamaClient = pdfService.getOllamaClient();
      if (!ollamaClient) {
        console.log('Ollama client not initialized yet (no project loaded)');
        return successResponse({ models: [] });
      }

      const models = await ollamaClient.listAvailableModels();
      console.log('IPC Response: ollama:list-models', { count: models.length });
      return successResponse({ models });
    } catch (error: any) {
      console.error('ollama:list-models error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('ollama:check-availability', async () => {
    console.log('IPC Call: ollama:check-availability');
    try {
      const ollamaClient = pdfService.getOllamaClient();
      if (!ollamaClient) {
        return successResponse({ available: false });
      }

      const available = await ollamaClient.isAvailable();
      console.log('IPC Response: ollama:check-availability', { available });
      return successResponse({ available });
    } catch (error: any) {
      console.error('ollama:check-availability error:', error);
      return { ...errorResponse(error), available: false };
    }
  });

  console.log('Config handlers registered');
}
