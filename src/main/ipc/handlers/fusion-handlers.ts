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

import { ipcMain, dialog, app, shell, type IpcMainInvokeEvent } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import {
  validateMcpAddRequest,
  confirmMcpAdd,
  appendMcpAudit,
} from './mcp-add-guard.js';
import { projectManager } from '../../services/project-manager.js';
import {
  isToolEnabled,
  MCP_TOOL_NAMES,
} from '../../../../backend/mcp-server/config.js';
import {
  claudeDesktopConfigPath,
  claudeCodeCommand,
  launchCommand,
  mcpServerName,
  resolveServerName,
  mergeServerEntry,
  type ClaudeDesktopPlatform,
} from '../../../../backend/mcp-server/client-install.js';
import { configManager } from '../../services/config-manager.js';
import { fusionChatService } from '../../services/fusion-chat-service.js';
import { retrievalService } from '../../services/retrieval-service.js';
import { secureStorage, SENSITIVE_KEYS } from '../../services/secure-storage.js';
import {
  classifyProvider,
  cloudConsent,
} from '../../../../backend/security/cloud-consent.js';
import {
  validate,
  FusionChatStartSchema,
  FusionVaultIndexSchema,
  FusionVaultImportIdeasSchema,
  FusionMcpServerPatchSchema,
  FusionRecipeInputsSchema,
  FusionSecurityEventsSchema,
} from '../utils/validation.js';
import { isConsentedPath } from '../utils/user-consented-paths.js';
import {
  CONTEXT_FILE,
  ContextConflictError,
  ContextOutsideProjectError,
  loadWorkspaceHints,
  writeWorkspaceHints,
} from '../../../../backend/core/hints/loader.js';
import { UnreadableFileError, withFileLock } from '../../../../backend/core/fs/user-files.js';
import { sameFile } from '../../../../backend/core/vector-store/file-identity.js';
import { workspaceFiles } from '../../../../backend/core/workspace/layout.js';
import {
  workspaceLinkOutside,
  workspaceLinkOutsideMessage,
} from '../../../../backend/core/workspace/link-guard.js';
import { clampNumCtx } from '../../../../backend/core/llm/context-windows.js';
import {
  readOrInitWorkspaceConfig,
  readWorkspaceConfig,
  updateWorkspaceConfig,
  WorkspaceConfigError,
} from '../../../../backend/core/workspace/config.js';
import { parseRecipe, type Recipe } from '../../../../backend/recipes/schema.js';
import { RecipeRunner, recipeCallsLLM } from '../../../../backend/recipes/runner.js';
import { cloudConsentRefusal } from '../utils/cloud-consent-gate.js';
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

/** L'identifiant d'une passe de recette, choisi par le renderer. */
const RUN_ID_PATTERN = /^[\w-]{1,64}$/;

const BUILTIN_RECIPES_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'recipes-builtin')
  : path.join(process.cwd(), 'backend', 'recipes', 'builtin');

/**
 * `.cliodeck` ou l'un de ses fichiers lié hors du projet (D18) : recettes, journaux de passe et
 * journal de sécurité ne se lisent ni ne s'écrivent à travers le lien. `null` : rien à refuser.
 */
async function linkedOutsideResponse(root: string) {
  const entry = await workspaceLinkOutside(root);
  return entry ? errorResponse(workspaceLinkOutsideMessage(root, entry)) : null;
}

function noProject() {
  return { ...errorResponse('no_project'), error: 'no_project' as const };
}

/** Le code seul : c'est le renderer qui dit à l'auteur ce qui arrive à son texte. */
function contextFailure(error: string, reason?: string) {
  return { ...errorResponse(error), ...(reason ? { reason } : {}) };
}

/**
 * L'erreur à rendre si `config.json` est là sans se lire, `null` s'il se lit ou n'existe pas encore.
 * « Aucun serveur » ou « le mode par défaut » seraient faux : il en déclare peut-être.
 */
async function unreadableConfigResponse(root: string | null) {
  if (!root) return null;
  try {
    await readWorkspaceConfig(root);
    return null;
  } catch (e) {
    if (e instanceof WorkspaceConfigError && e.kind === 'absent') return null;
    return errorResponse(e as Error);
  }
}

