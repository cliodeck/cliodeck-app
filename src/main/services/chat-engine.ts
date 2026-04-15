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

export interface ChatEngineHooks {
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
}

export interface ChatEngineRetriever<TSource> {
  /**
   * Search the corpus for context chunks relevant to the last user turn.
   * Return both a formatted system-prompt string to prepend and the raw
   * source objects to surface to the UI. Throw (or return empty) to skip.
   */
  search(lastUser: string): Promise<{
    systemPrompt: string;
    sources: TSource[];
  } | null>;
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
  const emitError = (code: string, message: string): void => {
    hooks.onError?.({ code, message });
    hooks.onDone?.({ delta: '', done: true, finishReason: 'error' });
  };

  // --- Retrieval injection -------------------------------------------------
  let messages = args.messages;
  if (args.retriever) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser?.content?.trim()) {
      try {
        const result = await args.retriever.search(lastUser.content);
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

  // --- Agent loop ----------------------------------------------------------
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      const pendingToolCalls: ChatEngineToolCall[] = [];
      let sawToolCall = false;
      let terminalDone = false;
      let lastDoneChunk: ChatChunk | null = null;

      for await (const chunk of args.provider.chat(messages, {
        model: args.opts?.model,
        temperature: args.opts?.temperature,
        maxTokens: args.opts?.maxTokens,
        tools: args.tools && args.tools.length ? args.tools : undefined,
        signal: args.signal,
      })) {
        if (chunk.toolCall) {
          pendingToolCalls.push(chunk.toolCall);
          sawToolCall = true;
        }
        // Suppress terminal done chunks while mid-loop so the caller only
        // sees one `done` at the very end.
        if (chunk.done && sawToolCall) {
          terminalDone = true;
          lastDoneChunk = chunk;
          break;
        }
        if (chunk.done) {
          terminalDone = true;
          lastDoneChunk = chunk;
          hooks.onDone?.(chunk);
          break;
        }
        hooks.onChunk?.(chunk);
      }

      if (!sawToolCall || pendingToolCalls.length === 0) {
        if (!terminalDone) {
          // Stream ended without a done chunk — synthesize one.
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
    hooks.onDone?.({ delta: '', done: true, finishReason: 'stop' });
  } catch (e) {
    emitError('stream_error', e instanceof Error ? e.message : String(e));
  }
}
