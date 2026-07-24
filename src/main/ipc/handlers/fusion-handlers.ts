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
  classifyProvider,
  cloudConsent,
} from '../../../../backend/security/cloud-consent.js';
import {
  validate,
  FusionChatStartSchema,
  FusionVaultIndexSchema,
  FusionMcpServerPatchSchema,
} from '../utils/validation.js';
import {
  loadWorkspaceHints,
  writeWorkspaceHints,
} from '../../../../backend/core/hints/loader.js';
import {
  ensureWorkspaceDirectories,
  workspaceFiles,
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
import { importVaultAsIdeas } from '../../../../backend/integrations/obsidian/obsidian-to-ideas.js';
import { createRegistryFromClioDeckConfig } from '../../../../backend/core/llm/providers/cliodeck-config-adapter.js';
import { runBatch } from '../../../../backend/core/usage-journal/context.js';
import type { ChatMessage } from '../../../../backend/core/llm/providers/base.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';

interface VaultConfigBlock {
  path?: string;
}

async function readOrInitWorkspaceConfig(root: string): Promise<WorkspaceConfig> {
  await ensureWorkspaceDirectories(root);
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
      await fs.mkdir(workspaceFiles(root).root, { recursive: true });
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
        const userDir = workspaceFiles(root).recipesDir;
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
              return root ? workspaceFiles(root).recipesDir : null;
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

  // Read raw YAML for the recipe editor (A14)
  ipcMain.handle(
    'fusion:recipes:read-yaml',
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
              return root ? workspaceFiles(root).recipesDir : null;
            })();
      if (!baseDir) return noProject();
      try {
        const raw = await fs.readFile(path.join(baseDir, rawFileName), 'utf8');
        return successResponse({ yaml: raw });
      } catch (e) {
        return errorResponse(e as Error);
      }
    }
  );

  // Save recipe YAML to disk (A14 — user recipes only)
  ipcMain.handle(
    'fusion:recipes:save',
    async (_e, rawFileName: unknown, rawYaml: unknown) => {
      const root = projectManager.getCurrentProjectPath();
      if (!root) return noProject();
      if (typeof rawFileName !== 'string' || !/^[\w.-]+\.ya?ml$/i.test(rawFileName)) {
        return errorResponse('invalid recipe fileName');
      }
      if (typeof rawYaml !== 'string') {
        return errorResponse('yaml must be a string');
      }
      // Validate before saving
      try {
        parseRecipe(rawYaml);
      } catch (e) {
        return errorResponse(e as Error);
      }
      const userDir = workspaceFiles(root).recipesDir;
      try {
        await fs.mkdir(userDir, { recursive: true });
        await fs.writeFile(path.join(userDir, rawFileName), rawYaml, 'utf8');
        return successResponse({});
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
        rawScope === 'builtin' ? BUILTIN_RECIPES_DIR : workspaceFiles(root).recipesDir;
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
      // Forme validée avant toute traversée : `messages` était castée sans
      // regarder son contenu, et les options passaient telles quelles.
      let parsed;
      try {
        parsed = validate(FusionChatStartSchema, {
          messages: rawMessages,
          opts: rawOpts ?? undefined,
        });
      } catch (e) {
        return errorResponse(e as Error);
      }
      const messages = parsed.messages as ChatMessage[];
      const rawOptsObj = parsed.opts ?? {};
      // Clamp `numCtx` defensively — Ollama silently ignores absurd
      // values, but the validation here surfaces user-config errors
      // ("0 = use default" stays as undefined, < 512 is too small for
      // even a single RAG chunk, > 262144 is past any current model).
      const rawNumCtx = rawOptsObj.numCtx;
      const numCtx =
        typeof rawNumCtx === 'number' &&
        Number.isFinite(rawNumCtx) &&
        rawNumCtx >= 512 &&
        rawNumCtx <= 262_144
          ? Math.floor(rawNumCtx)
          : undefined;
      const opts = {
        model: rawOptsObj.model,
        temperature: rawOptsObj.temperature,
        maxTokens: rawOptsObj.maxTokens,
        numCtx,
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
    const auditPath = root ? workspaceFiles(root).mcpAccessLog : null;

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

  // MARK: - MCP server (this project exposed AS a server to external clients)

  ipcMain.handle('fusion:mcpServer:get', async () => {
    const root = projectManager.getCurrentProjectPath();
    if (!root) return noProject();
    try {
      const cfg = await readOrInitWorkspaceConfig(root);
      const block = (cfg.mcpServer as { enabled?: unknown; serverName?: unknown } | undefined) ?? {};
      const enabled = block.enabled === true;
      const serverName =
        typeof block.serverName === 'string' && block.serverName.trim().length > 0
          ? block.serverName.trim()
          : path.basename(root);
      // Resolve the wrapper script. In dev it lives in <repo>/bin; when
      // packaged it ships under resources/. The renderer needs an absolute
      // path so the snippets can be copy-pasted verbatim.
      const devBin = path.join(process.cwd(), 'bin', 'cliodeck-mcp');
      const packagedBin = path.join(process.resourcesPath ?? '', 'bin', 'cliodeck-mcp');
      let binaryPath: string | null = null;
      if (!app.isPackaged && fsSync.existsSync(devBin)) {
        binaryPath = devBin;
      } else if (app.isPackaged && fsSync.existsSync(packagedBin)) {
        binaryPath = packagedBin;
      } else if (fsSync.existsSync(devBin)) {
        binaryPath = devBin;
      }
      return successResponse({
        enabled,
        serverName,
        workspaceRoot: root,
        binaryPath,
      });
    } catch (e) {
      return errorResponse(e as Error);
    }
  });

  ipcMain.handle(
    'fusion:mcpServer:set',
    async (_e, rawPatch: unknown) => {
      const root = projectManager.getCurrentProjectPath();
      if (!root) return noProject();
      let patch: { enabled?: boolean; serverName?: string };
      try {
        patch = validate(FusionMcpServerPatchSchema, rawPatch);
      } catch (e) {
        return errorResponse(e as Error);
      }
      try {
        const cfg = await readOrInitWorkspaceConfig(root);
        const current =
          (cfg.mcpServer as { enabled?: boolean; serverName?: string } | undefined) ?? {};
        const next: { enabled: boolean; serverName?: string } = {
          enabled:
            typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled === true,
        };
        if (typeof patch.serverName === 'string') {
          const trimmed = patch.serverName.trim();
          if (trimmed.length > 0) next.serverName = trimmed;
        } else if (typeof current.serverName === 'string') {
          next.serverName = current.serverName;
        }
        cfg.mcpServer = next;
        await writeWorkspaceConfig(root, cfg);
        return successResponse({
          enabled: next.enabled,
          serverName: next.serverName ?? path.basename(root),
        });
      } catch (e) {
        return errorResponse(e as Error);
      }
    }
  );

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
    let opts: { force?: boolean };
    try {
      opts = validate(FusionVaultIndexSchema, rawOpts ?? undefined) ?? {};
    } catch (e) {
      return errorResponse(e as Error);
    }
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
        // Scope de batch : agrège les embeddings du vault en un seul
        // `embedding_batch` (journal d'usage IA) pour cette indexation.
        const report = await runBatch('obsidian', () =>
          reader.scan().then(() =>
            new ObsidianVaultIndexer(reader, store, embedder).indexAll({
              force: !!opts.force,
              onProgress: (p) => {
                try {
                  if (!event.sender.isDestroyed()) {
                    // Le job est scopé par `root` (capturé en tête de
                    // handler) mais l'événement ne l'était pas : des
                    // Settings rouverts sur un AUTRE projet affichaient
                    // les chiffres de ce job (#35). Le renderer filtre
                    // sur projectRoot.
                    event.sender.send('fusion:vault:progress', {
                      ...p,
                      projectRoot: root,
                    });
                  }
                } catch {
                  // Renderer gone — continue indexing anyway.
                }
              },
            })
          )
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

  // MARK: - vault → ideas import (A11.6)

  ipcMain.handle('fusion:vault:import-as-ideas', async (_event, rawOpts: unknown) => {
    const root = projectManager.getCurrentProjectPath();
    if (!root) return noProject();
    try {
      const cfg = await readOrInitWorkspaceConfig(root);
      const vaultPath = (cfg.vault as VaultConfigBlock | undefined)?.path;
      if (!vaultPath) {
        return errorResponse('no_vault_configured');
      }
      if (!fsSync.existsSync(vaultPath)) {
        return errorResponse('vault path no longer exists');
      }
      const opts = (rawOpts ?? {}) as { maxFiles?: number };
      const imported = await importVaultAsIdeas(vaultPath, { maxFiles: opts.maxFiles ?? 500 });
      return successResponse({
        ideas: imported.map((idea) => ({
          title: idea.title,
          content: idea.content,
          tags: idea.tags,
          wikilinks: idea.wikilinks,
          notePath: idea.notePath,
        })),
        count: imported.length,
      });
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

  // Stats over `.cliodeck/security-events.jsonl` (fusion 2.8).
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
        workspaceFiles(root).securityEventsLog
      );
      const stats = aggregateSecurityEvents(events, { recentLimit });
      return successResponse({ stats });
    } catch (e) {
      return errorResponse(e as Error);
    }
  });

  // MARK: - cloud consent (ADR 0005)
  // La décision et l'état vivent dans le main (backend/security/cloud-consent).
  // Ces canaux existent pour que le dialogue du renderer, quand il a déjà
  // obtenu l'accord de l'utilisateur, le fasse savoir au main — sans quoi
  // celui-ci afficherait son propre dialogue natif de secours.
  ipcMain.handle('fusion:consent:status', async () => {
    const cfg = configManager.getLLMConfig();
    const { isCloud, providerName } = classifyProvider({
      backend: cfg.backend,
      ollamaURL: cfg.ollamaURL,
    });
    return successResponse({
      isCloud,
      providerName,
      granted: cloudConsent.isGranted(),
      consentedProvider: cloudConsent.consentedProvider(),
    });
  });

  ipcMain.handle('fusion:consent:grant', async (_e, rawProvider: unknown) => {
    const cfg = configManager.getLLMConfig();
    const { providerName } = classifyProvider({
      backend: cfg.backend,
      ollamaURL: cfg.ollamaURL,
    });
    // Le nom fourni par le renderer n'est qu'un libellé d'affichage : la
    // classification qui fait foi est celle du main.
    const label = typeof rawProvider === 'string' && rawProvider ? rawProvider : providerName;
    cloudConsent.grant(label);
    return successResponse({ granted: true, consentedProvider: label });
  });

  ipcMain.handle('fusion:consent:revoke', async () => {
    cloudConsent.revoke();
    return successResponse({ granted: false });
  });

  // MARK: - credential revocation (ADR 0006)
  ipcMain.handle('fusion:security:revoke-all-keys', async () => {
    try {
      const count = secureStorage.revokeAll();
      // Log revocation event
      const root = projectManager.getCurrentProjectPath();
      if (root) {
        const logPath = workspaceFiles(root).securityEventsLog;
        const event = JSON.stringify({
          kind: 'credential_revocation',
          keysDeleted: count,
          at: new Date().toISOString(),
        });
        await fs.appendFile(logPath, event + '\n', 'utf8').catch(() => {});
      }
      return successResponse({ keysDeleted: count });
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
