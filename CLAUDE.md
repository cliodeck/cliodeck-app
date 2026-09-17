# CLAUDE.md — cliodeck-app cheat-sheet

> 5-minute orientation for a Claude Code session. Dense on purpose. Links over prose.

## 1. Orientation

ClioDeck is an Electron + React + TypeScript **desktop app for historians** covering the full research cycle: **explore → brainstorm → write → export**. Local-first, RAG-powered, with Zotero / Tropy / Obsidian integrations. Users: humanities researchers (history, DH). Licence **GPL-3.0-or-later**; current version **`1.0.0-rc.5`**.

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
- `retrieval-service.ts` — multi-source RAG over **five corpora**: PDFs (secondary), Tropy archives (primary), optional Obsidian vault, the **manuscript being written** (opt-in `includeManuscript`) and the author's **reading notes** (opt-in `includeReadingNotes`). **Path A′** (ADR 0001, amendement 2026-09-14): the corpora keep distinct schemas but share a contract — every hit's `similarity` is on the cosine scale, `max(cosine, lexical-rank relevance)` (`backend/core/rag/relevance.ts`), and each corpus is a `CorpusRetriever` (`backend/core/rag/retrievers/corpus.ts`). **Never publish an RRF score as `similarity`**: it peaks at 1/61 and sinks the corpus below all others in the shared sort (it happened twice — manuscript, then vault)
- `reading-notes-index-service.ts` — the reading notes (`reading-notes/*.md`) as a **fifth corpus** (`includeReadingNotes`, separate `readingNoteHits` channel, no quota); withheld from cloud providers unless `rag.readingNotesCloudConsent` ([`docs/reading-notes.md`](docs/reading-notes.md))
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
- `brain.db` — **the single SQLite file for every corpus and the research journal**, one table prefix per domain: `pdf_*` (secondary sources), `tropy_*` (primary sources), `obsidian_*` (vault), `manuscript_*` (manuscript corpus), `reading_notes_*` (reading notes corpus), `history_*` (research journal)
- `journal.db` — AI usage journal, deliberately a **separate file** so it can be copied and published on its own (ADR 0007)
- `hnsw.index` (PDFs), `primary-hnsw.index` (Tropy), `mcp-access.jsonl`, `security-events.jsonl`
- **The file consolidation is done** (2026-05-12, commits `3260a40`, `c044d42`, `07741ab`, `a1ca0cb`): the pre-fusion stores `vectors.db`, `primary-sources.db`, `history.db` and `obsidian-vectors.db` no longer exist on a current workspace — `migrateWorkspaceToFlat` folds them into `brain.db` on project load. What remains gated on the retrieval benchmark is **Path A** proper (ADR 0001): one *schema* (`SourceDocument` / `SourceChunk`) instead of one set of tables and one store class per corpus. Sharing a file is not sharing a schema. See [`docs/path-a-readiness.md`](docs/path-a-readiness.md).
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

