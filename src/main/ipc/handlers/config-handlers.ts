/**
 * Configuration and Ollama IPC handlers
 */
import { app, ipcMain } from 'electron';
import os from 'os';
import { configManager } from '../../services/config-manager.js';
import { pdfService } from '../../services/pdf-service.js';
import { isMaskedKey, isSensitiveKey, maskAPIKey, SENSITIVE_KEYS } from '../../services/secure-storage.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';
import { sandboxStatus } from '../../utils/sandbox-status.js';
import { localAiSupport } from '../../utils/local-ai-support.js';
import {
  validate,
  StringIdSchema,
  ConfigSetSchema,
  OllamaModelNameSchema,
} from '../utils/validation.js';
import type { AppConfig, LLMConfig, ZoteroConfig } from '../../../../backend/types/config.js';
import { fetchOllamaModelInfo } from '../../../../backend/core/llm/ollama-model-info.js';

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
 * Drop sensitive fields whose value has the shape of a mask: the renderer
 * round-trips masked configs on save, and a mask must never overwrite the real
 * key, nor become one when no key is stored. An empty string still means
 * "delete the key".
 */
/**
 * Exporté pour les tests : c'est la garantie « un masque renvoyé par le
 * renderer n'écrase jamais la vraie clé ». Une régression ici effacerait
 * silencieusement les clés d'API à chaque enregistrement des réglages.
 */
export function stripMaskedKeys(
  sectionKey: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const cleaned = { ...value };
  for (const keyPath of SENSITIVE_KEYS) {
    if (!keyPath.startsWith(`${sectionKey}.`)) continue;
    const segments = keyPath.slice(sectionKey.length + 1).split('.');
    const field = segments.pop() as string;
    // Clone each object along the path: the caller's copy is never mutated.
    let cursor: Record<string, unknown> | null = cleaned;
    for (const seg of segments) {
      const next: unknown = cursor[seg];
      if (!next || typeof next !== 'object') {
        cursor = null;
        break;
      }
      const clone = { ...(next as Record<string, unknown>) };
      cursor[seg] = clone;
      cursor = clone;
    }
    if (cursor && isMaskedKey(cursor[field])) {
      delete cursor[field];
    }
  }
  return cleaned;
}

const isNonFinite = (value: unknown): boolean => typeof value === 'number' && !Number.isFinite(value);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Le fichier est du JSON, où `NaN` devient `null` : aucun nombre non fini ne passe. Un champ retiré
 * disparaît du disque (`set` remplace la section), et ce qui le lit retombe sur le défaut
 * (`getRAGConfig`). Le reste ne bouge pas : `undefined` veut dire « efface » pour `setLLMConfig`, et
 * un `null` n'est pas à cette fonction d'en juger. Un objet que ce retrait vide part avec son contenu.
 */
