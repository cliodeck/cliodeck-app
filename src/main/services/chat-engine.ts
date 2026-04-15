/**
 * ChatEngine — transport-agnostic core for streamed LLM chat turns.
 *
 * Extracted from `fusion-chat-service.ts` during the fusion-cliobrain
 * consolidation so both the Brainstorm chat and (eventually) the legacy
 * `chat-service.ts` can share a single agent tool-use loop, retrieval
 * injection, and error envelope.
 *
 * Design notes:
 *  - No Electron / IPC dependency: the engine emits events via a `hooks`
 *    object and callers wire them to `webContents.send` (or whatever
 *    transport they use).
 *  - No provider registry ownership: the caller passes a ready-to-use
 *    `LLMProvider`. The engine does not dispose it.
 *  - Tool dispatch is delegated via `toolHandler` — the Brainstorm wiring
 *    routes to MCP, but legacy chat could plug its own resolver.
 *  - Retrieval is a single async hook returning chunks to prepend as a
 *    system message; leaving it undefined skips RAG entirely.
 *  - The agent loop is capped by `maxTurns` (default 6) to avoid runaway
 *    tool-use ping-pong.
 */

import type {
  ChatChunk,
  ChatMessage,
  LLMProvider,
  ToolDescriptor,
} from '../../../backend/core/llm/providers/base.js';
import type { RAGExplanation } from '../../../backend/types/chat-source.js';

/**
 * Partial `RAGExplanation` that a retriever may pre-populate. The engine
 * merges it with LLM / timing stats collected during the stream to build
 * the final explanation object.
 */
export interface PartialRAGExplanation {
  search?: RAGExplanation['search'];
  compression?: RAGExplanation['compression'];
  graph?: RAGExplanation['graph'];
  /** Timing fields the retriever already knows (search/compression). */
  timing?: Partial<RAGExplanation['timing']>;
}

export interface ChatEngineLLMStats {
  provider: string;
  model: string;
  contextWindow: number;
  temperature: number;
  promptSize: number;
  /** From provider-reported `usage` on the terminal chunk, when available. */
  tokensIn?: number;
  tokensOut?: number;
  durationMs: number;
}

