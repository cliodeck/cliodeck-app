/**
 * Fusion chat service (phase 3.2).
 *
 * Drives a streamed Brainstorm chat through the typed `ProviderRegistry`
 * (built from the user-level `LLMConfig` via the cliodeck adapter), with
 * automatic `.cliohints` injection. Each session has an `AbortController`
 * the renderer can trigger via `cancel(sessionId)`.
 *
 * Chunk streaming uses Electron's `webContents.send` to avoid creating
 * dynamic IPC channels: every chunk goes to the single
 * `fusion:chat:chunk` channel with `{ sessionId, chunk }` payload, and
 * the renderer demultiplexes by sessionId.
 *
 * Honest scope for 3.2:
 *   - Registry built per-call (no caching across messages); fine for the
 *     scaffold, will be promoted to a workspace-scoped singleton when 3.3
 *     introduces the bridge to Write.
 *   - Context compaction (4.2) NOT yet wired in — a TODO marker is
 *     deliberate so a follow-up commit hooks it once chat history grows
 *     beyond a single round.
 */

import type { WebContents } from 'electron';
import { randomUUID } from 'crypto';
import { configManager } from './config-manager.js';
import { projectManager } from './project-manager.js';
import {
  loadWorkspaceHints,
  prependAsSystemMessage,
} from '../../../backend/core/hints/loader.js';
import { createRegistryFromClioDeckConfig } from '../../../backend/core/llm/providers/cliodeck-config-adapter.js';
import type {
  ChatChunk,
  ChatMessage,
} from '../../../backend/core/llm/providers/base.js';

export interface ChatStartArgs {
  webContents: WebContents;
  messages: ChatMessage[];
  /** Optional caller-supplied id; otherwise generated. */
  sessionId?: string;
  opts?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
  };
}

export interface ChatStreamEnvelope {
  sessionId: string;
  chunk: ChatChunk;
  /** When present, terminal envelope carrying a fatal error message. */
  error?: { code: string; message: string };
}

class FusionChatService {
  private active = new Map<string, AbortController>();

  /**
   * Kick off a streamed chat. Returns synchronously with the sessionId;
   * chunks arrive on `webContents.send('fusion:chat:chunk', envelope)`.
   */
  start(args: ChatStartArgs): string {
    const sessionId = args.sessionId ?? randomUUID();
    const controller = new AbortController();
    this.active.set(sessionId, controller);

    // Fire and forget — the stream pumps chunks via webContents.
    void this.pump(sessionId, controller, args).finally(() => {
      this.active.delete(sessionId);
    });

    return sessionId;
  }

  cancel(sessionId: string): boolean {
    const c = this.active.get(sessionId);
    if (!c) return false;
    c.abort();
    return true;
  }

  private async pump(
    sessionId: string,
    controller: AbortController,
    args: ChatStartArgs
  ): Promise<void> {
    const send = (envelope: ChatStreamEnvelope): void => {
      try {
        if (!args.webContents.isDestroyed()) {
          args.webContents.send('fusion:chat:chunk', envelope);
        }
      } catch {
        // Renderer gone — abandon silently.
      }
    };

    let registry;
    try {
      const cfg = configManager.getLLMConfig();
      registry = createRegistryFromClioDeckConfig(cfg);
    } catch (e) {
      send({
        sessionId,
        chunk: { delta: '', done: true, finishReason: 'error' },
        error: {
          code: 'config_error',
          message: e instanceof Error ? e.message : String(e),
        },
      });
      return;
    }

    let messages = args.messages;
    const projectPath = projectManager.getCurrentProjectPath();
    if (projectPath) {
      try {
        const hints = await loadWorkspaceHints(projectPath);
        messages = prependAsSystemMessage(messages, hints);
      } catch {
        // Hints absent / unreadable — proceed without them.
      }
    }

    const llm = registry.getLLM();

    try {
      for await (const chunk of llm.chat(messages, {
        model: args.opts?.model,
        temperature: args.opts?.temperature,
        maxTokens: args.opts?.maxTokens,
        signal: controller.signal,
      })) {
        send({ sessionId, chunk });
        if (chunk.done) break;
      }
    } catch (e) {
      send({
        sessionId,
        chunk: { delta: '', done: true, finishReason: 'error' },
        error: {
          code: 'stream_error',
          message: e instanceof Error ? e.message : String(e),
        },
      });
    } finally {
      await registry.dispose().catch(() => undefined);
    }
  }
}

export const fusionChatService = new FusionChatService();
