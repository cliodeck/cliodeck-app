# ADR 0004 — Cross-provider tool-use abstraction

Status: accepted — 2026-04-14
Context: fusion phase — tool-use support across Anthropic, OpenAI, Mistral, Gemini

## Context

Four LLM backends that ClioDeck supports emit tool calls in entirely different protocols:

- **Anthropic** — `tool_use` content blocks interleaved with text blocks in the assistant message.
- **OpenAI / Mistral** — a parallel `tool_calls` array on the assistant message, with `arguments` as a JSON string.
- **Gemini** — `functionCall` parts inside `contents`, with `args` as a parsed object and *no* call id field.

The fusion-chat-service agent loop (ADR 0003) needs to round-trip tool calls through the message history: the assistant turn that emitted a tool call must be reconstructible on the next request so the model sees its own prior call. A provider-leaky `ChatMessage` would push the switch-on-provider logic into the agent loop, which is exactly what we wanted to avoid.

## Decision

Extend `ChatMessage` with an optional `toolCalls?: Array<{id: string, name: string, arguments: string}>` on assistant turns. `arguments` is a JSON string in the cross-provider type. Each provider maps this cross-provider shape to its own protocol at three points:

1. **Request body `tools` field** — declarations of available tools.
2. **Assistant message history serialization** — how a prior `toolCalls` array is re-encoded into the provider's expected shape when sent back.
3. **Stream parser** — converting incoming deltas into `ChatChunk.toolCall` events with the cross-provider shape.

The agent loop in `fusion-chat-service` stays provider-agnostic: it receives `toolCall` events, calls `mcpClientsService.callTool`, appends a tool message, and iterates. Adding a new tool-use-capable provider means implementing those three mapping points — no change to the loop.

## Consequences

- The agent loop has one shape to handle, not four.
- Provider implementations are isolated: a breaking change in OpenAI's tool protocol touches one file.
- Tool-call history is faithful across turns: the assistant message persisted in the conversation store has enough information to reconstruct any provider's request body.

### Trade-offs (honest)

- **Gemini call ids are synthetic.** Gemini doesn't issue ids for `functionCall` parts. The provider generates `gemini-fc-N` per stream and maintains an id→name map to route the tool response back into the matching `functionResponse` part. If a stream restarts, the counter restarts — ids are not globally unique, only unique within a single assistant turn. That is enough for the round-trip but would break any persistence layer that assumed global uniqueness.
- **"String everywhere" for `arguments`** matches Anthropic and OpenAI/Mistral but is lossy for Gemini, which natively passes an object. We serialize on ingest and parse on egress — two JSON hops per Gemini call. Cost is negligible but it is a real double-translation, and a malformed argument from Gemini would surface as a parse error on the wrong side of the boundary.
- ~~**Ollama still has `tools: false`.**~~ **Amended 2026-07-25** — see the note below.
- **Three mapping points per provider is the real cost** — new providers are not "just plug in." A half-implemented provider (e.g. request tools wired but history serialization missed) fails only on the second turn of an agent loop, which is a bad failure mode because it looks like a model error.

## Amendment — Ollama tool-use is per-model (2026-07-25)

The trade-off above anticipated a separate ADR for Ollama. What shipped instead
is narrower than an ADR-sized decision, and is recorded here rather than as
ADR 0008.

`capabilities.tools` is no longer a per-provider constant for Ollama: it is
**derived from the configured model name** against a whitelist
(`OLLAMA_TOOL_CAPABLE_PATTERNS` in `backend/core/llm/providers/ollama.ts` —
`ministral-3:8b/14b`, `qwen3:8b/14b/32b`, `mistral-nemo`). The same class
instantiated with `qwen3:8b` advertises `tools: true` while one instantiated
with `llama3.2` advertises `tools: false`. The Llama 3.x and 4.x families are
deliberately excluded. Source-cited rationale:
[`docs/archive/research-ollama-tools-1.8.md`](../archive/research-ollama-tools-1.8.md).

Consequences for this ADR's shape: none. Ollama maps the same three points as
the other four providers. What is new is that `capabilities` became a function
of configuration rather than of provider identity — a caller must not cache a
provider's `tools` capability across a model change. The four cloud providers
still advertise tool-use unconditionally.

## References

- `2b6ec3c` — Anthropic tool-use (reference implementation; `tool_use` blocks).
- `c8ea120` — OpenAI and Mistral tool-use (`tool_calls` array, JSON-string arguments).
- `8ac4743` — Gemini tool-use (synthetic ids, object→string argument conversion).
- `backend/core/llm/providers/base.ts` — cross-provider `ChatMessage.toolCalls` type definition.
- ADR 0003 — MCP integration model (the consumer of the `toolCall` event shape).
