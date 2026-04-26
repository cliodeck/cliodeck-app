/**
 * IPC handlers for the fusion feature surface (phase 3.0).
 *
 * Bridges the new backend modules (workspace v2, hints, recipes, Obsidian
 * vault) to the renderer. Kept under a single file for now — the surface is
 * small and cohesive; split per-domain when any one outgrows ~100 lines.
 *
 * All handlers fail soft when no project is open: they return
 * `{ success: false, error: 'no_project' }` rather than throwing, so the
 * renderer can show a "Open a project first" affordance instead of an
 * uncaught exception.
 */

import { ipcMain, dialog, app } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import {
  validateMcpAddRequest,
  confirmMcpAdd,
  appendMcpAudit,
} from './mcp-add-guard.js';
import { projectManager } from '../../services/project-manager.js';
import { configManager } from '../../services/config-manager.js';
import { fusionChatService } from '../../services/fusion-chat-service.js';
import { retrievalService } from '../../services/retrieval-service.js';
import { secureStorage } from '../../services/secure-storage.js';
import {
  loadWorkspaceHints,
  writeWorkspaceHints,
} from '../../../../backend/core/hints/loader.js';
import {
  ensureV2Directories,
  v2Paths,
} from '../../../../backend/core/workspace/layout.js';
import {
  defaultWorkspaceConfig,
  readWorkspaceConfig,
  writeWorkspaceConfig,
  type WorkspaceConfig,
} from '../../../../backend/core/workspace/config.js';
import { parseRecipe, type Recipe } from '../../../../backend/recipes/schema.js';
import { RecipeRunner } from '../../../../backend/recipes/runner.js';
import { recipeStepHandlers } from '../../services/recipe-step-handlers.js';
import { mcpClientsService } from '../../services/mcp-clients-service.js';
import { BrowserWindow } from 'electron';
import { ObsidianVaultReader } from '../../../../backend/integrations/obsidian/ObsidianVaultReader.js';
import { ObsidianVaultStore } from '../../../../backend/integrations/obsidian/ObsidianVaultStore.js';
import {
  ObsidianVaultIndexer,
  obsidianStorePath,
} from '../../../../backend/integrations/obsidian/ObsidianVaultIndexer.js';
import { createRegistryFromClioDeckConfig } from '../../../../backend/core/llm/providers/cliodeck-config-adapter.js';
import type { ChatMessage } from '../../../../backend/core/llm/providers/base.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';

interface VaultConfigBlock {
  path?: string;
}

async function readOrInitWorkspaceConfig(root: string): Promise<WorkspaceConfig> {
  await ensureV2Directories(root);
  try {
    return await readWorkspaceConfig(root);
  } catch {
    const fresh = defaultWorkspaceConfig(path.basename(root));
    await writeWorkspaceConfig(root, fresh);
    return fresh;
  }
}

const BUILTIN_RECIPES_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'recipes-builtin')
  : path.join(process.cwd(), 'backend', 'recipes', 'builtin');

function noProject() {
  return { ...errorResponse('no_project'), error: 'no_project' as const };
}

