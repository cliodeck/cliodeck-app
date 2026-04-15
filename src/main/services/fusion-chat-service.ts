/**
 * Fusion chat service (phase 3.2, refactored to use `ChatEngine`).
 *
 * Drives a streamed Brainstorm chat through the typed `ProviderRegistry`
 * (built from the user-level `LLMConfig` via the cliodeck adapter), with
 * automatic `.cliohints` injection. Each session has an `AbortController`
 * the renderer can trigger via `cancel(sessionId)`.
 *
 * The LLM turn loop (streaming, tool-use agent, retrieval injection) lives
 * in `chat-engine.ts` so the eventual legacy chat migration can share it.
 * This file is now strictly the Electron/IPC transport layer + wiring
 * (provider registry, `.cliohints`, MCP tools, retrieval adapter).
 */

import type { WebContents } from 'electron';
import { randomUUID } from 'crypto';
import { configManager } from './config-manager.js';
import { projectManager } from './project-manager.js';
import { retrievalService, type MultiSourceSearchResult } from './retrieval-service.js';
import { mcpClientsService } from './mcp-clients-service.js';
import type { ToolDescriptor } from '../../../backend/core/llm/providers/base.js';
import {
  brainstormSourceToUnified,
  type UnifiedSource,
} from '../../../backend/types/chat-source.js';
import {
  runChatTurn,
  type ChatEngineRetriever,
  type ChatEngineToolHandler,
} from './chat-engine.js';

export interface BrainstormSource {
  kind: 'archive' | 'bibliographie' | 'note';
  sourceType: 'primary' | 'secondary' | 'vault';
  title: string;
  snippet: string;
  similarity: number;
  relativePath?: string;
  // Traceability fields (see renderer store for field docs).
  documentId?: string;
  pageNumber?: number;
  chunkOffset?: number;
  itemId?: string;
  imagePath?: string;
  notePath?: string;
  lineNumber?: number;
}

/**
 * Lift RetrievalService hits into the wire-level `BrainstormSource` shape
 * used by the Brainstorm UI. Every hit carries enough information to
 * re-open its origin: the returned record is the single source of truth
 * for the citation click-through flow (`sources:open-pdf`,
 * `sources:reveal-tropy`, `sources:open-note`).
 */
/**
 * Fusion step 1: unified-typed companion to `hitsToSources`. Returns the
 * same hits in the shared `UnifiedSource` shape so downstream consumers
 * (future merged chat renderer) can ignore the per-surface legacy type.
 * Implemented in terms of `hitsToSources` + `brainstormSourceToUnified`
 * to keep a single place defining the traceability-field mapping.
 */
export function hitsToUnifiedSources(hits: MultiSourceSearchResult[]): UnifiedSource[] {
  return hitsToSources(hits).map(brainstormSourceToUnified);
}

