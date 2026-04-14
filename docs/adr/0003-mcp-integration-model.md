# ADR 0003 — MCP integration model

Status: accepted — 2026-04-14
Context: fusion phase — MCP client lifecycle + agent loop in Brainstorm chat

## Context

The workspace needs to consume external MCP servers (Slack, GitHub, custom scientific tools) without coupling the chat layer to subprocess management. A `MCPClientManager` scaffold existed from a pre-fusion commit but had no real SDK factory, no lifecycle beyond `connect()` / `disconnect()`, and no path from a tool call emitted by the LLM back to an MCP server invocation.

Two things had to be decided together: where MCP client lifecycle lives, and how tool calls traverse the chat stream.

## Decision

**Clients.** MCP clients live in a typed `MCPClientManager` with an injected SDK factory (so tests can swap in fakes). The manager owns connect/disconnect/retry and exposes `listTools()` per client. A `mcp-clients-service` singleton wraps the manager for Electron IPC and persists configs to `WorkspaceConfig.mcpClients`.

**Tools to LLM.** Tools from ready clients are namespaced `clientName__toolName` and exposed per-conversation via `ChatOptions.tools`. The namespacing is what prevents collisions when two servers both ship a `search` tool.

**Agent loop.** `fusion-chat-service` runs an agent loop with a hard cap of 6 turns. On each turn, `ChatChunk.toolCall` events are dispatched back to `mcpClientsService.callTool(clientName, toolName, args)`; the result is appended as a tool message and the loop iterates until the LLM emits a terminal assistant turn or the cap trips.

**Retry policy.** One silent retry on transport failure during a tool call. Beyond that, the error surfaces in the conversation as a tool-result error — the LLM decides whether to recover. This matches the project's "partial success first-class, infra-only auto-recovery" line.

## Consequences

- Chat surfaces do not know about subprocesses. They see tools, emit tool calls, receive tool results.
- Adding a new MCP server is a config entry plus a restart of that one client; no code change in the chat layer.
- MCP configs travel with the project (they sit in `WorkspaceConfig.mcpClients`, which is workspace v2).
- The 6-turn cap is visible: a user chaining many tool calls in one turn will hit it and see the loop terminate with a notice rather than a runaway.

### Trade-offs (honest)

- **Namespacing is a workaround, not a solution, for cross-server name collisions.** Two servers exposing semantically similar tools (`github__search_issues` vs `slack__search_messages`) still confuse the LLM when the user's intent is ambiguous; the model sometimes picks the wrong one. There is no good fix at this layer — the description strings are what the model actually reads.
- **Max 6 turns is hardcoded.** It is a safety rail against runaway loops, not a tuned number. Legitimate multi-step workflows can hit it. Raising it is a one-line change but we have no telemetry yet to pick a better value.
- **MCP configs live in workspace config, not user config.** A user with two projects must reconfigure MCP clients in each. This is intentional (a project is a reproducible unit; MCP endpoints are part of its environment), but it is friction for users who treat Claude as a personal assistant with stable tool access across projects. If that becomes the dominant use pattern, we migrate to a merged view.
- **Singleton manager** has the same multi-project caveat as `RetrievalService` (see ADR 0002).

## References

- `12c2ee4` — client lifecycle + Settings UI for MCP clients.
- `2b6ec3c` — Anthropic tool-use path wired into the agent loop.
- `c8ea120` — OpenAI and Mistral tool-use.
- `8ac4743` — Gemini tool-use (with synthetic call ids; see ADR 0004).
- ADR 0004 — cross-provider tool-use abstraction (the shape the agent loop depends on).
