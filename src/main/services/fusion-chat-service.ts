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
import { retrievalService, type MultiSourceSearchResult } from './retrieval-service.js';

export interface BrainstormSource {
  kind: 'archive' | 'bibliographie' | 'note';
  sourceType: 'primary' | 'secondary' | 'vault';
  title: string;
  snippet: string;
  similarity: number;
  relativePath?: string;
}

function hitsToSources(hits: MultiSourceSearchResult[]): BrainstormSource[] {
  return hits.map((h) => {
    const kind: BrainstormSource['kind'] =
      h.sourceType === 'primary'
        ? 'archive'
        : h.sourceType === 'vault'
          ? 'note'
          : 'bibliographie';
    const vaultSrc =
      h.sourceType === 'vault'
        ? (h.source as { relativePath?: string } | undefined)
        : undefined;
    const title = h.document.title || vaultSrc?.relativePath || 'Sans titre';
    return {
      kind,
      sourceType: h.sourceType,
      title,
      snippet: h.chunk.content.replace(/\s+/g, ' ').slice(0, 400),
      similarity: h.similarity,
      relativePath: vaultSrc?.relativePath,
    };
  });
}
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

    // RAG retrieval (fusion B2): find context chunks for the last user turn
    // and prepend them as a system message so the Brainstorm chat hits the
    // vector DB like the legacy RAG chat does. Fails soft: any error here
    // (no project, retrieval not configured, search failure) skips context
    // rather than aborting the stream.
    if (projectPath) {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      if (lastUser?.content?.trim()) {
        try {
          const hits = await retrievalService.search({
            query: lastUser.content,
            sourceType: 'both',
            includeVault: true,
          });
          if (hits.length > 0) {
            messages = [
              { role: 'system', content: formatContextAsSystemPrompt(hits) },
              ...messages,
            ];
            // Surface the hits to the renderer so the Brainstorm chat can
            // render them as cards alongside the assistant reply.
            try {
              if (!args.webContents.isDestroyed()) {
                args.webContents.send('fusion:chat:context', {
                  sessionId,
                  sources: hitsToSources(hits),
                });
              }
            } catch {
              // Renderer gone — continue streaming anyway.
            }
          }
        } catch (e) {
          console.warn(
            '[fusion-chat] retrieval skipped:',
            e instanceof Error ? e.message : e
          );
        }
      }
    }

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

/**
 * Render a set of retrieval hits as a system-prompt block. Kept minimal
 * (title + snippet, numbered) — the full explainable-AI panel lives in
 * the legacy chat and will be ported to Brainstorm once B3 lands.
 */
function formatContextAsSystemPrompt(hits: MultiSourceSearchResult[]): string {
  const lines: string[] = [
    'Contexte extrait du corpus indexé (sources citées ci-dessous).',
    "Utilise prioritairement ces extraits pour répondre ; indique clairement si l'information n'y figure pas.",
    '',
  ];
  hits.forEach((h, i) => {
    const title = h.document.title || h.document.id || 'Sans titre';
    const kind =
      h.sourceType === 'primary'
        ? 'archive'
        : h.sourceType === 'vault'
          ? 'note'
          : 'bibliographie';
    const snippet = h.chunk.content.replace(/\s+/g, ' ').slice(0, 800);
    lines.push(`[${i + 1}] (${kind}) ${title}`);
    lines.push(snippet);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}