export interface ChatEngineToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatEngineToolResult {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface ChatEngineToolEvent {
  callId: string;
  name: string;
  turn: number;
  index: number;
}

/**
 * Coarse-grained pipeline phases emitted via `onStatus`. Mirrors the legacy
 * `chat:status` banner stages so the Write-side renderer keeps receiving the
 * same user-visible signal after the fusion swap:
 *  - `retrieving`   — retriever started.
 *  - `compressing`  — compaction/compression step active (reserved).
 *  - `generating`   — first LLM frame observed.
 *  - `done`         — terminal chunk emitted (also covered by `onDone`).
 */
export interface ChatEngineStatusEvent {
  phase: 'retrieving' | 'compressing' | 'generating' | 'done';
  /** Optional human-readable label (legacy-parity UI banner text). */
  label?: string;
}

export interface ChatEngineHooks {
  /** Pipeline-phase transitions for status banners. */
  onStatus?(status: ChatEngineStatusEvent): void;
  /** A non-terminal streaming chunk (delta or tool-call notification). */
  onChunk?(chunk: ChatChunk): void;
  /** Terminal chunk — emitted exactly once per turn, at the very end. */
  onDone?(chunk: ChatChunk): void;
  /** Fatal error. After this, no further hooks fire. */
  onError?(err: { code: string; message: string }): void;
  /** Called before a tool is invoked. */
  onToolCallStart?(ev: ChatEngineToolEvent & { startedAt: number }): void;
  /** Called after a tool invocation resolves (success or failure). */
  onToolCallEnd?(
    ev: ChatEngineToolEvent & {
      durationMs: number;
      ok: boolean;
      errorMessage?: string;
    }
  ): void;
  /** Called once with the retrieval hits, if a retriever ran. */
  onSources?<T>(sources: T[]): void;
  /** Retrieval stats (search/compression/graph), if the retriever produced them. */
  onSearchStats?(stats: PartialRAGExplanation): void;
  /** Alias for `onSearchStats` scoped to the compression slice, when convenient. */
  onCompressionStats?(stats: NonNullable<RAGExplanation['compression']>): void;
  /** LLM-side stats once the terminal chunk is seen. */
  onLLMStats?(stats: ChatEngineLLMStats): void;
  /** Final explainable-AI payload, emitted just before the terminal `onDone`. */
  onExplanation?(explanation: RAGExplanation): void;
}

export interface ChatEngineRetrieverResult<TSource> {
  systemPrompt: string;
  sources: TSource[];
  /**
   * Optional partial explainable-AI payload. When present, the engine
   * augments it with LLM/timing stats and forwards via `onExplanation`.
   */
  explanation?: PartialRAGExplanation;
}

/**
 * Opaque retrieval-filter bag forwarded from caller to retriever. The
 * engine never inspects these fields — it simply threads them through so
 * legacy RAG filters (documentIds, collectionKeys, sourceType, topK) can
 * reach `RetrievalService` without leaking that contract into the engine.
 */
export interface ChatEngineRetrievalOptions {
  documentIds?: string[];
  collectionKeys?: string[];
  sourceType?: 'primary' | 'secondary' | 'both' | 'vault';
  /** Opt-in to Obsidian vault alongside primary/secondary. Ignored when
   *  `sourceType === 'vault'` (vault-only). */
  includeVault?: boolean;
  topK?: number;
}

export interface ChatEngineRetriever<TSource> {
  /**
   * Search the corpus for context chunks relevant to the last user turn.
   * Return both a formatted system-prompt string to prepend and the raw
   * source objects to surface to the UI. Throw (or return empty) to skip.
   */
  search(
    lastUser: string,
    options?: ChatEngineRetrievalOptions
  ): Promise<ChatEngineRetrieverResult<TSource> | null>;
}

/**
 * System-prompt composition directives passed through `RunChatTurnArgs`.
 * When `customText` is provided, the engine prepends it as a leading
 * `system` message (before any retrieval-injected system block). `modeId`
 * is advisory metadata — the engine itself does not resolve it; callers
 * resolve mode → text in their own wiring layer and pass the resolved
 * string via `customText`. Keeping the field here lets tests assert the
 * wiring without coupling the engine to `modeService`.
 */
export interface ChatEngineSystemPromptConfig {
  customText?: string;
  modeId?: string;
}

export interface ChatEngineToolHandler {
  /** Resolve a tool call. Tool names are as advertised in `tools`. */
  call(name: string, args: Record<string, unknown>): Promise<ChatEngineToolResult>;
}

export interface RunChatTurnArgs<TSource = unknown> {
  provider: LLMProvider;
  messages: ChatMessage[];
  signal?: AbortSignal;
  opts?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
  };
  tools?: ToolDescriptor[];
  toolHandler?: ChatEngineToolHandler;
  retriever?: ChatEngineRetriever<TSource>;
  /** Forwarded verbatim to the retriever (filters: documentIds, etc.). */
  retrievalOptions?: ChatEngineRetrievalOptions;
  /** Optional system-prompt override (mode text / custom prompt). */
  systemPrompt?: ChatEngineSystemPromptConfig;
  hooks?: ChatEngineHooks;
  /** Max agent-loop iterations (default 6). */
  maxTurns?: number;
}

/**
 * Run one logical chat turn, possibly iterating the provider several
 * times to satisfy tool-use calls. Resolves when a terminal chunk has
 * been emitted (either via `onDone` or `onError`).
 */
