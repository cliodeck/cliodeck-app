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

import { ipcMain } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import { projectManager } from '../../services/project-manager.js';
import { fusionChatService } from '../../services/fusion-chat-service.js';
import {
  loadWorkspaceHints,
  writeWorkspaceHints,
} from '../../../../backend/core/hints/loader.js';
import { v2Paths } from '../../../../backend/core/workspace/layout.js';
import { parseRecipe } from '../../../../backend/recipes/schema.js';
import type { ChatMessage } from '../../../../backend/core/llm/providers/base.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';

const BUILTIN_RECIPES_DIR = path.join(
  process.cwd(),
  'backend',
  'recipes',
  'builtin'
);

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

  // MARK: - chat (streaming)

  ipcMain.handle(
    'fusion:chat:start',
    async (event, rawMessages: unknown, rawOpts: unknown) => {
      if (!Array.isArray(rawMessages)) {
        return errorResponse('messages must be an array');
      }
      const messages = rawMessages as ChatMessage[];
      const opts = (rawOpts ?? {}) as {
        model?: string;
        temperature?: number;
        maxTokens?: number;
      };
      const sessionId = fusionChatService.start({
        webContents: event.sender,
        messages,
        opts,
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

  // MARK: - vault status (read-only — indexing/search land with chat IPC)

  ipcMain.handle('fusion:vault:status', async () => {
    const root = projectManager.getCurrentProjectPath();
    if (!root) return noProject();
    try {
      const dbPath = path.join(
        root,
        '.cliodeck',
        'v2',
        'obsidian-vectors.db'
      );
      let exists = false;
      try {
        await fs.access(dbPath);
        exists = true;
      } catch {
        exists = false;
      }
      return successResponse({ indexed: exists, dbPath });
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