export function setupFusionHandlers(): void {
  // MARK: - hints

  ipcMain.handle('fusion:hints:read', async () => {
    const root = projectManager.getCurrentProjectPath();
    if (!root) return noProject();
    try {
      const h = await loadWorkspaceHints(root);
      return successResponse({ hints: h });
    } catch (e) {
      return errorResponse(e as Error);
    }
  });

  ipcMain.handle('fusion:hints:write', async (_e, rawMarkdown: unknown) => {
    const root = projectManager.getCurrentProjectPath();
    if (!root) return noProject();
    if (typeof rawMarkdown !== 'string') {
      return errorResponse('hints content must be a string');
    }
    try {
      // Ensure v2 dir exists before writing.
      await fs.mkdir(v2Paths(root).root, { recursive: true });
      await writeWorkspaceHints(root, rawMarkdown);
      const h = await loadWorkspaceHints(root);
      return successResponse({ hints: h });
    } catch (e) {
      return errorResponse(e as Error);
    }
  });

  // MARK: - recipes

  ipcMain.handle('fusion:recipes:list', async () => {
    try {
      const root = projectManager.getCurrentProjectPath();
      const builtin = await listRecipes(BUILTIN_RECIPES_DIR);
      let user: RecipeSummary[] = [];
      if (root) {
        const userDir = v2Paths(root).recipesDir;
        try {
          await fs.access(userDir);
          user = await listRecipes(userDir);
        } catch {
          user = [];
        }
      }
      return successResponse({ builtin, user });
    } catch (e) {
      return errorResponse(e as Error);
    }
  });

  ipcMain.handle(
    'fusion:recipes:read',
    async (_e, rawScope: unknown, rawFileName: unknown) => {
      if (rawScope !== 'builtin' && rawScope !== 'user') {
        return errorResponse('scope must be "builtin" or "user"');
      }
      if (typeof rawFileName !== 'string' || !/^[\w.-]+\.ya?ml$/i.test(rawFileName)) {
        return errorResponse('invalid recipe fileName');
      }
      const baseDir =
        rawScope === 'builtin'
          ? BUILTIN_RECIPES_DIR
          : (() => {
              const root = projectManager.getCurrentProjectPath();
              return root ? v2Paths(root).recipesDir : null;
            })();
      if (!baseDir) return noProject();
      try {
        const raw = await fs.readFile(path.join(baseDir, rawFileName), 'utf8');
        const recipe = parseRecipe(raw);
        return successResponse({ recipe });
      } catch (e) {
        return errorResponse(e as Error);
      }
    }
  );

  ipcMain.handle(
    'fusion:recipes:run',
    async (
      event,
      rawScope: unknown,
      rawFileName: unknown,
      rawInputs: unknown
    ) => {
      const root = projectManager.getCurrentProjectPath();
      if (!root) return noProject();
      if (rawScope !== 'builtin' && rawScope !== 'user') {
        return errorResponse('scope must be "builtin" or "user"');
      }
      if (typeof rawFileName !== 'string' || !/^[\w.-]+\.ya?ml$/i.test(rawFileName)) {
        return errorResponse('invalid recipe fileName');
      }
      const inputs = (rawInputs ?? {}) as Record<string, unknown>;
      const baseDir =
        rawScope === 'builtin' ? BUILTIN_RECIPES_DIR : v2Paths(root).recipesDir;
      let recipe: Recipe;
      try {
        const raw = await fs.readFile(path.join(baseDir, rawFileName), 'utf8');
        recipe = parseRecipe(raw);
      } catch (e) {
        return errorResponse(e as Error);
      }

      const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const cfg = configManager.getLLMConfig();
      let registry;
      try {
        registry = createRegistryFromClioDeckConfig(cfg);
      } catch (e) {
        return errorResponse(e as Error);
      }

      const runner = new RecipeRunner({
        registry,
        workspaceRoot: root,
        stepHandlers: recipeStepHandlers,
        onEvent: (e) => {
          try {
            if (!event.sender.isDestroyed()) {
              event.sender.send('fusion:recipes:event', { runId, event: e });
            }
          } catch {
            // Renderer gone — keep running regardless.
          }
        },
      });

      try {
        const result = await runner.run(recipe, inputs);
        return successResponse({
          runId,
          ok: result.ok,
          outputs: result.outputs,
          logPath: result.logPath,
          failedStep: result.failedStep,
        });
      } catch (e) {
        return errorResponse(e as Error);
      } finally {
        await registry.dispose().catch(() => undefined);
      }
    }
  );

  // MARK: - chat (streaming)

  ipcMain.handle(
    'fusion:chat:start',
    async (event, rawMessages: unknown, rawOpts: unknown) => {
      if (!Array.isArray(rawMessages)) {
        return errorResponse('messages must be an array');
      }
      const messages = rawMessages as ChatMessage[];
      const rawOptsObj = (rawOpts ?? {}) as {
        model?: string;
        temperature?: number;
        maxTokens?: number;
        retrievalOptions?: {
          documentIds?: string[];
          collectionKeys?: string[];
          sourceType?: 'primary' | 'secondary' | 'both' | 'vault';
          includeVault?: boolean;
          topK?: number;
        };
        systemPrompt?: { modeId?: string; customText?: string };
        enabledTools?: string[];
      };
      const opts = {
        model: rawOptsObj.model,
        temperature: rawOptsObj.temperature,
        maxTokens: rawOptsObj.maxTokens,
      };
      const sessionId = fusionChatService.start({
        webContents: event.sender,
        messages,
        opts,
        retrievalOptions: rawOptsObj.retrievalOptions,
        systemPrompt: rawOptsObj.systemPrompt,
        enabledTools: Array.isArray(rawOptsObj.enabledTools)
          ? rawOptsObj.enabledTools.filter((s): s is string => typeof s === 'string')
          : undefined,
      });
      return successResponse({ sessionId });
    }
  );

  ipcMain.handle(
    'fusion:chat:cancel',
    async (_e, rawSessionId: unknown) => {
      if (typeof rawSessionId !== 'string') {
        return errorResponse('sessionId must be a string');
      }
      const cancelled = fusionChatService.cancel(rawSessionId);
      return successResponse({ cancelled });
    }
  );

  // MARK: - MCP clients

  ipcMain.handle('fusion:mcp:list', async () => {
    return successResponse({ clients: mcpClientsService.list() });
  });

  ipcMain.handle('fusion:mcp:add', async (event, rawClient: unknown) => {
    if (!rawClient || typeof rawClient !== 'object') {
      return errorResponse('client config must be an object');
    }
    const c = rawClient as {
      name?: unknown;
      transport?: unknown;
      command?: unknown;
      args?: unknown;
      env?: unknown;
      url?: unknown;
    };
    if (typeof c.name !== 'string' || !c.name.trim()) {
      return errorResponse('name must be a non-empty string');
    }
    if (c.transport !== 'stdio' && c.transport !== 'sse') {
      return errorResponse('transport must be "stdio" or "sse"');
    }

    const normalized = {
      name: c.name,
      transport: c.transport,
      command: typeof c.command === 'string' ? c.command : undefined,
      args: Array.isArray(c.args)
        ? c.args.filter((a): a is string => typeof a === 'string')
        : undefined,
      env:
        c.env && typeof c.env === 'object'
          ? (c.env as Record<string, string>)
          : undefined,
      url: typeof c.url === 'string' ? c.url : undefined,
    } as const;

    // Audit log location (may be unavailable if no project is open; in that
    // case `addClient` will reject with "No project loaded" below anyway).
    const root = projectManager.getCurrentProjectPath();
    const auditPath = root ? v2Paths(root).mcpAccessLog : null;

    // 1. Whitelist validation (command + env shape).
    const check = validateMcpAddRequest(normalized);
    if (check.ok === false) {
      if (auditPath) {
        await appendMcpAudit(auditPath, {
          ts: new Date().toISOString(),
          kind: 'mcp_add',
          decision: 'rejected',
          name: normalized.name,
          transport: normalized.transport,
          command: normalized.command,
          reason: check.reason,
        });
      }
      return errorResponse(`mcp_add_rejected:${check.reason}`);
    }

    // 2. Native confirmation dialog (main-process owned; renderer cannot
    //    bypass). SSE passes through without a dialog — no spawn happens.
    const parent = BrowserWindow.fromWebContents(event.sender) ?? null;
    const confirmed = await confirmMcpAdd(normalized, { dialog, parentWindow: parent });
    if (!confirmed) {
      if (auditPath) {
        await appendMcpAudit(auditPath, {
          ts: new Date().toISOString(),
          kind: 'mcp_add',
          decision: 'rejected',
          name: normalized.name,
          transport: normalized.transport,
          command: normalized.command,
          reason: 'user_cancelled',
        });
      }
      return errorResponse('mcp_add_rejected:user_cancelled');
    }

    try {
      const instance = await mcpClientsService.addClient(normalized);
      if (auditPath) {
        await appendMcpAudit(auditPath, {
          ts: new Date().toISOString(),
          kind: 'mcp_add',
          decision: 'accepted',
          name: normalized.name,
          transport: normalized.transport,
          command: normalized.command,
        });
      }
      return successResponse({ instance });
    } catch (e) {
      return errorResponse(e as Error);
    }
  });

  ipcMain.handle('fusion:mcp:remove', async (_e, rawName: unknown) => {
    if (typeof rawName !== 'string') {
      return errorResponse('name must be a string');
    }
    try {
      await mcpClientsService.removeClient(rawName);
      return successResponse({});
    } catch (e) {
      return errorResponse(e as Error);
    }
  });

  ipcMain.handle('fusion:mcp:restart', async (_e, rawName: unknown) => {
    if (typeof rawName !== 'string') {
      return errorResponse('name must be a string');
    }
    try {
      const instance = await mcpClientsService.restart(rawName);
      return successResponse({ instance });
    } catch (e) {
      return errorResponse(e as Error);
    }
  });

  ipcMain.handle(
    'fusion:mcp:call-tool',
    async (
      _e,
      rawName: unknown,
      rawTool: unknown,
      rawArgs: unknown
    ) => {
      if (typeof rawName !== 'string' || typeof rawTool !== 'string') {
        return errorResponse('name and tool must be strings');
      }
      const args =
        rawArgs && typeof rawArgs === 'object'
          ? (rawArgs as Record<string, unknown>)
          : {};
      const res = await mcpClientsService.callTool(rawName, rawTool, args);
      return successResponse(res);
    }
  );

  // Broadcast manager events to every renderer so all open windows stay
  // in sync when a client changes state.
  mcpClientsService.subscribe((event) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        try {
          w.webContents.send('fusion:mcp:event', event);
        } catch {
          // ignore per-window send failure
        }
      }
    }
  });

  // MARK: - vault status (read-only — indexing/search land with chat IPC)

  ipcMain.handle('fusion:vault:status', async () => {
    const root = projectManager.getCurrentProjectPath();
    if (!root) return noProject();
    try {
      const dbPath = obsidianStorePath(root);
      let exists = false;
      try {
        await fs.access(dbPath);
        exists = true;
      } catch {
        exists = false;
      }
      let vaultPath: string | null = null;
      try {
        const cfg = await readWorkspaceConfig(root);
        vaultPath = (cfg.vault as VaultConfigBlock | undefined)?.path ?? null;
      } catch {
        // v2 config not initialised yet.
      }
      return successResponse({ indexed: exists, dbPath, vaultPath });
    } catch (e) {
      return errorResponse(e as Error);
    }
  });

  ipcMain.handle('fusion:vault:set-path', async (_e, rawPath: unknown) => {
    const root = projectManager.getCurrentProjectPath();
    if (!root) return noProject();
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
      return errorResponse('vault path must be a non-empty string');
    }
    const vaultPath = rawPath.trim();
    try {
      const stat = await fs.stat(vaultPath);
      if (!stat.isDirectory()) {
        return errorResponse('vault path is not a directory');
      }
    } catch {
      return errorResponse('vault path does not exist');
    }
    try {
      const cfg = await readOrInitWorkspaceConfig(root);
      cfg.vault = { ...((cfg.vault as VaultConfigBlock) ?? {}), path: vaultPath };
      await writeWorkspaceConfig(root, cfg);
      return successResponse({ vaultPath });
    } catch (e) {
      return errorResponse(e as Error);
    }
  });

  ipcMain.handle('fusion:vault:unlink', async () => {
    const root = projectManager.getCurrentProjectPath();
    if (!root) return noProject();
    try {
      const cfg = await readOrInitWorkspaceConfig(root);
      delete cfg.vault;
      await writeWorkspaceConfig(root, cfg);
      const dbPath = obsidianStorePath(root);
      try {
        await fs.unlink(dbPath);
      } catch {
        // db already gone — fine.
      }
      return successResponse({});
    } catch (e) {
      return errorResponse(e as Error);
    }
  });

  ipcMain.handle('fusion:vault:index', async (event, rawOpts: unknown) => {
    const root = projectManager.getCurrentProjectPath();
    if (!root) return noProject();
    const opts = (rawOpts ?? {}) as { force?: boolean };
    try {
      const cfg = await readOrInitWorkspaceConfig(root);
      const vaultPath = (cfg.vault as VaultConfigBlock | undefined)?.path;
      if (!vaultPath) {
        return errorResponse('no_vault_configured');
      }
      if (!fsSync.existsSync(vaultPath)) {
        return errorResponse('vault path no longer exists');
      }

      const llmCfg = configManager.getLLMConfig();
      const registry = createRegistryFromClioDeckConfig(llmCfg);
      const embedder = registry.getEmbedding();

      const reader = new ObsidianVaultReader(vaultPath);
      const store = new ObsidianVaultStore({
        dbPath: obsidianStorePath(root),
        dimension: embedder.dimension,
      });

      try {
        const report = await reader.scan().then(() =>
          new ObsidianVaultIndexer(reader, store, embedder).indexAll({
            force: !!opts.force,
            onProgress: (p) => {
              try {
                if (!event.sender.isDestroyed()) {
                  event.sender.send('fusion:vault:progress', p);
                }
              } catch {
                // Renderer gone — continue indexing anyway.
              }
            },
          })
        );
        return successResponse({
          indexed: report.indexed.length,
          skipped: report.skipped.length,
          failed: report.failed.length,
          vaultName: reader.getVaultName(),
        });
      } finally {
        store.close();
        await registry.dispose().catch(() => undefined);
      }
    } catch (e) {
      return errorResponse(e as Error);
    }
  });

  // MARK: - security (SourceInspector mode)

  ipcMain.handle('fusion:security:get-mode', async () => {
    return successResponse({ mode: retrievalService.getInspectorMode() });
  });

  // MARK: - archives connectors (Europeana key)

  ipcMain.handle('fusion:archives:get-status', async () => {
    return successResponse({
      connectors: {
        europeana: {
          configured: secureStorage.hasKey('mcp.europeana.apiKey'),
        },
      },
    });
  });

  ipcMain.handle(
    'fusion:archives:set-key',
    async (_e, rawConnector: unknown, rawKey: unknown) => {
      if (rawConnector !== 'europeana') {
        return errorResponse(`unknown connector: ${String(rawConnector)}`);
      }
      if (typeof rawKey !== 'string' || !rawKey.trim()) {
        return errorResponse('key must be a non-empty string');
      }
      try {
        secureStorage.setKey('mcp.europeana.apiKey', rawKey.trim());
        // Mirror to env so the in-process MCP server (when spawned by us)
        // sees the key without a restart. Third-party MCP clients still
        // need to set the env var in their own config.
        process.env.EUROPEANA_API_KEY = rawKey.trim();
        return successResponse({ connector: 'europeana' });
      } catch (e) {
        return errorResponse(e as Error);
      }
    }
  );

  ipcMain.handle(
    'fusion:archives:delete-key',
    async (_e, rawConnector: unknown) => {
      if (rawConnector !== 'europeana') {
        return errorResponse(`unknown connector: ${String(rawConnector)}`);
      }
      try {
        secureStorage.deleteKey('mcp.europeana.apiKey');
        delete process.env.EUROPEANA_API_KEY;
        return successResponse({ connector: 'europeana' });
      } catch (e) {
        return errorResponse(e as Error);
      }
    }
  );

  ipcMain.handle('fusion:security:set-mode', async (_e, rawMode: unknown) => {
    if (rawMode !== 'warn' && rawMode !== 'audit' && rawMode !== 'block') {
      return errorResponse('mode must be "warn" | "audit" | "block"');
    }
    const root = projectManager.getCurrentProjectPath();
    if (!root) return noProject();
    try {
      const cfg = await readOrInitWorkspaceConfig(root);
      cfg.security = { ...(cfg.security ?? {}), sourceInspectorMode: rawMode };
      await writeWorkspaceConfig(root, cfg);
      retrievalService.setInspectorMode(rawMode);
      return successResponse({ mode: rawMode });
    } catch (e) {
      return errorResponse(e as Error);
    }
  });

  // Stats over `.cliodeck/v2/security-events.jsonl` (fusion 2.8).
  // Read + aggregate is fast (typical workspaces have hundreds of
  // events at most), so we hand the renderer a fully shaped payload
  // each call rather than streaming. Rotation lands later in 3.14.
  ipcMain.handle('fusion:security:get-events', async (_e, rawOpts: unknown) => {
    const root = projectManager.getCurrentProjectPath();
    if (!root) return noProject();
    const opts = (rawOpts ?? {}) as { recentLimit?: unknown };
    const recentLimit =
      typeof opts.recentLimit === 'number' && opts.recentLimit >= 0
        ? Math.floor(opts.recentLimit)
        : undefined;
    try {
      const { readSecurityEventsLog, aggregateSecurityEvents } = await import(
        '../../../../backend/security/events-reader.js'
      );
      const events = await readSecurityEventsLog(
        v2Paths(root).securityEventsLog
      );
      const stats = aggregateSecurityEvents(events, { recentLimit });
      return successResponse({ stats });
    } catch (e) {
      return errorResponse(e as Error);
    }
  });
}

interface RecipeSummary {
  fileName: string;
  name: string;
  version: string;
  description: string;
  steps: number;
}

async function listRecipes(dir: string): Promise<RecipeSummary[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: RecipeSummary[] = [];
  for (const fileName of entries) {
    if (!/\.ya?ml$/i.test(fileName)) continue;
    try {
      const raw = await fs.readFile(path.join(dir, fileName), 'utf8');
      const r = parseRecipe(raw);
      out.push({
        fileName,
        name: r.name,
        version: r.version,
        description: r.description,
        steps: r.steps.length,
      });
    } catch (e) {
      // Skip recipes that fail to parse — surfaced via a warning channel later.
      console.warn(`[fusion-handlers] Skipping malformed recipe ${fileName}:`, e);
    }
  }
  return out;
}
