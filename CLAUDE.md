# CLAUDE.md — cliodeck-app cheat-sheet

> 5-minute orientation for a Claude Code session. Dense on purpose. Links over prose.

## 1. Orientation

ClioDeck is an Electron + React + TypeScript **desktop app for historians** covering the full research cycle: **explore → brainstorm → write → export**. Local-first, RAG-powered, with Zotero / Tropy / Obsidian integrations. Users: humanities researchers (history, DH). You are currently on branch **`feat/fusion-cliobrain`** (~50 commits ahead of `main`, not yet pushed to origin) which **absorbs [ClioBrain](https://github.com/inactinique/cliobrain) into ClioDeck as the *Brainstorm* mode** so historians get one app instead of switching between a note-centric brainstormer and a writing assistant. See [`docs/fusion-cliobrain-strategy.md`](docs/fusion-cliobrain-strategy.md) and [`docs/fusion-cliobrain-implementation-plan.md`](docs/fusion-cliobrain-implementation-plan.md) — commit messages reference the step numbers defined there.

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
- `chat-service.ts` — legacy RAG chat (still active)
- `tropy-service.ts`, `history-service.ts`, `mode-service.ts`, `pdf-export.ts`, etc.

**Provider abstraction** — `backend/core/llm/providers/base.ts` defines `LLMProvider` and `EmbeddingProvider` with a **typed `ProviderState`** state machine (`unconfigured | spawning | handshaking | ready | degraded | failed | stopped`), never a boolean. `ChatMessageMeta.ragCitation` marks retrieval messages so the compactor keeps them verbatim.
- Implementations: `ollama`, `openai-compatible`, `anthropic`, `mistral`, `gemini`
- Registered in `backend/core/llm/providers/registry.ts` (open factory map)
- Legacy bridges: `createRegistryFromLegacyConfig`, `createRegistryFromClioDeckConfig`

**Workspace v2 layout** — `<projectRoot>/.cliodeck/v2/`:
- `config.json` (`schema_version: 2`), `hints.md`, `recipes/`, `recipes-runs/`
- `obsidian-vectors.db`, `mcp-access.jsonl`, `security-events.jsonl`
- Legacy `.cliodeck/*` paths **still coexist** during transition (see §4).

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

- **Legacy `.cliodeck/*` workspace layout** — coexists with v2; the migration swap is **gated on a Path A RAG benchmark** (ADR 0001).
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

- **21 preexisting test failures**: `better-sqlite3` native bindings issues under Vitest + Ollama live-backend tests that timeout when no Ollama is running.
- **No React component tests** — jsdom + `@testing-library/react` setup pending.
- **`feat/fusion-cliobrain`** has ~50 unmerged commits, **not yet pushed to origin**.
- **Recipe `export` step ignores `document_id` input** — hardcoded to `<project>/document.md`.
- **Ollama provider exposes `capabilities.tools` per-model** via a whitelist (`ministral-3:8b/14b`, `qwen3:8b/14b/32b`, `mistral-nemo`); other models (notably the Llama 3.x and 4.x families) get `tools: false`. See `OLLAMA_TOOL_CAPABLE_PATTERNS` in `backend/core/llm/providers/ollama.ts` and `docs/research-ollama-tools-1.8.md` for the source-cited rationale. The 4 cloud providers (OpenAI-compatible, Anthropic, Mistral, Gemini) advertise tool-use unconditionally.

## 7. Glossary

- **RAG** — Retrieval-Augmented Generation (corpus chunks injected into LLM prompts).
- **RetrievalService** — unified search across PDFs (secondary), Tropy archives (primary), Obsidian vault.
- **MCP** — Model Context Protocol (Anthropic spec; cliodeck is both a server and a client).
- **`.cliohints`** — workspace-level system-prompt context, persists across chats (`.cliodeck/v2/hints.md`).
- **Recipe** — YAML-defined workflow chaining brainstorm / search / graph / write / export steps.
- **Vault** — an Obsidian markdown notes folder, indexed in `.cliodeck/v2/obsidian-vectors.db`.
- **Primary source** — Tropy archive (archival photos, OCR'd documents).
- **Secondary source** — PDF in the bibliography (published article, book chapter).