export function stripNonFinite(value: unknown): unknown {
  if (isNonFinite(value)) return undefined;
  if (Array.isArray(value)) return value.filter((item) => !isNonFinite(item)).map(stripNonFinite);
  if (!isPlainObject(value)) return value;
  const kept: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (isNonFinite(field)) continue;
    const cleaned = stripNonFinite(field);
    const emptied =
      isPlainObject(field) && Object.keys(field).length > 0 && Object.keys(cleaned as object).length === 0;
    if (!emptied) kept[key] = cleaned;
  }
  return kept;
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
    const { key, value: received } = validate(ConfigSetSchema, { key: rawKey, value: rawValue });
    console.log('IPC Call: config:set', { key });
    try {
      if (isNonFinite(received)) throw new Error(`config:set: ${key} is not a finite number`);
      const value = stripNonFinite(received);

      // If setting a sensitive key directly, route through secure storage.
      // A value shaped like a mask means "unchanged" — skip the write so a
      // round-tripped mask never replaces the real key, or becomes one.
      if (isSensitiveKey(key)) {
        if (!isMaskedKey(value)) {
          configManager.setAPIKey(key, value as string);
        }
        console.log('IPC Response: config:set (secure) - success');
        return successResponse();
      }

      // For top-level section keys that contain API keys, use dedicated setters
      if (key === 'llm') {
        configManager.setLLMConfig(
          stripMaskedKeys('llm', value as Record<string, unknown>) as Partial<LLMConfig>,
        );
      } else if (key === 'zotero') {
        configManager.setZoteroConfig(
          stripMaskedKeys('zotero', value as Record<string, unknown>) as ZoteroConfig,
        );
      } else {
        // `mcp.europeana.apiKey` vit dans une section ordinaire : même porte.
        configManager.set(
          key as keyof AppConfig,
          (value && typeof value === 'object' && !Array.isArray(value)
            ? stripMaskedKeys(key, value as Record<string, unknown>)
            : value) as AppConfig[keyof AppConfig],
        );
      }

      // Le fichier est écrit : ce qui échoue à partir d'ici ne l'annule pas, et le panneau doit le
      // savoir. Il prendrait sinon pour non écrit ce que le disque contient déjà.
      try {
        if (key === 'llm') {
          // If LLM config changed and there's an active project, reinitialize services
          const currentProjectPath = pdfService.getCurrentProjectPath();
          if (currentProjectPath) {
            console.log('Reinitializing services with new LLM config...');
            await pdfService.init(currentProjectPath);
            console.log('Services reinitialized successfully');
          }
        } else if (key === 'rag') {
          pdfService.applyRagConfig();
        }
      } catch (error: unknown) {
        console.error('config:set: written, but not applied:', error);
        return { ...errorResponse(error), written: true };
      }

      console.log('IPC Response: config:set - success');
      return successResponse();
    } catch (error: unknown) {
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
        // Taille brute : le panneau du chat en déduit si modèle + contexte
        // tiennent en mémoire.
        sizeBytes: typeof m.size === 'number' ? m.size : undefined,
        description: 'Modèle Ollama',
        recommendedFor: [] as string[],
      }));
      console.log('✅ Successfully fetched', models.length, 'models');
      console.log('IPC Response: ollama:list-models', { count: models.length });
      return successResponse({ models });
    } catch (error: unknown) {
      console.error('ollama:list-models error:', error);
      return errorResponse(error);
    }
  });

  // Mémoire de la machine : avec la taille du modèle et le coût par jeton
  // du contexte, le panneau du chat prévient avant qu'une fenêtre trop
  // large ne déporte le modèle sur le processeur (2026-09-08 : 256K sur un
  // Mac de 24 Go avec un modèle de 22 Go, lecture du prompt à 10 jetons/s).
  ipcMain.handle('system:get-memory', () =>
    successResponse({ totalBytes: os.totalmem(), freeBytes: os.freemem() })
  );

  // Bac à sable de Chromium coupé (AppImage sur un système qui ne le permet
  // pas, #151) : le renderer en avertit l'utilisateur au démarrage.
  ipcMain.handle('system:get-sandbox-status', () =>
    successResponse(
      sandboxStatus({
        platform: process.platform,
        noSandboxSwitch: app.commandLine.hasSwitch('no-sandbox'),
        appImagePath: process.env.APPIMAGE,
      })
    )
  );

  // macOS 12 ou 13 : Ollama ne s'y installe pas ; restent les modèles embarqués.
  // Le renderer le dit une fois, puis s'en souvient (`localAiNoticeDismissed`).
  ipcMain.handle('system:get-local-ai-support', () =>
    successResponse({
      ...localAiSupport({ platform: process.platform, systemVersion: process.getSystemVersion() }),
      noticeDismissed: configManager.get('localAiNoticeDismissed') === true,
    })
  );

  // Métadonnées d'un modèle (`/api/show`) : longueur de contexte déclarée,
  // `num_ctx` du Modelfile, capacités. C'est ce qui remplace la table de
  // fenêtres codée en dur du panneau de chat — fausse pour tout modèle
  // absent de la table.
  ipcMain.handle('ollama:show-model', async (_event, rawModel: unknown) => {
    try {
      const model = validate(OllamaModelNameSchema, rawModel);
      const baseUrl = configManager.getLLMConfig().ollamaURL || 'http://127.0.0.1:11434';
      const info = await fetchOllamaModelInfo(baseUrl, model);
      return successResponse({ info });
    } catch (error: unknown) {
      console.error('ollama:show-model error:', error);
      return errorResponse(error);
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
