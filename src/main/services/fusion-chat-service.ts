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
  type RAGExplanation,
} from '../../../backend/types/chat-source.js';
import {
  runChatTurn,
  type ChatEngineRetriever,
  type ChatEngineRetrievalOptions,
  type ChatEngineSystemPromptConfig,
  type ChatEngineToolHandler,
} from './chat-engine.js';
import { modeService } from './mode-service.js';
import { historyService } from './history-service.js';

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

/**
 * RAG filter/tuning bag carried from the renderer into the retriever. Same
 * fields as the legacy `EnrichedRAGOptions` but reduced to what actually
 * matters cross-cutting: scoping and topK. Vault opt-in is implicit via
 * `sourceType === 'vault'` (or caller keeps the Brainstorm default of
 * primary+secondary+vault).
 */
export interface FusionChatRetrievalOptions {
  documentIds?: string[];
  collectionKeys?: string[];
  sourceType?: 'primary' | 'secondary' | 'both' | 'vault';
  /** Opt-in to Obsidian vault alongside primary/secondary. Ignored when
   *  `sourceType === 'vault'` (vault-only). */
  includeVault?: boolean;
  topK?: number;
}

export interface FusionChatSystemPromptOptions {
  /** Mode id — resolved to text via `modeService.getModeManager()`. */
  modeId?: string;
  /** Free-form override; takes precedence over the resolved mode text. */
  customText?: string;
  /**
   * Free-mode switch (legacy parity with `chat-service.noSystemPrompt`).
   * When true — or when `modeId === 'free-mode'` — the service injects NO
   * system prompt: no `.cliohints`, no resolved mode text, no custom text.
   * The outgoing message list contains only the caller-supplied messages.
   */
  noPrompt?: boolean;
}

/**
 * True when the caller asked for free-mode (no system prompt at all).
 * Centralised so the hints-skip branch and the mode-resolution-skip branch
 * stay in sync.
 */