export function hitsToSources(hits: MultiSourceSearchResult[]): BrainstormSource[] {
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

    const base: BrainstormSource = {
      kind,
      sourceType: h.sourceType,
      title,
      snippet: h.chunk.content.replace(/\s+/g, ' ').slice(0, 400),
      similarity: h.similarity,
      relativePath: vaultSrc?.relativePath,
    };

    if (h.sourceType === 'secondary') {
      // SearchResult: chunk.documentId + chunk.pageNumber + chunk.startPosition.
      const chunk = h.chunk as unknown as {
        documentId?: string;
        pageNumber?: number;
        startPosition?: number;
      };
      base.documentId = chunk.documentId ?? h.document.id;
      base.pageNumber = chunk.pageNumber;
      base.chunkOffset = chunk.startPosition;
    } else if (h.sourceType === 'primary') {
      base.itemId = h.document.id ?? h.chunk.documentId;
    } else if (h.sourceType === 'vault') {
      base.notePath = vaultSrc?.relativePath;
    }

    return base;
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
    const safeSend = (channel: string, payload: unknown): void => {
      try {
        if (!args.webContents.isDestroyed()) {
          args.webContents.send(channel, payload);
        }
      } catch {
        // Renderer gone — abandon silently.
      }
    };
    const sendChunk = (chunk: ChatChunk, error?: { code: string; message: string }): void => {
      const envelope: ChatStreamEnvelope = { sessionId, chunk };
      if (error) envelope.error = error;
      safeSend('fusion:chat:chunk', envelope);
    };

    let registry;
    try {
      const cfg = configManager.getLLMConfig();
      registry = createRegistryFromClioDeckConfig(cfg);
    } catch (e) {
      sendChunk(
        { delta: '', done: true, finishReason: 'error' },
        {
          code: 'config_error',
          message: e instanceof Error ? e.message : String(e),
        }
      );
      return;
    }

    let messages = args.messages;
    const projectPath = projectManager.getCurrentProjectPath();

    // Workspace hints — prepend before handing off to the engine so the
    // engine's retrieval-injected system message stacks on top cleanly.
    if (projectPath) {
      try {
        const hints = await loadWorkspaceHints(projectPath);
        messages = prependAsSystemMessage(messages, hints);
      } catch {
        // Hints absent / unreadable — proceed without them.
      }
    }

    const llm = registry.getLLM();

    // --- Assemble MCP tool catalog + dispatcher ---------------------------
    const toolScope = new Map<string, string>(); // namespaced tool name → client name
    const tools: ToolDescriptor[] = [];
    if (llm.capabilities.tools) {
      for (const client of mcpClientsService.list()) {
        if (client.state !== 'ready') continue;
        for (const t of client.tools) {
          const namespaced = `${client.name}__${t.name}`;
          toolScope.set(namespaced, client.name);
          tools.push({
            name: namespaced,
            description: `[${client.name}] ${t.description ?? ''}`.trim(),
            parameters:
              (t.inputSchema as Record<string, unknown>) ??
              ({ type: 'object', properties: {} } as Record<string, unknown>),
          });
        }
      }
    }

    const toolHandler: ChatEngineToolHandler = {
      async call(name, toolArgs) {
        const clientName = toolScope.get(name);
        if (!clientName) {
          return {
            ok: false,
            error: { code: 'unknown_tool', message: `No client owns tool ${name}` },
          };
        }
        const bare = name.slice(clientName.length + 2); // strip "clientName__"
        return mcpClientsService.callTool(clientName, bare, toolArgs);
      },
    };

    // --- Retrieval adapter -------------------------------------------------
    const retriever: ChatEngineRetriever<BrainstormSource> | undefined = projectPath
      ? {
          async search(lastUser) {
            const hits = await retrievalService.search({
              query: lastUser,
              sourceType: 'both',
              includeVault: true,
            });
            if (hits.length === 0) return null;
            return {
              systemPrompt: formatContextAsSystemPrompt(hits),
              sources: hitsToSources(hits),
            };
          },
        }
      : undefined;

    try {
      await runChatTurn<BrainstormSource>({
        provider: llm,
        messages,
        signal: controller.signal,
        opts: args.opts,
        tools,
        toolHandler,
        retriever,
        hooks: {
          onChunk: (chunk) => sendChunk(chunk),
          onDone: (chunk) => sendChunk(chunk),
          onError: (err) =>
            sendChunk({ delta: '', done: true, finishReason: 'error' }, err),
          onSources: (sources) => {
            safeSend('fusion:chat:context', { sessionId, sources });
          },
          onToolCallStart: (ev) => {
            // Preserve the legacy IPC shape (bareTool without client prefix,
            // sessionId-scoped callId) for the renderer.
            const clientName = toolScope.get(ev.name);
            const bareTool = clientName ? ev.name.slice(clientName.length + 2) : ev.name;
            safeSend('fusion:chat:tool-call', {
              sessionId,
              callId: `${sessionId}-${ev.callId}`,
              name: bareTool,
              status: 'started',
              startedAt: ev.startedAt,
            });
          },
          onToolCallEnd: (ev) => {
            const clientName = toolScope.get(ev.name);
            const bareTool = clientName ? ev.name.slice(clientName.length + 2) : ev.name;
            safeSend('fusion:chat:tool-call', {
              sessionId,
              callId: `${sessionId}-${ev.callId}`,
              name: bareTool,
              status: 'done',
              durationMs: ev.durationMs,
              ok: ev.ok,
              errorMessage: ev.errorMessage,
            });
          },
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
