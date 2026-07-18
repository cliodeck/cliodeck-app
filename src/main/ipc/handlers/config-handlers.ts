/**
 * Configuration and Ollama IPC handlers
 */
import { ipcMain } from 'electron';
import { configManager } from '../../services/config-manager.js';
import { pdfService } from '../../services/pdf-service.js';
import { isSensitiveKey, maskAPIKey, SENSITIVE_KEYS } from '../../services/secure-storage.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';
import {
  validate,
  StringIdSchema,
  ConfigSetSchema,
} from '../utils/validation.js';
import type { AppConfig, LLMConfig, ZoteroConfig } from '../../../../backend/types/config.js';

/**
 * Return a copy of AppConfig with all sensitive API key values redacted.
 * Iterates SENSITIVE_KEYS so every registered secret (incl. Mistral, Gemini,
 * Europeana) is masked — the renderer never receives a key in clear.
 */
function redactConfig(config: AppConfig): AppConfig {
  const redacted: Record<string, unknown> = { ...config };

  for (const keyPath of SENSITIVE_KEYS) {
    const value = configManager.getAPIKey(keyPath);
    if (!value) continue;
    const segments = keyPath.split('.');
    const field = segments.pop() as string;
    // Clone each object along the path so the manager's copy is never mutated.
    let cursor = redacted;
    let sectionMissing = false;
    for (const seg of segments) {
      const next = cursor[seg];
      if (!next || typeof next !== 'object') {
        sectionMissing = true;
        break;
      }
      const clone = { ...(next as Record<string, unknown>) };
      cursor[seg] = clone;
      cursor = clone;
    }
    if (sectionMissing) continue;
    cursor[field] = maskAPIKey(value);
  }

  return redacted as unknown as AppConfig;
}

/**
 * Mask the sensitive fields of a single top-level config section ('llm',
 * 'zotero') that config-manager enriches with keys in clear.
 */
function maskSectionKeys<T extends object>(sectionKey: string, section: T): T {
  const masked = { ...(section as Record<string, unknown>) };
  for (const keyPath of SENSITIVE_KEYS) {
    if (!keyPath.startsWith(`${sectionKey}.`)) continue;
    const field = keyPath.slice(sectionKey.length + 1);
    if (field.includes('.')) continue; // nested paths are handled by redactConfig
    const value = masked[field];
    if (typeof value === 'string' && value) {
      masked[field] = maskAPIKey(value);
    }
  }
  return masked as T;
}

/**
 * Drop sensitive fields whose value is the mask of the currently stored key:
 * the renderer round-trips masked configs on save, and an unchanged mask must
 * not overwrite the real key. An empty string still means "delete the key".
 */
function stripUnchangedMaskedKeys(
  sectionKey: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const cleaned = { ...value };
  for (const keyPath of SENSITIVE_KEYS) {
    if (!keyPath.startsWith(`${sectionKey}.`)) continue;
    const field = keyPath.slice(sectionKey.length + 1);
    if (field.includes('.')) continue;
    const candidate = cleaned[field];
    if (typeof candidate !== 'string' || candidate === '') continue;
    const stored = configManager.getAPIKey(keyPath);
    if (stored && candidate === maskAPIKey(stored)) {
      delete cleaned[field];
    }
  }
  return cleaned;
}

export function setupConfigHandlers() {
  // Configuration handlers
  ipcMain.handle('config:get', (_event, rawKey: unknown) => {
    const key = validate(StringIdSchema, rawKey);
    console.log('IPC Call: config:get', { key });

    // Sensitive keys never cross the IPC boundary in clear: the renderer
    // only needs to know whether a key exists, the mask carries that signal.
    if (isSensitiveKey(key)) {
      const value = configManager.getAPIKey(key);
      console.log('IPC Response: config:get (secure, masked)', { key, hasValue: !!value });
      return maskAPIKey(value);
    }

    // For top-level section keys that contain API keys, inject them masked
    if (key === 'llm') {
      const result = maskSectionKeys('llm', configManager.getLLMConfig());
      console.log('IPC Response: config:get', { key });
      return result;
    }
    if (key === 'zotero') {
      const zotero = configManager.getZoteroConfig();
      const result = zotero ? maskSectionKeys('zotero', zotero) : zotero;
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
      // If setting a sensitive key directly, route through secure storage.
      // A value equal to the current mask means "unchanged" — skip the write
      // so a round-tripped mask never replaces the real key.
      if (isSensitiveKey(key)) {
        const stored = configManager.getAPIKey(key);
        if (!(stored && value === maskAPIKey(stored))) {
          configManager.setAPIKey(key, value as string);
        }
        console.log('IPC Response: config:set (secure) - success');
        return successResponse();
      }

      // For top-level section keys that contain API keys, use dedicated setters
      if (key === 'llm') {
        configManager.setLLMConfig(
          stripUnchangedMaskedKeys('llm', value as Record<string, unknown>) as Partial<LLMConfig>,
        );
      } else if (key === 'zotero') {
        configManager.setZoteroConfig(
          stripUnchangedMaskedKeys('zotero', value as Record<string, unknown>) as ZoteroConfig,
        );
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

  // Ollama handlers — independent of pdf-service / project lifecycle.
  // The list-models / availability probes are pure metadata about a
  // local Ollama daemon (no model loading, no embedding work), so
  // they hit `/api/tags` directly via fetch instead of going through
  // a typed provider. This decouples the LLM-config UI from the
  // workspace registry's lifecycle (it can poll Ollama before any
  // project is open).
  ipcMain.handle('ollama:list-models', async () => {
    console.log('IPC Call: ollama:list-models');
    try {
      const baseUrl = configManager.getLLMConfig().ollamaURL || 'http://127.0.0.1:11434';
      const url = `${baseUrl.replace(/\/$/, '')}/api/tags`;
      console.log('🔍 Fetching Ollama models from:', url);
      console.log('   Using Node.js http module (more reliable in Electron)');
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Ollama returned HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        models?: Array<{ name: string; size?: number }>;
      };
      const models = (data.models ?? []).map((m) => ({
        id: m.name,
        name: m.name,
        size: typeof m.size === 'number' ? formatOllamaSize(m.size) : undefined,
        description: 'Modèle Ollama',
        recommendedFor: [] as string[],
      }));
      console.log('✅ Successfully fetched', models.length, 'models');
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
      const baseUrl = configManager.getLLMConfig().ollamaURL || 'http://127.0.0.1:11434';
      const url = `${baseUrl.replace(/\/$/, '')}/api/tags`;
      const res = await fetch(url);
      const available = res.ok;
      console.log('IPC Response: ollama:check-availability', { available });
      return successResponse({ available });
    } catch (error: any) {
      console.error('ollama:check-availability error:', error);
      return { ...errorResponse(error), available: false };
    }
  });

  console.log('Config handlers registered');
}

/** Human-readable size used by the Ollama list-models response. */
function formatOllamaSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}