export async function runChatTurn<TSource = unknown>(
  args: RunChatTurnArgs<TSource>
): Promise<void> {
  const hooks = args.hooks ?? {};
  const maxTurns = args.maxTurns ?? 6;
  const startedAt = Date.now();
  let retrievalExplanation: PartialRAGExplanation | undefined;
  let promptSize = 0;
  let generationStart = 0;
  let generationMs = 0;
  let lastUsage: ChatChunk['usage'] | undefined;
  const emitError = (code: string, message: string): void => {
    hooks.onError?.({ code, message });
    hooks.onDone?.({ delta: '', done: true, finishReason: 'error' });
  };

  // --- System-prompt override ---------------------------------------------
  // When the caller provides a `customText`, inject it as the FIRST system
  // message so it sits above any retrieval-injected system block and any
  // `.cliohints` system message the service may have already prepended.
  let messages = args.messages;
  const customText = args.systemPrompt?.customText;
  if (customText && customText.trim().length > 0) {
    messages = [{ role: 'system', content: customText }, ...messages];
  }

  const safeStatus = (status: ChatEngineStatusEvent): void => {
    try {
      hooks.onStatus?.(status);
    } catch {
      // UI hook failure must not abort the stream.
    }
  };

  // --- Retrieval injection -------------------------------------------------
  if (args.retriever) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser?.content?.trim()) {
      safeStatus({ phase: 'retrieving' });
      try {
        const result = await args.retriever.search(
          lastUser.content,
          args.retrievalOptions
        );
        if (result && result.sources.length > 0) {
          messages = [
            { role: 'system', content: result.systemPrompt },
            ...messages,
          ];
          try {
            hooks.onSources?.(result.sources);
          } catch {
            // UI hook failure must not abort the stream.
          }
          if (result.explanation) {
            retrievalExplanation = result.explanation;
            try {
              hooks.onSearchStats?.(result.explanation);
              if (result.explanation.compression) {
                safeStatus({ phase: 'compressing' });
                hooks.onCompressionStats?.(result.explanation.compression);
              }
            } catch {
              // UI hook failure must not abort the stream.
            }
          }
        }
      } catch (e) {
        // Fail soft — proceed without context.
        console.warn(
          '[chat-engine] retrieval skipped:',
          e instanceof Error ? e.message : e
        );
      }
    }
  }

  // Compute an approximation of the prompt byte-size after retrieval
  // injection. Used as the `promptSize` field of the explanation payload.
  for (const m of messages) {
    if (typeof m.content === 'string') promptSize += m.content.length;
  }

  const emitExplanation = (): void => {
    if (!hooks.onExplanation) return;
    if (!retrievalExplanation || !retrievalExplanation.search) return;
    const totalMs = Date.now() - startedAt;
    const llmStats: ChatEngineLLMStats = {
      provider: args.provider.id,
      model: args.opts?.model ?? args.provider.name,
      contextWindow: 0,
      temperature: args.opts?.temperature ?? 0,
      promptSize,
      tokensIn: lastUsage?.promptTokens,
      tokensOut: lastUsage?.completionTokens,
      durationMs: generationMs,
    };
    try {
      hooks.onLLMStats?.(llmStats);
    } catch {
      // UI hook failure must not abort the stream.
    }
    const explanation: RAGExplanation = {
      search: retrievalExplanation.search,
      compression: retrievalExplanation.compression,
      graph: retrievalExplanation.graph,
      llm: {
        provider: llmStats.provider,
        model: llmStats.model,
        contextWindow: llmStats.contextWindow,
        temperature: llmStats.temperature,
        promptSize: llmStats.promptSize,
      },
      timing: {
        searchMs: retrievalExplanation.timing?.searchMs ?? 0,
        compressionMs: retrievalExplanation.timing?.compressionMs,
        generationMs,
        totalMs,
      },
    };
    try {
      hooks.onExplanation(explanation);
    } catch {
      // UI hook failure must not abort the stream.
    }
  };

  // --- Agent loop ----------------------------------------------------------
  try {
    generationStart = Date.now();
    let firstFrameSeen = false;
    // [DEBUG fusion-chat empty-response] summarise the exact payload headed
    // to the provider so we can tell apart "never called provider" from
    // "provider returned 0 chunks".
    console.log('[chat-engine] provider.chat →', {
      provider: args.provider.id,
      model: args.opts?.model ?? args.provider.name,
      messageCount: messages.length,
      toolCount: args.tools?.length ?? 0,
      maxTurns,
    });
    for (let turn = 0; turn < maxTurns; turn++) {
      const pendingToolCalls: ChatEngineToolCall[] = [];
      let sawToolCall = false;
      let terminalDone = false;
      let lastDoneChunk: ChatChunk | null = null;

      let chunkCount = 0;
      for await (const chunk of args.provider.chat(messages, {
        model: args.opts?.model,
        temperature: args.opts?.temperature,
        maxTokens: args.opts?.maxTokens,
        tools: args.tools && args.tools.length ? args.tools : undefined,
        signal: args.signal,
      })) {
        chunkCount++;
        if (chunk.toolCall) {
          pendingToolCalls.push(chunk.toolCall);
          sawToolCall = true;
        }
        // Suppress terminal done chunks while mid-loop so the caller only
        // sees one `done` at the very end.
        if (chunk.done && sawToolCall) {
          terminalDone = true;
          lastDoneChunk = chunk;
          if (chunk.usage) lastUsage = chunk.usage;
          break;
        }
        if (chunk.done) {
          terminalDone = true;
          lastDoneChunk = chunk;
          if (chunk.usage) lastUsage = chunk.usage;
          generationMs = Date.now() - generationStart;
          emitExplanation();
          safeStatus({ phase: 'done' });
          hooks.onDone?.(chunk);
          break;
        }
        if (!firstFrameSeen) {
          firstFrameSeen = true;
          safeStatus({ phase: 'generating' });
        }
        hooks.onChunk?.(chunk);
      }

      console.log('[chat-engine] turn complete', {
        turn,
        chunkCount,
        sawToolCall,
        pendingToolCalls: pendingToolCalls.length,
        terminalDone,
      });
      if (!sawToolCall || pendingToolCalls.length === 0) {
        if (!terminalDone) {
          // Stream ended without a done chunk — synthesize one.
          generationMs = Date.now() - generationStart;
          emitExplanation();
          safeStatus({ phase: 'done' });
          hooks.onDone?.({ delta: '', done: true, finishReason: 'stop' });
        }
        return;
      }

      if (!terminalDone) {
        emitError(
          'stream_incomplete',
          'LLM stream ended without a terminal chunk'
        );
        return;
      }

      if (!args.toolHandler) {
        emitError(
          'no_tool_handler',
          'Provider requested a tool call but no toolHandler was configured'
        );
        return;
      }

      // Record the assistant's tool-call message so the provider-specific
      // adapter can replay it on the next turn (Anthropic tool_use blocks,
      // OpenAI tool_calls array, Gemini functionCall parts, etc.).
      messages = [
        ...messages,
        {
          role: 'assistant',
          content: '',
          toolCalls: pendingToolCalls.map((c) => ({
            id: c.id,
            name: c.name,
            arguments: c.arguments,
          })),
        },
      ];

      for (let i = 0; i < pendingToolCalls.length; i++) {
        const call = pendingToolCalls[i];
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = call.arguments ? JSON.parse(call.arguments) : {};
        } catch {
          // malformed JSON — pass through empty args.
        }
        const callId = `${turn}-${i}`;
        const startedAt = Date.now();
        try {
          hooks.onToolCallStart?.({
            callId,
            name: call.name,
            turn,
            index: i,
            startedAt,
          });
        } catch {
          // UI hook failure — continue.
        }
        const res = await args.toolHandler.call(call.name, parsedArgs);
        try {
          hooks.onToolCallEnd?.({
            callId,
            name: call.name,
            turn,
            index: i,
            durationMs: Date.now() - startedAt,
            ok: res.ok,
            errorMessage: res.ok ? undefined : res.error?.message,
          });
        } catch {
          // UI hook failure — continue.
        }
        const body = res.ok
          ? JSON.stringify(res.result ?? {})
          : `Error: ${res.error?.message ?? 'unknown'}`;
        messages = [
          ...messages,
          { role: 'tool', toolCallId: call.id, content: body },
        ];
      }

      // Reference the suppressed done chunk so TS doesn't complain when
      // callers debug mid-loop state. No functional use today.
      void lastDoneChunk;
    }
    // Loop unwound without a natural terminal — emit a stop.
    generationMs = Date.now() - generationStart;
    emitExplanation();
    safeStatus({ phase: 'done' });
    hooks.onDone?.({ delta: '', done: true, finishReason: 'stop' });
  } catch (e) {
    emitError('stream_error', e instanceof Error ? e.message : String(e));
  }
}
