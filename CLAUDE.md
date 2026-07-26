# CLAUDE.md — cliodeck-app cheat-sheet

> 5-minute orientation for a Claude Code session. Dense on purpose. Links over prose.

## 1. Orientation

ClioDeck is an Electron + React + TypeScript **desktop app for historians** covering the full research cycle: **explore → brainstorm → write → export**. Local-first, RAG-powered, with Zotero / Tropy / Obsidian integrations. Users: humanities researchers (history, DH). Licence **GPL-3.0-or-later**; current version **`1.0.0-rc.4`**.

Work happens on per-feature branches off `main` (check `git status`). As of 2026-07-25 `main` is the whole story: the fusion, the usage journal, the CM6 editor migration, the chat and slides unifications, the book-chapters chantier and the July bug campaign have all merged. The fusion cycle (branch `feat/fusion-cliobrain`, merged into `main` at `v1.0.0-rc.2`) **absorbed [ClioBrain](https://github.com/inactinique/cliobrain) into ClioDeck as the *Brainstorm* mode** so historians get one app instead of switching between a note-centric brainstormer and a writing assistant. See [`docs/archive/fusion-cliobrain-strategy.md`](docs/archive/fusion-cliobrain-strategy.md) and [`docs/archive/fusion-cliobrain-implementation-plan.md`](docs/archive/fusion-cliobrain-implementation-plan.md) — commit messages reference the step numbers defined there.

**Where to look first**: [`docs/status-and-remaining-work.md`](docs/status-and-remaining-work.md) is the live status reference (what is done, what remains, which documents are current). Dated snapshots live in [`docs/archive/`](docs/archive/README.md) — read those for *why* something is shaped the way it is, never for what is true now.

## 2. Architecture quick-tour

**Electron split:**
- `src/main/` — Node-side: IPC handlers, services, workspace & storage
- `src/preload/index.ts` — `contextBridge`, exposes `window.electron.*` to renderer
- `src/renderer/` — React + Vite + TS UI
- `backend/` — provider-agnostic libraries, importable from `src/main/`

**Key services** (`src/main/services/`):
- `pdf-service.ts` — vector store, indexing (~839 lines, contains a **delegating facade for search**)
- `retrieval-service.ts` — multi-source RAG over **four corpora**: PDFs (secondary), Tropy archives (primary), optional Obsidian vault, and the **manuscript being written** (opt-in `includeManuscript`)
- `manuscript-index-service.ts` — the manuscript as a fourth corpus: incremental by content hash, indexed after save, best-effort ([`docs/manuscript-corpus.md`](docs/manuscript-corpus.md))
- `mcp-clients-service.ts` — lifecycle of external MCP servers (stdio + SSE)
- `fusion-chat-service.ts` — unified chat transport (IPC `fusion:chat:*`): retrieval injection wiring, MCP tools, journals
- `chat-engine.ts` — the shared chat core extracted from fusion-chat-service (agent loop, compaction, retrieval hook) — NOT legacy; single UI shell: `AssistantChat` (variants `full`/`panel`, fusion step 5 done)
- `usage-journal-service.ts` — AI usage journal sink (`.cliodeck/journal.db`, never logs prompts)
- `tropy-service.ts`, `history-service.ts`, `mode-service.ts`, `pdf-export.ts`, etc.

**Provider abstraction** — `backend/core/llm/providers/base.ts` defines `LLMProvider` and `EmbeddingProvider` with a **typed `ProviderState`** state machine (`unconfigured | spawning | handshaking | ready | degraded | failed | stopped`), never a boolean. `ChatMessageMeta.ragCitation` marks retrieval messages so the compactor keeps them verbatim.
- Implementations: `ollama`, `openai-compatible`, `anthropic`, `mistral`, `gemini`
- Registered in `backend/core/llm/providers/registry.ts` (open factory map)
- Legacy bridges: `createRegistryFromLegacyConfig`, `createRegistryFromClioDeckConfig`

**Workspace layout** — `<projectRoot>/.cliodeck/` (flat):
- `config.json` (`schema_version: 2`), `hints.md`, `recipes/`, `recipes-runs/`
- `brain.db` — research journal (`history_*`) and manuscript corpus (`manuscript_*`)
- `journal.db` — AI usage journal, deliberately a **separate file** so it can be copied and published on its own (ADR 0007)
- `obsidian-vectors.db`, `hnsw.index`, `mcp-access.jsonl`, `security-events.jsonl`
- The pre-fusion SQLite stores (`vectors.db`, `primary-sources.db`, `history.db`) live alongside at the same flat level — consolidating them into `brain.db` is a Path A concern (ADR 0001), still gated on the retrieval benchmark.
- The authoritative map is `workspaceFiles` in `backend/core/workspace/layout.ts` (see §4 — do not change it without asking).
- Legacy `.cliodeck/v2/*` (pre-flatten) and pre-fusion v1 layouts are auto-migrated to flat on project load via `migrateWorkspaceToFlat`.

**Project types** — `article` | `book` | `presentation` (`project.json`).
- **`book`** = manuscrit à N fichiers : **pas de `document.md`**, les chapitres vivent dans `chapters/` et `project.json` porte le manifeste (`chapters[]`) plus les réglages d'ouvrage (`book.noteStyle`, `noteNumbering`, `bibliography`, `numberChapters`, `numberSections`). Types partagés : `backend/types/book.ts`. Architecture : [`docs/book-architecture.md`](docs/book-architecture.md).
- **Assemblage** — `src/main/services/manuscript-assembler.ts` produit le flux unique pour les exports, en **préfixant les identifiants de notes par chapitre** (sans quoi deux `[^1]` homonymes rendent la même note : mesuré avec pandoc).
- **Règle transverse** — le **chapitre ouvert vient de l'éditeur vivant** (`getLiveContent`), jamais du disque : sinon les frappes non sauvegardées sont ignorées (renumérotation, statistiques, exports).
- **`presentation`** édite `slides.md` (découpage partagé : `src/editor/slides.ts`).

**IPC** — handlers in `src/main/ipc/handlers/*-handlers.ts`, bindings in `src/preload/index.ts`, surfaced as `window.electron.*` in the renderer.

## 3. Conventions

- **Commit messages** — focus on *why* not *what*. End with a `Co-Authored-By` trailer naming **the model actually used**:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```
  Keep this tracking the model in use rather than a fixed name. History of the line: `Claude Opus 4.6 (1M context)` until 2026-07-24; **Opus 5 from 2026-07-25**. Commits before that date carry the earlier trailer and are correct as they stand — do not rewrite them.
- **Never amend commits.** Never `git push --force`. Never `--no-verify`.
- **Prefer `Edit` over `Write`** for existing files.
- **Strict TypeScript** — no `any`. If truly unavoidable, `// @ts-expect-error <one-line reason>`.
- **CSS** — use theme tokens from `src/renderer/src/index.css`: `--bg-app`, `--bg-panel`, `--text-primary`, `--text-secondary`, `--text-tertiary`, `--border-color`, `--color-accent`, `--color-danger`. Never hardcode colors. For tinted states: `color-mix(in srgb, var(--color-X) N%, transparent)`.
- **Tests** — Vitest, env `'node'` (no jsdom / testing-library yet). Location: `**/__tests__/*.test.ts`.
- **Build** — `npm run build` (tsc + vite, ~1 min). Run app: `npm start`.
- **Before pushing** — `npm run typecheck` (`tsc --noEmit`) and `npm run lint`. **`npm run build` does not typecheck the renderer** (Vite/esbuild strips types without checking them), so a renderer type error passes the build and fails CI. Lint must stay at **0 errors**; warnings (~414) are a known stock.
- **i18n** — keys in `public/locales/{fr,en,de}/common.json`. **Three locales, and fr↔en↔de parity is tested** — a key added to one must be added to all three. Note the blind spot the July audits found: the parity test compares locale files with each other, so it cannot see a component that never calls `t()`.
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

## 6. Known issues (state of `main`, 2026-07-25)

- **The suite is green, and the skips are legitimate.** `npx vitest run` → 1288 passed, 68 skipped, **0 failing**. On the Node ABI (what CI does: `npm rebuild better-sqlite3` first) → **1356 passed, 0 skipped**. Suites needing the better-sqlite3 native binding (compiled for Electron's ABI by the postinstall) are guarded by `describe.skipIf(!sqliteAvailable)` / per-test `it.skipIf` via `backend/__tests__/helpers/native-guards.ts` (which also provides `ollamaAvailable()`); they show as readable skips locally and **do run in CI**, which recompiles for the Node ABI first. After running `npm rebuild better-sqlite3` locally, restore the Electron ABI with `npm run rebuild:native` or the app will not start.
- **CI exists**: `.github/workflows/tests.yml` — build → typecheck (root, main, preload) → vitest on the Node ABI → lint → skipped-test summary. It does **not** build distributables.
- **React component tests DO exist** — 13 `.test.tsx` files run under jsdom with `@testing-library/react` and a full `vitest.setup.ts`. The line that used to claim the setup was "pending" was wrong; the 2026-07-25 audit caught it. Coverage is still thin, but the harness is there — add to it rather than re-scaffolding.
- **Ollama provider exposes `capabilities.tools` per-model** via a whitelist (`ministral-3:8b/14b`, `qwen3:8b/14b/32b`, `mistral-nemo`); other models (notably the Llama 3.x and 4.x families) get `tools: false`. So a provider's `tools` capability is a function of its **configuration**, not its identity — do not cache it across a model change. See `OLLAMA_TOOL_CAPABLE_PATTERNS` in `backend/core/llm/providers/ollama.ts`, `docs/archive/research-ollama-tools-1.8.md` for the source-cited rationale, and the 2026-07-25 amendment to ADR 0004. The 4 cloud providers (OpenAI-compatible, Anthropic, Mistral, Gemini) advertise tool-use unconditionally.
- **One open issue**: [#75](https://github.com/cliodeck/cliodeck-app/issues/75) — macOS signing/notarization, blocked on an Apple Developer ID certificate. Distributed builds trip Gatekeeper until then.
- **Latent trap** (flagged in PR #42, never fixed): `projectStore.loadProject`'s fallback overwrites `documentPath` with `# <name>` when `loadFile` fails.
- **The manuscript corpus reaches the assistant since rc.4, but still has no UI.** Two defects were fixed: its hits carried an RRF score (max ≈ 0.016) against the other corpora's cosine (threshold 0.12) and were crowded out of `slice(0, topK)` — `retrieval-service.ts` now publishes the real cosine and reserves a quota (`retrieval-quota.ts`); and `manuscript:index` / `manuscript:stats` were registered in main but **absent from the preload**, hence unreachable. They are exposed now. What is still missing is the *interface*: nothing shows the index state or offers a re-index button, and `rag.indexManuscript` has no control in Settings.

## 7. Glossary

- **RAG** — Retrieval-Augmented Generation (corpus chunks injected into LLM prompts).
- **RetrievalService** — unified search across the four corpora: PDFs (secondary), Tropy archives (primary), Obsidian vault, and the manuscript being written.
- **Manuscript corpus** — the historian's own text, indexed as a fourth corpus so the assistant can answer « what have I already written about X? ». Extracts are labelled `manuscrit`, never « bibliographie » — the author must see when they are citing themselves.
- **`manuscript` vs `book` — the boundary that trips people up.** `book` is a **project type** (how the text is stored: N files in `chapters/`, no `document.md`). *Manuscript* is a **semantic notion** (whose text it is: the author's own, as opposed to their sources) and exists in all three project types — `document.md` for an article, `slides.md` for a presentation, the chapters for a book. The trap is that the code uses the word at two levels: `manuscript-index-service` / `ManuscriptStore` (backend) really do mean **the fourth RAG corpus, all project types**, whereas `manuscriptStore` (renderer), `manuscript-assembler` and `ManuscriptSearch` are **book-only in practice** — `manuscriptStore.refreshAll` returns immediately when `chapters.length === 0`. Read `manuscriptStore` as *book outline store*; it is misnamed, not general.
- **MCP** — Model Context Protocol (Anthropic spec; cliodeck is both a server and a client).
- **`.cliohints`** — workspace-level system-prompt context, persists across chats (`.cliodeck/hints.md`).
- **Recipe** — YAML-defined workflow chaining brainstorm / search / graph / write / export steps.
- **Vault** — an Obsidian markdown notes folder, indexed in `.cliodeck/obsidian-vectors.db`.
- **Primary source** — Tropy archive (archival photos, OCR'd documents).
- **Secondary source** — PDF in the bibliography (published article, book chapter).
