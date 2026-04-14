# Changelog

All notable changes to ClioDeck will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] — Unreleased (fusion branch `feat/fusion-cliobrain`)

Absorbs [ClioBrain](https://github.com/inactinique/cliobrain) into
ClioDeck as the **Brainstorm** mode. One app now covers the whole
historian cycle — *Explorer → Brainstormer → Écrire → Exporter* — on a
shared workspace, sources, and index.

See [`docs/fusion-cliobrain-strategy.md`](docs/fusion-cliobrain-strategy.md)
and [`docs/fusion-cliobrain-implementation-plan.md`](docs/fusion-cliobrain-implementation-plan.md)
for the full rationale and step-by-step plan. Commit messages in the
fusion branch reference the step numbers defined there.

### Added

#### Workspace v2 (additive)
- `.cliodeck/v2/` directory alongside the existing `.cliodeck/*` layout
  — both coexist during transition so pre- and post-fusion apps open the
  same workspace without data loss.
- `config.json` with `schema_version: 2`, `hints.md`, `mcp-access.jsonl`,
  `security-events.jsonl`, `recipes/`, `recipes-runs/`,
  `obsidian-vectors.db`.
- Migrators: `migrateFromCliodeckV1` and `migrateFromCliobrain` return a
  typed `MigrationReport` (partial-success first-class per the claw-code
  engineering guidelines).

#### Typed LLM provider layer
- `LLMProvider` / `EmbeddingProvider` interfaces with a typed
  `ProviderState` state machine (never a boolean `connected`).
- Four providers: Ollama, OpenAI-compatible (llama.cpp, LM Studio, vLLM,
  OpenAI native), Anthropic, Mistral.
- `ProviderRegistry` with open factory map; new providers plug in via
  `registerLLMProvider` without touching call sites.
- Mock-replay parity harness (`npm run test:provider-parity`) comparing
  every provider's normalised output on a shared fixture set.
- Legacy bridges: `createRegistryFromLegacyConfig` (cliobrain
  `LLMProviderConfig`) and `createRegistryFromClioDeckConfig` (cliodeck
  user-level `LLMConfig`).
- Every existing LLM call site (`DocumentSummarizer`, `NERService`,
  `TropySync`, `SimilarityService`, `SlidesGenerationService`,
  `ChatService`, `PDFService`) now has an additive setter to route
  through the registry while preserving the legacy path.

#### Brainstorm mode
- Four-mode top-level navigation (Brainstorm / Write / Analyze /
  Export), persisted across sessions, defaulting to Write on first
  launch so existing UX is unchanged.
- Streamed chat composer — Cmd/Ctrl+Enter to send, animated streaming
  cursor, cancel button, reset — built on the typed provider
  registry with automatic `.cliohints` injection.
- **Send to Write** on each completed assistant turn — formats the
  message as a Markdown draft block (wrapped in HTML-comment
  markers for later scripted extraction) and appends to the editor,
  preserving RAG citations as `**Sources**` lists.
- Workspace scaffold panel showing hints, Obsidian vault status, and
  recipe list from the new IPC bridge.

#### Knowledge management
- **Obsidian vault integration** — `ObsidianVaultReader`,
  `ObsidianMarkdownParser`, `ObsidianVaultExporter` ported; new
  `ObsidianVaultIndexer` + `ObsidianVaultStore` run a parallel
  SQLite+FTS5 index at `.cliodeck/v2/obsidian-vectors.db` with hybrid
  search (brute-force cosine + FTS5 BM25, RRF K=60).
- **Knowledge graph** — Graphology-based community detection ported,
  `GraphData` / `GraphNode` / `GraphEdge` types unified with existing
  NER types.
- **NER consolidated** — kept the richer ClioDeck impl (chunking,
  deduplication, query-specific extraction, multi-format JSON
  parsing) and added ClioBrain's multilingual prompts (fr / en / de)
  + `CONCEPT` entity type.

#### Platform features
- **`.cliohints`** — durable workspace context (`hints.md`) injected
  into every prompt via `prependAsSystemMessage` /
  `prependAsPrompt`. Never leaked to external MCP tools unless the
  user opts in per-tool.
- **Context compaction** — threshold-based middle-of-conversation
  summarisation that keeps system turns + N most recent turns intact
  and preserves RAG citation messages verbatim.
- **ClioRecipes v1** — YAML workflows with zod-validated schema, a
  runner producing JSONL event logs (events over scraped prose), four
  builtin recipes (Zotero review, Tropy analysis, chapter brainstorm,
  Chicago export).
- **MCP server (outbound)** — `backend/mcp-server/` exposes the
  Obsidian vault over stdio to Claude Desktop / Cursor. Inactive by
  default — refuses to start unless `mcpServer.enabled: true` in the
  workspace config. Typed `MCPAccessEvent` JSONL audit log.
- **MCP clients (inbound)** — `MCPClientManager` consumes external
  MCP servers with typed lifecycle state machine, one-shot silent
  recovery on subprocess crash, partial-success reporting
  (`listReady()`).
- **SourceInspector** — scans RAG chunks for prompt-injection
  patterns before they reach the prompt. `warn` / `block` modes,
  typed `SecurityEvent` JSONL log. Threat model is explicit:
  defends against malicious *sources*, not a compromised local LLM.

#### Headless CLI
- `cliodeck recipe list [--workspace]`
- `cliodeck recipe run <name> --workspace <path> [--input k=v …]`
- `cliodeck search "query" --workspace <path> [--topK 10]`
- `cliodeck hints show|set --workspace <path>`
- `cliodeck import-cliobrain <workspace> [--overwrite] [--name <label>]`
- Unix-convention exit codes (0 / 1 / 2).

#### RAG preparation (2.4a gate)
- `SourceDocument` / `SourceChunk` additive generalisation of
  `PDFDocument` / `DocumentChunk` with conversion helpers.
- `backend/core/rag/benchmark.ts` — pipeline-agnostic benchmark
  harness (recall@K, MRR, latency percentiles, before/after diff).
  Gates the future vector-store unification swap per ADR 0001.

#### UI + integration polish (post-initial-fusion work)
- **Unified chat UI** — shared `ChatSurface` component drives both the
  legacy RAG chat and the Brainstorm chat. Same message bubble,
  composer, and send-key (Cmd/Ctrl+Enter) in both modes.
- **Brainstorm wired to RAG** — extracted `RetrievalService` from
  `pdf-service`. Brainstorm chat now hits the full hybrid pipeline
  (HNSW + BM25 over PDFs, Tropy primaries, optionally Obsidian vault)
  and streams retrieval hits to the renderer for display as source
  cards below each assistant turn.
- **Settings additions** — editor for `.cliohints`, read-only recipes
  browser with a "Run" button, Obsidian vault config (pick / index /
  re-index / unlink with progress), opt-in toggle to include the
  vault in the legacy chat too.
- **More LLM backends** — UI selector + adapter routing for Anthropic
  Claude, OpenAI, Mistral, and Google Gemini (new `GeminiProvider` +
  `GeminiEmbeddingProvider` with dedicated contract tests). API keys
  flow through the existing secureStorage keyring.
- **Cloud embeddings** — `useCloudEmbeddings` flag routes embeddings
  to the same cloud provider (Gemini / OpenAI / Mistral) instead of
  Ollama, for users without a local Ollama.
- **Recipe execution** — `fusion:recipes:run` IPC streams `RunEvent`
  payloads; settings modal renders inputs form, live event log,
  outputs panel. Real step handlers wired: search →
  `retrievalService`, graph → `KnowledgeGraphBuilder`, export →
  `pdfExportService` (Pandoc). Brainstorm/write steps use the LLM
  via the provider registry.
- **Theme alignment** — new fusion UIs (BrainstormPanel, ChatSurface,
  WorkspaceModeBar) now use the real dark-theme tokens (`--bg-app`,
  `--text-primary`, `--color-accent`, `--color-danger`) instead of
  hardcoded light fallbacks.

### Developer experience

- 250+ new tests covering every module introduced by the fusion, with
  fake factories / in-memory stores so live backends are optional.
- `pre-fusion-v1` git tag marks the state before the absorption began.
- Commit messages reference step numbers from the implementation plan,
  keeping the narrative traceable.

### Known limitations of v2.0

- Full `PDFDocument` → `SourceDocument` rename across the vector-store
  surface (Path A of ADR 0001) is gated on a gold-standard benchmark
  run; the type scaffold and harness ship now, the swap ships when
  the benchmark confirms no quality regression.
- MCP server ships one tool (`search_obsidian`); Zotero / Tropy /
  graph / entity-context tools arrive in follow-up commits.
- MCP clients: the `WorkspaceConfig.mcpClients` schema is in place but
  no runtime lifecycle (spawning, tool exposure to the LLM, settings
  UI) yet — tracked as a follow-up milestone.
- Recipe `export` step reads the project's `document.md` only; the
  `document_id` input is accepted but ignored until multi-document
  projects land.

## [1.0.0-beta.2] - 2025-01-20

### Added

#### Zotero Integration
- **Bidirectional sync** with Zotero library - detect additions, modifications, and deletions
- **Three conflict resolution strategies**: Remote Wins, Local Wins, Manual selection
- **Zotero groups support** for shared libraries
- **Collections filtering** for targeted RAG queries
- **Batch PDF download** from Zotero attachments

#### Bibliography Management
- **Bibliography statistics dashboard** with 4 interactive tabs (Overview, Authors, Publications, Timeline)
- **Tags and metadata system** with custom fields support
- **BibTeX export** with full metadata preservation
- **Orphan PDF detection and cleanup** with archive option (safe) or delete (permanent)
- **Modified PDF detection** with MD5 hash comparison and re-indexation prompts

#### Editor
- **Milkdown WYSIWYG editor** replaces Monaco Editor for better markdown editing experience
- **Toggle between WYSIWYG and raw markdown** modes
- **Improved footnote styling** in both dark and light themes

#### Vector Store & RAG
- **Enhanced vector store** with improved chunking strategies
- **Zotero collections integration** for refined RAG queries
- **Embedding strategy selector** (nomic-fallback, mxbai-only, custom)

#### UI/UX
- **Project opening progress indicator**
- **Unified bibliography panel** (removed separate PDFs tab - all PDF management through Zotero workflow)
- **Improved light theme** CSS fixes

### Changed

- **Renamed ClioDesk to ClioDeck** throughout the project
- **Relative paths** in project.json files for better portability
- **Updated AI models** configuration
- **Improved translations** for French, English, and German

### Fixed

- Multiple Zotero collections synchronization bugs
- Milkdown light theme rendering issues
- Document re-indexation for already indexed files
- CSS issues in light mode
- BERTopic installation process
- Various bibliography management bugs

## [1.0.0-beta.1] - 2024-12-XX

### Added

- Initial beta release
- RAG-powered research assistant
- Zotero integration (import)
- PDF indexing and semantic search
- Ollama and Claude LLM support
- Embedded Qwen model option
- Project management (Article, Book, Presentation)
- PDF and Word export
- Dark/Light theme support
- French, English, German localization
