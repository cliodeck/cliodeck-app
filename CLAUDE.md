# CLAUDE.md — cliodeck-app cheat-sheet

> 5-minute orientation for a Claude Code session. Dense on purpose. Links over prose.

## 1. Orientation

ClioDeck is an Electron + React + TypeScript **desktop app for historians** covering the full research cycle: **explore → brainstorm → write → export**. Local-first, RAG-powered, with Zotero / Tropy / Obsidian integrations. Users: humanities researchers (history, DH). Work happens on per-feature branches off `main` (check `git status` for the current one — e.g. `feat/usage-journal` for the AI usage journal). The fusion cycle (branch `feat/fusion-cliobrain`, merged into `main` at `v1.0.0-rc.2`) **absorbed [ClioBrain](https://github.com/inactinique/cliobrain) into ClioDeck as the *Brainstorm* mode** so historians get one app instead of switching between a note-centric brainstormer and a writing assistant. See [`docs/archive/fusion-cliobrain-strategy.md`](docs/archive/fusion-cliobrain-strategy.md) and [`docs/archive/fusion-cliobrain-implementation-plan.md`](docs/archive/fusion-cliobrain-implementation-plan.md) — commit messages reference the step numbers defined there.

## 2. Architecture quick-tour

**Electron split:**
- `src/main/` — Node-side: IPC handlers, services, workspace & storage
- `src/preload/index.ts` — `contextBridge`, exposes `window.electron.*` to renderer
- `src/renderer/` — React + Vite + TS UI
- `backend/` — provider-agnostic libraries, importable from `src/main/`

**Key services** (`src/main/services/`):
- `pdf-service.ts` — vector store, indexing (~1084 lines, contains a **delegating facade for search**)
- `retrieval-service.ts` — multi-source RAG: **PDFs (secondary) + Tropy archives (primary) + optional Obsidian vault**
- `mcp-clients-service.ts` — lifecycle of external MCP servers (stdio + SSE)
- `fusion-chat-service.ts` — Brainstorm chat: retrieval injection + **agent loop for tool-use**
- `chat-engine.ts` — legacy RAG chat engine (still active)
- `usage-journal-service.ts` — AI usage journal sink (`.cliodeck/journal.db`, never logs prompts)
- `tropy-service.ts`, `history-service.ts`, `mode-service.ts`, `pdf-export.ts`, etc.

**Provider abstraction** — `backend/core/llm/providers/base.ts` defines `LLMProvider` and `EmbeddingProvider` with a **typed `ProviderState`** state machine (`unconfigured | spawning | handshaking | ready | degraded | failed | stopped`), never a boolean. `ChatMessageMeta.ragCitation` marks retrieval messages so the compactor keeps them verbatim.
- Implementations: `ollama`, `openai-compatible`, `anthropic`, `mistral`, `gemini`
- Registered in `backend/core/llm/providers/registry.ts` (open factory map)
- Legacy bridges: `createRegistryFromLegacyConfig`, `createRegistryFromClioDeckConfig`

**Workspace layout** — `<projectRoot>/.cliodeck/` (flat):
- `config.json` (`schema_version: 2`), `hints.md`, `recipes/`, `recipes-runs/`
- `obsidian-vectors.db`, `mcp-access.jsonl`, `security-events.jsonl`
- The pre-fusion SQLite stores (`vectors.db`, `primary-sources.db`, `history.db`) live alongside at the same flat level — consolidating them into `brain.db` is a Path A concern (ADR 0001).
- Legacy `.cliodeck/v2/*` (pre-flatten) and pre-fusion v1 layouts are auto-migrated to flat on project load via `migrateWorkspaceToFlat`.

**IPC** — handlers in `src/main/ipc/handlers/*-handlers.ts`, bindings in `src/preload/index.ts`, surfaced as `window.electron.*` in the renderer.

## 3. Conventions

- **Commit messages** — focus on *why* not *what*. End with:
  ```
  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
  ```
- **Never amend commits.** Never `git push --force`. Never `--no-verify`.
- **Prefer `Edit` over `Write`** for existing files.
- **Strict TypeScript** — no `any`. If truly unavoidable, `// @ts-expect-error <one-line reason>`.
- **CSS** — use theme tokens from `src/renderer/src/index.css`: `--bg-app`, `--bg-panel`, `--text-primary`, `--text-secondary`, `--text-tertiary`, `--border-color`, `--color-accent`, `--color-danger`. Never hardcode colors. For tinted states: `color-mix(in srgb, var(--color-X) N%, transparent)`.
- **Tests** — Vitest, env `'node'` (no jsdom / testing-library yet). Location: `**/__tests__/*.test.ts`.
- **Build** — `npm run build` (tsc + vite, ~1 min; tsc runs as part of build). Run app: `npm start`.
- **i18n** — keys in `public/locales/{fr,en}/common.json`.
- **Engineering style guides** referenced throughout the code:
  - **claw-code lessons 6.1–6.5** — typed state machines, events over prose, partial-success first-class, infra-only auto-recovery, terminal as transport.
  - **goose lessons** — provider trait abstraction, recipes YAML, `.cliohints`, MCP extensibility.

## 4. DO NOT touch without asking

- **`backend/core/workspace/layout.ts`** — owns the flat path map (`workspaceFiles`/`ensureWorkspaceDirectories`) and the `WorkspaceVersion` detection used by auto-migration. Changing keys or detection rules ripples through every service that opens `.cliodeck/*`.
- **HNSW index format** — bumping requires re-indexing every user's corpus.
- **Tropy / Zotero parsers** — non-obvious edge cases.
- **Provider contract `backend/core/llm/providers/base.ts`** — changes ripple through 5 providers + their tests.

## 5. Common how-to (one-liners)

- **Add an LLM provider** → new file in `backend/core/llm/providers/`, register in `registry.ts`, add an adapter case in `cliodeck-config-adapter.ts`, surface in `LLMConfigSection.tsx`, store API key via `secureStorage` (auto-handled by `setLLMConfig`).
- **Add a settings section** → new component in `src/renderer/src/components/Config/`, import + render in `ConfigPanel.tsx`.
- **Add an IPC handler** → register in a `*-handlers.ts` under `src/main/ipc/handlers/`, bind in `src/preload/index.ts`.
- **Add an MCP server tool** → file in `backend/mcp-server/tools/`, register in `backend/mcp-server/server.ts`. Pattern: see `searchObsidian.ts`.
- **Add a recipe step kind** → extend `StepKind` in `backend/recipes/schema.ts`, add a handler in `backend/recipes/runner.ts` (or override via `stepHandlers` option in `recipe-step-handlers.ts`).
- **Run a single test** → `npx vitest run path/to/file.test.ts`.
- **Run the app** → `npm start`.

## 6. Known issues (current branch state)

- **`npx vitest run` is green locally**: suites needing the better-sqlite3 native binding (compiled for Electron's ABI by the postinstall) are guarded by `describe.skipIf(!sqliteAvailable)` / per-test `it.skipIf` via `backend/__tests__/helpers/native-guards.ts` (which also provides `ollamaAvailable()`); they show as readable skips under vitest's node and run in CI or after `npm rebuild better-sqlite3`. The only genuinely failing tests are the 6 Brainstorm jsdom tests (missing `window.electron.config` mock).
- **No React component tests** — jsdom + `@testing-library/react` setup pending.
- **`feat/fusion-cliobrain`** was the fusion release branch — merged into `main` at the `v1.0.0-rc.2` tag; new work happens on per-feature branches off `main`.
- **Ollama provider exposes `capabilities.tools` per-model** via a whitelist (`ministral-3:8b/14b`, `qwen3:8b/14b/32b`, `mistral-nemo`); other models (notably the Llama 3.x and 4.x families) get `tools: false`. See `OLLAMA_TOOL_CAPABLE_PATTERNS` in `backend/core/llm/providers/ollama.ts` and `docs/archive/research-ollama-tools-1.8.md` for the source-cited rationale. The 4 cloud providers (OpenAI-compatible, Anthropic, Mistral, Gemini) advertise tool-use unconditionally.

## 7. Glossary

- **RAG** — Retrieval-Augmented Generation (corpus chunks injected into LLM prompts).
- **RetrievalService** — unified search across PDFs (secondary), Tropy archives (primary), Obsidian vault.
- **MCP** — Model Context Protocol (Anthropic spec; cliodeck is both a server and a client).
- **`.cliohints`** — workspace-level system-prompt context, persists across chats (`.cliodeck/hints.md`).
- **Recipe** — YAML-defined workflow chaining brainstorm / search / graph / write / export steps.
- **Vault** — an Obsidian markdown notes folder, indexed in `.cliodeck/obsidian-vectors.db`.
- **Primary source** — Tropy archive (archival photos, OCR'd documents).
- **Secondary source** — PDF in the bibliography (published article, book chapter).
