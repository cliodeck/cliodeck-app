# ADR 0003 — MCP integration model

Status: accepted — 2026-04-14
Context: fusion phase — MCP client lifecycle + agent loop in Brainstorm chat

## Context

The workspace needs to consume external MCP servers (Slack, GitHub, custom scientific tools) without coupling the chat layer to subprocess management. A `MCPClientManager` scaffold existed from a pre-fusion commit but had no real SDK factory, no lifecycle beyond `connect()` / `disconnect()`, and no path from a tool call emitted by the LLM back to an MCP server invocation.

Two things had to be decided together: where MCP client lifecycle lives, and how tool calls traverse the chat stream.

## Decision

**Clients.** MCP clients live in a typed `MCPClientManager` with an injected SDK factory (so tests can swap in fakes). The manager owns connect/disconnect/retry and exposes `listTools()` per client. A `mcp-clients-service` singleton wraps the manager for Electron IPC and persists configs to `WorkspaceConfig.mcpClients`.

**Tools to LLM.** Tools from ready clients are namespaced `clientName__toolName` and exposed per-conversation via `ChatOptions.tools`. The namespacing is what prevents collisions when two servers both ship a `search` tool. **Amended 2026-11-17** — the name the model sees is no longer always `clientName__toolName`; see the amendment below.

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

## Amendement du 2026-11-17 — Le nom envoyé au modèle n'est plus forcément `clientName__toolName` (L07-6, S09-1-23)

### Constat

Le nom d'un serveur MCP est un texte libre (« Gallica BnF », « Archives départementales »), et le spec MCP admet le point dans un nom d'outil (`toolNameValidation.js` du SDK, SEP-986 : `[A-Za-z0-9._-]{1,128}`). Envoyé tel quel, `clientName__toolName` faisait refuser toute la requête par OpenAI, Anthropic, Mistral et Gemini (HTTP 400), à chaque tour où un outil de ce serveur était coché, même pour une question sans rapport avec lui.

### Décision

- **Le nom brut reste l'identité de l'outil.** `clientName__toolName` est ce que coche le bandeau des outils du chat (`useMcpToolsList`, `mcpToolsStore`, `enabledTools`) : le filtre se compare toujours à lui.
- **Le modèle voit le nom envoyé**, `buildWireToolName(clientName, toolName, taken)` (`backend/integrations/mcp-clients/tool-names.ts`).
  - Un nom brut qui passe `/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/` part tel quel. Cette règle est l'intersection de celles des fournisseurs : `[a-zA-Z0-9_-]{1,64}` pour OpenAI, Anthropic et Mistral, une lettre ou `_` en tête pour Gemini.
  - Sinon, chaque moitié est assainie (diacritiques retirés, tout autre caractère hors de `[A-Za-z0-9_-]` changé en `_`) et le nom reçoit un suffixe tiré du SHA-256 du nom brut, le tout en 64 caractères au plus. Un compteur sert de dernier recours.
  - Une seule règle pour tous les fournisseurs, Ollama et le modèle embarqué compris.
- **L'aller-retour ne découpe plus le nom.** `fusion-chat-service` garde une table `toolScope` (nom envoyé → `{ client, bare }`) : l'appel part en `mcpClientsService.callTool(client, bare, args)`, avec le nom réel de l'outil.
- **Ce qui garde les noms réels.**
  - La description envoyée au modèle commence par `[clientName]` en clair.
  - L'appel au serveur, la puce d'outil (`fusion:chat:tool-call`) et `mcp-access.jsonl` portent le serveur et l'outil réels.
  - Les événements de sécurité (`security-events.jsonl`) portent le nom brut `clientName__toolName`, celui que l'historien reconnaît.
- **Aucun nom n'est refusé à l'ajout d'un serveur**, et `config.json` n'est pas réécrit : les configurations existantes continuent de marcher sans renommage.

### Conséquences

- Le préfixe du serveur sépare toujours deux outils `search` de deux serveurs ; le suffixe sépare en plus deux noms bruts qui s'assainissent pareil (« a b » et « a.b ») ou qui ne diffèrent qu'au-delà du 64ᵉ caractère.
- Ne jamais retrouver le serveur ou l'outil en découpant le nom envoyé : un nom assaini n'a plus la longueur du nom brut. Passer par `toolScope`.
- Le nom envoyé ne vit que le temps d'un tour. L'historique que le renderer renvoie au tour suivant ne porte que du texte : aucun nom d'outil ne passe d'un tour à l'autre.
- La règle des fournisseurs vient de leur documentation publique, relevée par l'audit. Ni leur code dans ClioDeck (des appels `fetch` sans SDK) ni leurs tests ne la portent : elle n'y a pas été vérifiée.

## References

- `12c2ee4` — client lifecycle + Settings UI for MCP clients.
- `2b6ec3c` — Anthropic tool-use path wired into the agent loop.
- `c8ea120` — OpenAI and Mistral tool-use.
- `8ac4743` — Gemini tool-use (with synthetic call ids; see ADR 0004).
- ADR 0004 — cross-provider tool-use abstraction (the shape the agent loop depends on).