- **The suite is green, and the skips are legitimate.** `npx vitest run` → 1334 passed, 75 skipped, **0 failing**. Suites needing the better-sqlite3 native binding (compiled for Electron's ABI by the postinstall) are guarded by `describe.skipIf(!sqliteAvailable)` / per-test `it.skipIf` via `backend/__tests__/helpers/native-guards.ts` (which also provides `ollamaAvailable()`).
- **⚠️ `npx vitest run` alone does NOT tell you CI will pass.** Those 75 guarded tests are *skipped locally* and *run in CI*, which recompiles for the Node ABI first. Change anything a SQLite-backed store returns and the local suite stays green while CI breaks — this cost three red runs on 2026-07-26 (adding a field to `ManuscriptStore.stats()` broke an exact `toEqual` in a guarded test). **Before pushing a change that touches `backend/core/vector-store/*`, `HistoryManager`, `ObsidianVaultStore` or any `brain.db` writer, run `npm run test:integration`** — it rebuilds for the Node ABI, runs the whole suite (→ 1409 passed, 0 skipped) and restores the Electron ABI afterwards. Skipping that restore leaves the app unable to start — and **verify it actually happened** — piping that command's output through `head` can kill the rebuild by SIGPIPE, leaving the Node ABI in place. Le contrôle doit **ouvrir** une base, pas seulement charger le module : better-sqlite3 lie le binding natif paresseusement, si bien que `node -e "require('better-sqlite3')"` réussit sur les deux ABI et ne prouve rien. Utiliser `node -e "new (require('better-sqlite3'))(':memory:')"`, qui doit **échouer** quand l'ABI Electron est en place.
- **CI exists**: `.github/workflows/tests.yml` — build → typecheck (root, main, preload) → vitest on the Node ABI → lint → skipped-test summary. It does **not** build distributables.
- **Les tests e2e Playwright tournent en local, jamais en CI** (`npm run test:e2e`, `e2e/*.spec.ts`, app réelle lancée par `_helpers/launch.ts`). Sans affichage, la CI les saute : deux des trois smoke tests étaient rouges depuis des mois sans que rien ne le dise (libellés anglais alors que l'app démarre en français, mode « Analyze » renommé « Explore », sections des réglages devenues des entrées de navigation derrière le mode Expert). Le lanceur **fixe la langue** (`E2E_LANGUAGE`, français) dans le `cliodeck-config.json` du userData temporaire : sans ça, un test écrit sur un libellé dépend du poste. Lancer la suite après tout changement d'interface.
- **React component tests DO exist** — 13 `.test.tsx` files run under jsdom with `@testing-library/react` and a full `vitest.setup.ts`. The line that used to claim the setup was "pending" was wrong; the 2026-07-25 audit caught it. Coverage is still thin, but the harness is there — add to it rather than re-scaffolding.
- **Ollama provider exposes `capabilities.tools` per-model** via a whitelist (`ministral-3:8b/14b`, `qwen3:8b/14b/32b`, `mistral-nemo`); other models (notably the Llama 3.x and 4.x families) get `tools: false`. So a provider's `tools` capability is a function of its **configuration**, not its identity — do not cache it across a model change. See `OLLAMA_TOOL_CAPABLE_PATTERNS` in `backend/core/llm/providers/ollama.ts`, `docs/archive/research-ollama-tools-1.8.md` for the source-cited rationale, and the 2026-07-25 amendment to ADR 0004. The 4 cloud providers (OpenAI-compatible, Anthropic, Mistral, Gemini) advertise tool-use unconditionally.
- **macOS signing + notarization work (2026-09-15, #75 / PR #105).** `npm run release:mac` (or `release:mac-arm` / `release:mac-intel`) signs with the Developer ID certificate in the keychain and notarizes through the `cliodeck-notary` notarytool profile; `build:mac*` signs but never notarizes. Config is `mac.notarize: true` — **not** `{ teamId }` (electron-builder passes it alongside keychain/API-key credentials and `@electron/notarize` 2.2.1 rejects the mix) and never `APPLE_ID` in the environment (`true` + `APPLE_ID` falls back to the closed `altool`). `mac.target` lists x64 **and** arm64, so `build:mac-arm` builds both. The Intel app built on Apple Silicon needs llama.cpp's x64 engine package, which `npm ci` only installs for the host arch: every `build:mac*` runs `npm run fetch:llama-mac` (lock-verified tarballs, no tree rewrite) — without it the rc.6-beta.2 Intel DMG shipped with no embedded model (#128). Check bundled binaries' arch with `file` (`docs/macos-notarization.md`). Signing timestamps every file against `timestamp.apple.com`: a network blip fails the build, rerun. Procedure and machine prerequisites (G2 intermediate CA, Xcode licence): [`docs/macos-notarization.md`](docs/macos-notarization.md). CI signing is not wired; the DMGs published for `v1.0.0-rc.4` are unsigned.
- **Latent trap** (flagged in PR #42, never fixed): `projectStore.loadProject`'s fallback overwrites `documentPath` with `# <name>` when `loadFile` fails.
- **Synchro Tropy — chemin réparé le 2026-08-30, à ne pas re-casser.** Cinq défauts y faisaient perdre en silence l'intégralité d'un OCR de corpus (~24 h de calcul, mesuré sur un projet réel de 221 documents). Deux règles à garder en tête :
  - **La fraîcheur d'un item se lit sur `subjects.modified` (par item), jamais sur la mtime du `.tpy`** (globale au projet). C'était l'erreur d'origine : plus aucune source n'était jamais vue comme « modifiée », donc jamais sauvegardée, alors que l'OCR tournait quand même — avant la décision d'écriture.
  - **Jamais `INSERT OR REPLACE` sur une table qui a des enfants.** REPLACE supprime la ligne en conflit ; `PrimarySourcesVectorStore` ouvre avec `foreign_keys = ON` et quatre tables filles sont en `ON DELETE CASCADE`. Réenregistrer une source emportait ses chunks (46 → 0, mesuré) et ses mentions d'entités — photos et tags, réinsérés juste après, masquaient le trou. Utiliser `ON CONFLICT(id) DO UPDATE`.
  
  Couverture : `TropySyncPersistence.test.ts` + `PrimarySourcesPersistence.test.ts` (12 tests, 11 rouges sur le code d'avant). **Restent sans test** : `sync()` de bout en bout et tout `TropyOCRPipeline`. Détail et leçons dans [`docs/status-and-remaining-work.md`](docs/status-and-remaining-work.md) §2.
- **Réglages du chat : un seul réglage, deux éditeurs (2026-09-08).** Le panneau `RAGSettingsPanel` et *Réglages → LLM* écrivent les mêmes champs (`llm.ollamaChatModel`, `llm.ollamaNumCtx`, `llm.generationProvider`) ; `ragQueryStore.resetToDefaults` les relit à chaque lancement. Ne pas réintroduire un override de session persistant côté renderer : c'est le bug en miroir. Le modèle du panneau n'est appliqué qu'à la génération Ollama locale (`applyChatModelOverride`) ; top-p / top-k / repeat penalty **et la fenêtre `num_ctx`** idem (`resolveTurnOptions` : Anthropic refuse `temperature` + `top_p` ensemble, et une fenêtre Ollama ne doit pas servir de budget au compacteur d'un backend cloud). La fenêtre de contexte se lit sur `ollama:show-model` (`/api/show`), plus aucune table de tailles dans le renderer ; bornes de sécurité `NUM_CTX_MIN`/`NUM_CTX_MAX` dans `backend/core/llm/context-windows.ts` (2 M, pas 256 K : les Qwen 3.5 acceptent un million de jetons). `num_ctx` part à chaque appel Ollama et prime sur `OLLAMA_CONTEXT_LENGTH`. **Rien d'inerte dans ce panneau** : un réglage affiché a un consommateur ou disparaît — le « Timeout » est un délai d'*inactivité* (`inactivity-watchdog.ts`), jamais une durée totale de tour. **Le `fetch` de Node coupe à 300 s sans en-têtes** (`headersTimeout` d'undici) : `OllamaProvider` passe un `Agent` sans délai (`ollamaDispatcher()`, dépendance `undici` ^7 alignée sur le Node d'Electron), sinon un gros modèle local meurt en silence avant le premier jeton. Le panneau estime modèle + contexte contre 75 % de la RAM (`memory-estimate.ts`) : un 22 Go sur 24 Go déborde déjà seul. **Les modèles pensants (Qwen 3.x…) envoient `message.thinking` avant tout contenu** : `ChatChunk.thinking` le transporte, le moteur émet la phase `thinking`, le renderer l'affiche replié et le compte comme activité ; `ChatOptions.think: false` le coupe (réglage du panneau, `llm.ollamaThink`). Ignorer ces morceaux = un modèle muet pendant des minutes et un délai d'inactivité qui tombe à tort. Détail dans [`docs/status-and-remaining-work.md`](docs/status-and-remaining-work.md) §2.
- **PDF corpus: one file, one document (2026-09-14).** `PDFIndexer.indexPDF` used to add a new document (random id, full chunk set) on every call, and only a renderer-side in-memory set guarded against it — measured on a real project: 221 documents for 55 PDFs, 5 920 chunks of which 1 264 distinct, copies crowding the retrieval `topK`. Indexing a file already present now **replaces** it (`mergeDocumentsInto`, after the new chunks are written, re-pointing incoming citations and Zotero collections); `pdfService.init` removes legacy duplicates after a `brain.db.avant-dedoublonnage-<date>` backup. **"One file" means one file on disk, not one path string (#123, rc.6):** documents are matched by real path (`backend/core/vector-store/file-identity.ts`, `realpathSync.native`), because macOS ignores case — a PDF renamed by case only (Zotero rename) and reindexed used to become a second document, invisible to both the dedup and the health check. Never compare `file_path` with `=` / `GROUP BY` to decide identity. HNSW/BM25 cannot remove a vector: any document deletion marks `EnhancedVectorStore` stale and `pdfService.scheduleIndexRebuild` rebuilds once in-flight indexing is done; search drops hits whose document is gone.
- **PDF extraction: pdfjs-dist 5, one loader, Electron's Node (rc.6, #77).** Load pdfjs **only** through `backend/core/pdf/pdfjs-loader.ts` and never call `page.render()` — `pdfjs-no-render.test.ts` fails otherwise (rendering is the CVE-2024-4367 path). Under Node, pdfjs 5 dies on « DOMMatrix is not defined » unless `DOMMatrix`/`ImageData`/`Path2D` exist; the loader installs method-less placeholders instead of relying on `@napi-rs/canvas`, which is prebuilt per architecture (the Intel DMG built on Apple Silicon only carries the arm64 binary). pdfjs still `require`s it unconditionally, so it is excluded from packaged apps (`build.files`) and its expected multi-line warning is silenced during import — otherwise every PDF would log a fake `[pdf-worker:err]`. The extraction worker runs on `process.execPath` + `ELECTRON_RUN_AS_NODE=1`, **not** a system `node` (most users have none; pdfjs 5 needs Node ≥ 22.13). Before touching that path, run `scripts/pdf-extraction-snapshot.mjs` on real PDFs and compare.
- **The manuscript corpus is fully wired since rc.4.** Three defects were fixed: its hits carried an RRF score (max ≈ 0.016) against the other corpora's cosine (threshold 0.12) and were crowded out of `slice(0, topK)` — `retrieval-service.ts` now publishes the real cosine and reserves a quota (`retrieval-quota.ts`); `manuscript:index` / `manuscript:stats` were registered in main but **absent from the preload**, hence unreachable; and nothing in the UI called them. `ManuscriptCorpusSection` (Settings → expert) now shows the index state — pieces, extracts, last-indexed date — offers a re-index button and exposes `rag.indexManuscript`. Known edge: the panel reads its state on mount, so figures go stale if you leave Settings open while writing.

## 7. Glossary

- **RAG** — Retrieval-Augmented Generation (corpus chunks injected into LLM prompts).
- **RetrievalService** — unified search across the four corpora: PDFs (secondary), Tropy archives (primary), Obsidian vault, and the manuscript being written.
- **Manuscript corpus** — the historian's own text, indexed as a fourth corpus so the assistant can answer « what have I already written about X? ». Extracts are labelled `manuscrit`, never « bibliographie » — the author must see when they are citing themselves.
- **`manuscript` vs `book` — the boundary that trips people up.** `book` is a **project type** (how the text is stored: N files in `chapters/`, no `document.md`). *Manuscript* is a **semantic notion** (whose text it is: the author's own, as opposed to their sources) and exists in all three project types — `document.md` for an article, `slides.md` for a presentation, the chapters for a book. The trap is that the code uses the word at two levels: `manuscript-index-service` / `ManuscriptStore` (backend) really do mean **the fourth RAG corpus, all project types**, whereas `manuscriptStore` (renderer), `manuscript-assembler` and `ManuscriptSearch` are **book-only in practice** — `manuscriptStore.refreshAll` returns immediately when `chapters.length === 0`. Read `manuscriptStore` as *book outline store*; it is misnamed, not general.
- **MCP** — Model Context Protocol (Anthropic spec; cliodeck is both a server and a client).
- **`.cliohints`** — workspace-level system-prompt context, persists across chats (`.cliodeck/hints.md`).
- **Recipe** — YAML-defined workflow chaining brainstorm / search / graph / write / export steps.
- **Vault** — an Obsidian markdown notes folder, indexed in the `obsidian_*` tables of `.cliodeck/brain.db`.
- **Note de lecture** — one Markdown file per reference in `reading-notes/` (front matter: `citekey`, `zotero_key`, project `tags`). Project-owned and editable; Zotero tags and notes are Zotero-owned and read-only (automatic Zotero tags hidden by default). Never written to the `.bib`. See [`docs/reading-notes.md`](docs/reading-notes.md).
- **Primary source** — Tropy archive (archival photos, OCR'd documents).
- **Secondary source** — PDF in the bibliography (published article, book chapter).