export function isFreeMode(sp: FusionChatSystemPromptOptions | undefined): boolean {
  if (!sp) return false;
  if (sp.noPrompt === true) return true;
  if (sp.modeId === 'free-mode' || sp.modeId === 'free') return true;
  return false;
}

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
  /** Filters forwarded to `RetrievalService`. */
  retrievalOptions?: FusionChatRetrievalOptions;
  /** System-prompt override (mode / custom text). */
  systemPrompt?: FusionChatSystemPromptOptions;
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
    void this.pump(sessionId, controller, args)
      .catch((e) => {
        // Unhandled errors inside pump() would otherwise be swallowed by
        // the fire-and-forget pattern; surface them so we see the root cause.
        console.error('[fusion-chat] pump crashed', sessionId, e);
      })
      .finally(() => {
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

    // --- Research journal accumulation ---------------------------------
    // Ported from legacy chat-service.logMessagesToHistory: record the
    // user turn + the assistant turn + a rag_query AI-operation so the
    // Journal panel keeps showing brainstorm/write exchanges after the
    // unified-chat cutover.
    const turnStartedAt = Date.now();
    let assistantText = '';
    let recordedSources: BrainstormSource[] = [];

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
    const freeMode = isFreeMode(args.systemPrompt);

    // Workspace hints — prepend before handing off to the engine so the
    // engine's retrieval-injected system message stacks on top cleanly.
    // Free-mode short-circuits hint injection to match legacy parity
    // (`chat-service.noSystemPrompt`): the caller wants a truly unprompted
    // conversation.
    if (projectPath && !freeMode) {
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
          async search(lastUser, options?: ChatEngineRetrievalOptions) {
            // Translate the engine-level sourceType (which allows 'vault')
            // into RetrievalService's narrower primary|secondary|both plus
            // an explicit `includeVault` flag. Brainstorm default keeps
            // primary + secondary + vault (matches the prior behaviour).
            const st = options?.sourceType;
            // `retrieval-service` now natively understands 'vault' as
            // "Obsidian only" (primary+secondary skipped). For the three
            // mixed cases we forward `includeVault` verbatim; when the
            // caller omits the flag we default to vault-on for Brainstorm
            // parity with prior behaviour.
            const rsSourceType: 'primary' | 'secondary' | 'both' | 'vault' =
              st === 'vault' || st === 'primary' || st === 'secondary' || st === 'both'
                ? st
                : 'both';
            const includeVault =
              rsSourceType === 'vault'
                ? true
                : options?.includeVault !== undefined
                  ? options.includeVault
                  : true;
            const { hits, stats } = await retrievalService.searchWithStats({
              query: lastUser,
              sourceType: rsSourceType,
              includeVault,
              documentIds: options?.documentIds,
              collectionKeys: options?.collectionKeys,
              topK: options?.topK,
            });
            if (hits.length === 0) return null;
            return {
              systemPrompt: formatContextAsSystemPrompt(hits),
              sources: hitsToSources(hits),
              explanation: {
                search: stats.search,
                timing: stats.timing,
              },
            };
          },
        }
      : undefined;

    // --- System-prompt composition ----------------------------------------
    // Precedence (legacy parity):
    //   1. explicit customText (UI `useCustomSystemPrompt` + `customSystemPrompt`)
    //   2. resolved mode text (modeId → ResolvedMode.systemPrompt.fr by default)
    //   3. nothing — fall back to whatever the provider / registry defaults do
    // `.cliohints` were already prepended above and sit *below* the system
    // override inside the message list.
    let resolvedSystemText: string | undefined;
    let systemPromptConfig: ChatEngineSystemPromptConfig | undefined;
    if (freeMode) {
      // Free-mode: engine must NOT inject any system message. Leave
      // `systemPromptConfig` undefined so `runChatTurn` skips its
      // customText branch entirely.
      resolvedSystemText = undefined;
      systemPromptConfig = undefined;
    } else {
      resolvedSystemText = args.systemPrompt?.customText;
      if (!resolvedSystemText && args.systemPrompt?.modeId) {
        try {
          const mode = await modeService
            .getModeManager()
            .getMode(args.systemPrompt.modeId);
          // Default to the FR prompt — matches the `chat-service` default.
          // Renderer can pass `customText` if it wants a different locale.
          resolvedSystemText = mode?.systemPrompt?.fr || mode?.systemPrompt?.en;
        } catch (e) {
          console.warn('[fusion-chat] mode resolution failed:', e);
        }
      }
      systemPromptConfig =
        resolvedSystemText || args.systemPrompt?.modeId
          ? {
              customText: resolvedSystemText,
              modeId: args.systemPrompt?.modeId,
            }
          : undefined;
    }

    try {
      await runChatTurn<BrainstormSource>({
        provider: llm,
        messages,
        signal: controller.signal,
        opts: args.opts,
        tools,
        toolHandler,
        retriever,
        retrievalOptions: args.retrievalOptions,
        systemPrompt: systemPromptConfig,
        hooks: {
          onStatus: (status) => {
            safeSend('fusion:chat:status', { sessionId, status });
          },
          onChunk: (chunk) => {
            if (chunk.delta) assistantText += chunk.delta;
            sendChunk(chunk);
          },
          onDone: (chunk) => {
            if (chunk.delta) assistantText += chunk.delta;
            sendChunk(chunk);
          },
          onError: (err) =>
            sendChunk({ delta: '', done: true, finishReason: 'error' }, err),
          onSources: (sources) => {
            recordedSources = sources as BrainstormSource[];
            safeSend('fusion:chat:context', { sessionId, sources });
          },
          onExplanation: (explanation: RAGExplanation) => {
            safeSend('fusion:chat:explanation', { sessionId, explanation });
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
      this.recordJournalEntry({
        userMessage: args.messages[args.messages.length - 1],
        assistantText,
        sources: recordedSources,
        durationMs: Date.now() - turnStartedAt,
        modeId: args.systemPrompt?.modeId,
        providerName: llm?.name ?? 'unknown',
        retrievalOptions: args.retrievalOptions,
      });
    }
  }

  /**
   * Ported from legacy chat-service.logMessagesToHistory (step 5 deletion).
   * Fail-soft: the chat round-trip must not crash because the journal
   * manager is unavailable or the project was closed mid-turn.
   */
  private recordJournalEntry(entry: {
    userMessage: ChatMessage | undefined;
    assistantText: string;
    sources: BrainstormSource[];
    durationMs: number;
    modeId?: string;
    providerName: string;
    retrievalOptions?: ChatEngineRetrievalOptions;
  }): void {
    try {
      const hm = historyService.getHistoryManager();
      if (!hm) return;
      const userText =
        typeof entry.userMessage?.content === 'string'
          ? entry.userMessage.content
          : '';
      if (!userText && !entry.assistantText) return;

      const queryParams = {
        model: entry.providerName,
        topK: entry.retrievalOptions?.topK,
        sourceType: entry.retrievalOptions?.sourceType,
        includeVault: entry.retrievalOptions?.includeVault,
        documentIds: entry.retrievalOptions?.documentIds,
        collectionKeys: entry.retrievalOptions?.collectionKeys,
        modeId: entry.modeId ?? 'default-assistant',
      };

      const serialisedSources =
        entry.sources.length > 0
          ? entry.sources.map((s) => ({
              documentId: s.documentId ?? s.itemId ?? s.notePath ?? '',
              documentTitle: s.title,
              pageNumber: s.pageNumber,
              similarity: s.similarity,
              sourceType: s.sourceType,
            }))
          : undefined;

      if (userText) {
        hm.logChatMessage({
          role: 'user',
          content: userText,
          queryParams,
        });
      }
      if (entry.assistantText) {
        hm.logChatMessage({
          role: 'assistant',
          content: entry.assistantText,
          sources: serialisedSources,
          queryParams,
        });
      }

      if (entry.sources.length > 0 && entry.assistantText) {
        hm.logAIOperation({
          operationType: 'rag_query',
          durationMs: entry.durationMs,
          inputText: userText,
          inputMetadata: {
            topK: entry.retrievalOptions?.topK,
            sourceType: entry.retrievalOptions?.sourceType,
            sourcesFound: entry.sources.length,
          },
          modelName: entry.providerName,
          modelParameters: { provider: entry.providerName },
          outputText: entry.assistantText,
          outputMetadata: {
            sources: serialisedSources ?? [],
            responseLength: entry.assistantText.length,
          },
          success: true,
        });
      }
    } catch (e) {
      console.warn('[fusion-chat] journal logging failed (non-fatal)', e);
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