export function setupFusionHandlers(): void {
  // MARK: - hints

  ipcMain.handle('fusion:hints:read', async () => {
    const root = projectManager.getCurrentProjectPath();
    if (!root) return noProject();
    try {
      // Le verrou : une lecture demandée après une écriture lit ce que celle-ci a écrit,
      // sans quoi le texte attendu de l'écriture suivante serait déjà périmé.
      const h = await withFileLock(path.join(root, CONTEXT_FILE), () => loadWorkspaceHints(root));
      return successResponse({ hints: h });
    } catch (e) {
      return errorResponse(e as Error);
    }
  });

  // Pas d'écriture à l'aveugle : le texte lu et le projet pour lequel il l'a été. Sans ce
  // dernier, deux gabarits identiques feraient atterrir le texte dans l'autre projet.
  ipcMain.handle('fusion:hints:write', async (_e, rawMarkdown: unknown, rawGuard: unknown) => {
    const root = projectManager.getCurrentProjectPath();
    if (!root) return noProject();
    if (typeof rawMarkdown !== 'string') {
      return errorResponse('hints content must be a string');
    }
    const guard = (rawGuard ?? {}) as { expectedRaw?: unknown; projectPath?: unknown };
    if (typeof guard.expectedRaw !== 'string' || typeof guard.projectPath !== 'string') {
      return errorResponse('hints write needs the text it read and its project');
    }
    const { expectedRaw, projectPath } = guard;
    if (!sameFile(root, projectPath)) return contextFailure('context_project_changed');
    // Le verrou avant le premier `await` : deux écritures gardent leur ordre d'arrivée.
    return withFileLock(path.join(root, CONTEXT_FILE), async () => {
      try {
        // Aucun `mkdir` ici : `context.md` vit à la racine du projet, et si elle a disparu, la
        // recréer ferait écrire ce texte dans un squelette, loin du vrai dossier.
        await writeWorkspaceHints(root, rawMarkdown, { expectedRaw });
        const h = await loadWorkspaceHints(root);
        return successResponse({ hints: h });
      } catch (e) {
        if (e instanceof ContextConflictError || e instanceof ContextOutsideProjectError) {
          return contextFailure(e.code);
        }
        if (e instanceof UnreadableFileError) return contextFailure('context_unreadable', e.reason);
        return errorResponse(e as Error);
      }
    });
  });

  // MARK: - recipes

  /**
   * Les passes en cours, par identifiant : fermer la fenêtre d'une recette l'annule (D20).
   * L'identifiant vient du renderer avec la demande, pour qu'une annulation tardive ne
   * vise jamais la passe suivante.
   */
  const recipeRuns = new Map<string, AbortController>();

  ipcMain.handle('fusion:recipes:list', async () => {
    try {
      const root = projectManager.getCurrentProjectPath();
      const builtin = await listRecipes(BUILTIN_RECIPES_DIR);
      let user: RecipeSummary[] = [];
      if (root && !(await workspaceLinkOutside(root))) {
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
      const root = projectManager.getCurrentProjectPath();
      const linked = rawScope === 'user' && root ? await linkedOutsideResponse(root) : null;
      if (linked) return linked;
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
      const root = projectManager.getCurrentProjectPath();
      const linked = rawScope === 'user' && root ? await linkedOutsideResponse(root) : null;
      if (linked) return linked;
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
      const linked = await linkedOutsideResponse(root);
      if (linked) return linked;
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
      rawInputs: unknown,
      rawRunId: unknown
    ) => {
      const root = projectManager.getCurrentProjectPath();
      if (!root) return noProject();
      if (rawScope !== 'builtin' && rawScope !== 'user') {
        return errorResponse('scope must be "builtin" or "user"');
      }
      if (typeof rawFileName !== 'string' || !/^[\w.-]+\.ya?ml$/i.test(rawFileName)) {
        return errorResponse('invalid recipe fileName');
      }
      let inputs: Record<string, unknown>;
      try {
        inputs = validate(FusionRecipeInputsSchema, rawInputs ?? undefined) ?? {};
      } catch (e) {
        return errorResponse(e as Error);
      }
      const runId =
        rawRunId === undefined
          ? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
          : rawRunId;
      if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
        return errorResponse('invalid recipe runId');
      }
      if (recipeRuns.has(runId)) return errorResponse('recipe runId already running');
      // Inscrite avant le premier `await` : une annulation partie juste après la demande la trouve.
      const controller = new AbortController();
      recipeRuns.set(runId, controller);
      try {
        return await runRecipe(event, root, rawScope, rawFileName, inputs, runId, controller.signal);
      } finally {
        recipeRuns.delete(runId);
      }
    }
  );

  ipcMain.handle('fusion:recipes:cancel', (_event, rawRunId: unknown) => {
    if (typeof rawRunId !== 'string') return errorResponse('invalid recipe runId');
    // Rien à attendre : la passe rend la main d'elle-même, et une passe déjà finie n'est plus là.
    recipeRuns.get(rawRunId)?.abort();
    return successResponse({});
  });

  async function runRecipe(
    event: IpcMainInvokeEvent,
    root: string,
    rawScope: 'builtin' | 'user',
    rawFileName: string,
    inputs: Record<string, unknown>,
    runId: string,
    signal: AbortSignal
  ) {
    // Même une recette intégrée : son journal de passe s'écrit dans `recipes-runs/`.
    const linked = await linkedOutsideResponse(root);
    if (linked) return linked;
    const baseDir =
      rawScope === 'builtin' ? BUILTIN_RECIPES_DIR : workspaceFiles(root).recipesDir;
    let recipe: Recipe;
    try {
      const raw = await fs.readFile(path.join(baseDir, rawFileName), 'utf8');
      recipe = parseRecipe(raw);
    } catch (e) {
      return errorResponse(e as Error);
    }

    const cfg = configManager.getLLMConfig();
    // Les étapes brainstorm / write envoient leurs prompts interpolés au
    // LLM : consentement distant avant de construire le registre (ADR 0005).
    if (recipeCallsLLM(recipe)) {
      const refusal = await cloudConsentRefusal('recipe', cfg, event.sender);
      if (refusal) return errorResponse(refusal);
    }
    // Fermée pendant la question : rien n'a commencé, il n'y a rien à tracer.
    if (signal.aborted) return successResponse({ runId, ok: false, cancelled: true, outputs: {} });
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
      const result = await runner.run(recipe, inputs, signal);
      return successResponse({
        runId,
        ok: result.ok,
        cancelled: result.cancelled,
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
      // `numCtx` hors bornes devient « défaut du modèle » plutôt qu'une
      // erreur : « 0 » est la convention du renderer pour cela. Les bornes
      // vivent dans `context-windows.ts` — le plafond de 262 144 codé ici
      // bloquait les fenêtres d'un million de jetons des Qwen 3.5.
      const opts = {
        model: rawOptsObj.model,
        temperature: rawOptsObj.temperature,
        maxTokens: rawOptsObj.maxTokens,
        numCtx: clampNumCtx(rawOptsObj.numCtx),
        topP: rawOptsObj.topP,
        topK: rawOptsObj.topK,
        repeatPenalty: rawOptsObj.repeatPenalty,
        think: rawOptsObj.think,
        timeoutMs: rawOptsObj.timeoutMs,
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
    const refusal = await unreadableConfigResponse(projectManager.getCurrentProjectPath());
    if (refusal) return refusal;
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

    // Avant la question : l'auteur ne confirme pas un ajout voué au refus, et le message dit le
    // vrai motif, y compris quand le service n'a pas encore chargé ce projet.
    if (root) {
      try {
        await readOrInitWorkspaceConfig(root);
      } catch (e) {
        return errorResponse(e as Error);
      }
    }

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
      const block =
        (cfg.mcpServer as
          | { enabled?: unknown; serverName?: unknown; tools?: unknown }
          | undefined) ?? {};
      const enabled = block.enabled === true;
      // On renvoie l'état *effectif* de chaque outil, pas le réglage brut :
      // l'absence ne veut pas dire la même chose pour tous (les outils de
      // lecture du manuscrit sont refusés sauf accord).
      const stored =
        block.tools && typeof block.tools === 'object'
          ? (block.tools as Record<string, boolean>)
          : {};
      const tools = Object.fromEntries(
        MCP_TOOL_NAMES.map((name) => [name, isToolEnabled({ enabled, tools: stored }, name)])
      );
      const serverName = resolveServerName(block.serverName, root);
      // Resolve the wrapper script. In dev it lives in <repo>/bin; when
      // packaged it ships under resources/bin (electron-builder
      // `extraResources`). The renderer needs an absolute path so the
      // snippets can be copy-pasted verbatim. Windows gets the .cmd: an MCP
      // client cannot spawn the POSIX script there.
      const wrapperName = process.platform === 'win32' ? 'cliodeck-mcp.cmd' : 'cliodeck-mcp';
      const devBin = path.join(process.cwd(), 'bin', wrapperName);
      const packagedBin = path.join(process.resourcesPath ?? '', 'bin', wrapperName);
      let binaryPath: string | null = null;
      if (!app.isPackaged && fsSync.existsSync(devBin)) {
        binaryPath = devBin;
      } else if (app.isPackaged && fsSync.existsSync(packagedBin)) {
        binaryPath = packagedBin;
      } else if (fsSync.existsSync(devBin)) {
        binaryPath = devBin;
      }
      // Les commandes à copier sont construites ici, où l'on connaît le
      // système : c'est lui qui décide des guillemets. Le panneau en
      // fabriquait une copie sans aucun guillemet (cf. `claudeCodeCommand`).
      const platform = process.platform as ClaudeDesktopPlatform;
      const entry = binaryPath ? { command: binaryPath, args: [root] } : null;
      return successResponse({
        enabled,
        serverName,
        workspaceRoot: root,
        binaryPath,
        commands: entry
          ? {
              claudeCode: claudeCodeCommand(serverName, entry, platform),
              launch: launchCommand(entry, platform),
            }
          : null,
        tools,
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
      let patch: { enabled?: boolean; serverName?: string; tools?: Record<string, boolean> };
      try {
        patch = validate(FusionMcpServerPatchSchema, rawPatch);
      } catch (e) {
        return errorResponse(e as Error);
      }
      try {
        const next: {
          enabled: boolean;
          serverName?: string;
          tools?: Record<string, boolean>;
        } = { enabled: false };
        await updateWorkspaceConfig(root, (cfg) => {
          const current =
            (cfg.mcpServer as
              | { enabled?: boolean; serverName?: string; tools?: Record<string, boolean> }
              | undefined) ?? {};
          next.enabled =
            typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled === true;
          // Fusion et non remplacement : le panneau n'envoie que l'outil qu'on
          // vient de cocher.
          const mergedTools = { ...(current.tools ?? {}), ...(patch.tools ?? {}) };
          if (Object.keys(mergedTools).length > 0) next.tools = mergedTools;
          if (typeof patch.serverName === 'string') {
            // Enregistré sous sa forme valide : le nom affiché dans le panneau
            // est celui qu'utiliseront les clients.
            const trimmed = patch.serverName.trim();
            if (trimmed.length > 0) next.serverName = mcpServerName(trimmed);
          } else if (typeof current.serverName === 'string') {
            next.serverName = current.serverName;
          }
          cfg.mcpServer = next;
        });
        return successResponse({
          enabled: next.enabled,
          tools: next.tools ?? {},
          serverName: resolveServerName(next.serverName, root),
        });
      } catch (e) {
        return errorResponse(e as Error);
      }
    }
  );

  // MARK: - MCP server: déclaration auprès des clients

  /**
   * Chemin du paquet d'extension embarqué. Il est produit par
   * `npm run build:mcpb` dans `resources/`, et electron-builder le recopie
   * sous `resources/resources/` dans l'app installée.
   */
  function bundledExtensionPath(): string | null {
    const devPath = path.join(process.cwd(), 'resources', 'cliodeck.mcpb');
    const packagedPath = path.join(process.resourcesPath ?? '', 'resources', 'cliodeck.mcpb');
    if (app.isPackaged && fsSync.existsSync(packagedPath)) return packagedPath;
    if (fsSync.existsSync(devPath)) return devPath;
    return null;
  }

  ipcMain.handle('fusion:mcpServer:clients', async () => {
    const root = projectManager.getCurrentProjectPath();
    if (!root) return noProject();
    try {
      const platform = process.platform as ClaudeDesktopPlatform;
      const desktopConfig = claudeDesktopConfigPath(platform, {
        home: app.getPath('home'),
        appData: process.env.APPDATA,
      });
      return successResponse({
        platform,
        extensionPath: bundledExtensionPath(),
        // null sous Linux : Claude Desktop n'y existe pas, et y écrire une
        // configuration donnerait l'illusion d'avoir branché quelque chose.
        desktopConfigPath: desktopConfig,
        desktopConfigExists: desktopConfig ? fsSync.existsSync(desktopConfig) : false,
      });
    } catch (e) {
      return errorResponse(e as Error);
    }
  });

  /** Ouvre le .mcpb : Claude Desktop prend la main et affiche son dialogue. */
  ipcMain.handle('fusion:mcpServer:installExtension', async () => {
    const file = bundledExtensionPath();
    if (!file) {
      return errorResponse(new Error("Paquet d'extension introuvable (npm run build:mcpb)."));
    }
    const problem = await shell.openPath(file);
    if (problem) return errorResponse(new Error(problem));
    return successResponse({ opened: file });
  });

  /**
   * Écrit l'entrée du projet dans `claude_desktop_config.json`.
   *
   * Le fichier appartient à Claude Desktop et contient déjà les serveurs de
   * l'utilisateur : on fusionne, on ne remplace jamais, et on dépose une
   * copie `.bak` avant d'écrire. Action explicite seulement — jamais au
   * démarrage.
   */
  ipcMain.handle('fusion:mcpServer:configureClaudeDesktop', async () => {
    const root = projectManager.getCurrentProjectPath();
    if (!root) return noProject();
    try {
      const platform = process.platform as ClaudeDesktopPlatform;
      const target = claudeDesktopConfigPath(platform, {
        home: app.getPath('home'),
        appData: process.env.APPDATA,
      });
      if (!target) {
        return errorResponse(
          new Error("Claude Desktop n'existe pas sur ce système ; utilisez la commande Claude Code.")
        );
      }

      const wrapperName = process.platform === 'win32' ? 'cliodeck-mcp.cmd' : 'cliodeck-mcp';
      const devBin = path.join(process.cwd(), 'bin', wrapperName);
      const packagedBin = path.join(process.resourcesPath ?? '', 'bin', wrapperName);
      const command =
        app.isPackaged && fsSync.existsSync(packagedBin)
          ? packagedBin
          : fsSync.existsSync(devBin)
            ? devBin
            : null;
      if (!command) return errorResponse(new Error('Binaire cliodeck-mcp introuvable.'));

      const cfg = await readOrInitWorkspaceConfig(root);
      const block = (cfg.mcpServer as { serverName?: unknown } | undefined) ?? {};
      const serverName = resolveServerName(block.serverName, root);

      let existing: Record<string, unknown> | null = null;
      if (fsSync.existsSync(target)) {
        const raw = await fs.readFile(target, 'utf8');
        try {
          existing = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          // Un fichier illisible ne doit pas être écrasé en silence : on
          // s'arrête et l'utilisateur décide.
          return errorResponse(
            new Error(`${target} n'est pas un JSON valide ; corrigez-le avant de continuer.`)
          );
        }
        await fs.copyFile(target, `${target}.bak`);
      } else {
        await fs.mkdir(path.dirname(target), { recursive: true });
      }

      const { config, status } = mergeServerEntry(existing, serverName, {
        command,
        args: [root],
      });
      await fs.writeFile(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

      return successResponse({
        path: target,
        serverName,
        status,
        backedUp: existing !== null,
        claudeCodeCommand: claudeCodeCommand(serverName, { command, args: [root] }, platform),
      });
    } catch (e) {
      return errorResponse(e as Error);
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
      } catch (e) {
        // Absent : rien d'initialisé encore. Illisible, c'est autre chose : répondre « aucun coffre »
        // inviterait à en lier un, et l'écriture serait refusée.
        if (!(e instanceof WorkspaceConfigError) || e.kind !== 'absent') throw e;
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
    // Hors projet, seul un dossier choisi dans un dialogue natif est accepté
    // (cf. user-consented-paths). Sans cela, un renderer compromis pouvait
    // désigner `~` comme coffre : l'indexation faisait entrer `~/.ssh` dans
    // un corpus que le chat peut envoyer à un fournisseur distant.
    if (!(await isConsentedPath(vaultPath))) {
      return errorResponse('vault path must be chosen in the folder dialog');
    }
    try {
      const stat = await fs.stat(vaultPath);
      if (!stat.isDirectory()) {
        return errorResponse('vault path is not a directory');
      }
    } catch {
      return errorResponse('vault path does not exist');
    }
    try {
      await updateWorkspaceConfig(root, (cfg) => {
        cfg.vault = { ...((cfg.vault as VaultConfigBlock) ?? {}), path: vaultPath };
      });
      return successResponse({ vaultPath });
    } catch (e) {
      return errorResponse(e as Error);
    }
  });

  ipcMain.handle('fusion:vault:unlink', async () => {
    const root = projectManager.getCurrentProjectPath();
    if (!root) return noProject();
    try {
      await updateWorkspaceConfig(root, (cfg) => {
        delete cfg.vault;
      });
      // brain.db est partagé (PDF, Tropy, journal) : on ne supprime que les
      // tables obsidian_*, jamais le fichier lui-même.
      ObsidianVaultStore.purgeObsidianData(obsidianStorePath(root));
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
    let opts: { maxFiles?: number };
    try {
      opts = validate(FusionVaultImportIdeasSchema, rawOpts ?? undefined) ?? {};
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
    const appliedMode = retrievalService.getInspectorMode();
    const refusal = await unreadableConfigResponse(projectManager.getCurrentProjectPath());
    // Le choix de l'auteur est inconnu ; ce qui s'applique en attendant, lui, se dit.
    if (refusal) return { ...refusal, appliedMode };
    return successResponse({ mode: appliedMode });
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
      await updateWorkspaceConfig(root, (cfg) => {
        cfg.security = { ...(cfg.security ?? {}), sourceInspectorMode: rawMode };
      });
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
    let recentLimit: number | undefined;
    try {
      recentLimit = validate(FusionSecurityEventsSchema, rawOpts ?? undefined)?.recentLimit;
    } catch (e) {
      return errorResponse(e as Error);
    }
    const linked = await linkedOutsideResponse(root);
    if (linked) return linked;
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
    // La classification qui fait foi est celle du main. Le renderer dit pour
    // quel fournisseur l'utilisateur a accepté ; s'il ne s'agit pas de celui
    // que le main appellera (réglage changé entre le dialogue et l'accord,
    // classifications divergentes), on n'accorde rien : le main posera sa
    // propre question au premier envoi. Avant, le libellé du renderer était
    // enregistré tel quel — alors que c'est lui que la décision compare.
    if (typeof rawProvider !== 'string' || rawProvider !== providerName) {
      return successResponse({
        granted: false,
        consentedProvider: cloudConsent.consentedProvider(),
        reason: 'provider_mismatch',
      });
    }
    cloudConsent.grant(providerName);
    return successResponse({ granted: true, consentedProvider: providerName });
  });

  ipcMain.handle('fusion:consent:revoke', async () => {
    cloudConsent.revoke();
    return successResponse({ granted: false });
  });

  // MARK: - credential revocation (ADR 0006)
  // Clés stockées mais indéchiffrables avec le trousseau courant : le
  // renderer les affiche dans Réglages → Sécurité, avec de quoi les
  // supprimer (une clé s'efface par `config:set(clé, '')`).
  ipcMain.handle('fusion:security:get-unreadable-keys', async () => {
    try {
      // Force une lecture : la liste se remplit au premier déchiffrement raté.
      for (const key of SENSITIVE_KEYS) secureStorage.getKey(key);
      return successResponse({ keys: secureStorage.unreadableKeys() });
    } catch (e) {
      return errorResponse(e as Error);
    }
  });

  // Repli en clair (ADR 0006, dette n° 16) : sans trousseau système, les clés
  // sont écrites non chiffrées. Réglages → Sécurité l'affiche ; avant, seule
  // une ligne de console au démarrage le disait.
  ipcMain.handle('fusion:security:get-storage-status', async () => {
    try {
      return successResponse({
        encrypted: secureStorage.isEncrypted(),
        plaintextKeys: secureStorage.plaintextKeys(),
      });
    } catch (e) {
      return errorResponse(e as Error);
    }
  });

  ipcMain.handle('fusion:security:revoke-all-keys', async () => {
    try {
      const count = secureStorage.revokeAll();
      // Log revocation event
      const root = projectManager.getCurrentProjectPath();
      if (root && !(await workspaceLinkOutside(root))) {
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
