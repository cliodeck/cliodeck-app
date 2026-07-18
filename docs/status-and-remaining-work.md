# Status and remaining work

> Updated: 2026-07-18
> Context: fusion merged into `main` at `v1.0.0-rc.2`; current work on per-feature
> branches (`feat/usage-journal`, stacked `feat/editor-cm6` — both unmerged).
> Replaces the archived `plan-post-fusion.md` as the current reference.

## 1. What is done

### Phase 0 -- Stop the bleeding
All 7 items completed. `--no-sandbox` removed, SourceInspector wired in retrieval-service, Mistral/Gemini keys in secureStorage, ESM import fix, ElectronAPI typed for fusion.

### Phase 1 -- Complete the technical fusion
All 9 items completed. Electron 28 -> 40.9.2, legacy OllamaClient/LLMProviderManager removed, ContextCompactor wired, i18n fusion (FR/EN/DE), MCP env secrets routed to secureStorage, Puppeteer removed, partial-success retrieval, Ollama tool-use whitelist, MCP server tool tests.

### Phase 2 -- Brainstorm identity
All 10 items completed. Ideas board/canvas, knowledge graph in Brainstorm, NER entity highlighting, Obsidian vault import as ideas, related ideas in source popover, MCP tool-use in Brainstorm, Brainstorm->Write insertion at cursor, security events panel, onboarding wizard, starter prompts.

### Phase 3 -- Code quality, a11y, polish
14 of 16 items completed. Inline-styles -> CSS, theme tokens, focus-visible + skip-link, Simple/Expert settings toggle, notification toasts, `ProjectLoadState` discriminated union, `SecondaryRetriever` extracted, user-configurable FR->EN dictionary, sanitizeChat on citeproc, audit-log rotation + gzip, "Workspace hints" i18n, first `any` sweep, console.* DCE in prod.

Remaining Phase 3:
- **3.6** -- Deduplicate CorpusExplorer (panel right + mode Analyze coexist)
- **3.16** -- Split `CorpusExplorerPanel.tsx` (1072 lines) into sub-components

### Phase 4 -- Release readiness
Partially done:
- **4.1** -- ADR 0005 (threat model) + ADR 0006 (credential storage) written and implemented (revoke-all-keys, cloud consent dialog)
- **4.2** -- Code signing: parked, decisions documented in `docs/code-signing-decisions.md`
- **4.3** -- Cloud consent banner implemented (per-session, covers remote Ollama)
- **4.4** -- Anti-hallucination system prompts done. OCR quality reports (per-document + corpus) done. Path A benchmark harness exists but gold-standard corpus not yet built.
- **4.5** -- Not started: isolate broken integration tests behind a tag

### Additional work done (outside the plan)
- OCR quality reports: per-document + corpus-wide (confidence, chunk quality, histogram)
- Recipe editor (form-based + CodeMirror YAML since the CM6 migration)
- Spatial canvas/board view for ideas
- Knowledge graph for ideas + entities
- **AI usage journal** (`feat/usage-journal`): separate `journal.db`, provider-registry
  capture hook, CLI, exports, Cmd/Ctrl+J modal — see ADR 0007
- **Editor migration to CodeMirror 6** (`feat/editor-cm6`, phases 0-5 complete,
  2026-07-16→18): Milkdown and Monaco removed, live rendering, Lezer
  footnote/pandoc-citation extensions, proposal contract (changeOrigin +
  adjudication journaling), −4.7 MB renderer bundle. See
  `docs/editor-architecture.md`, `docs/editor-proposals.md`,
  `docs/archive/PLAN_migration-editeur-cm6.md`

---

## 2. What remains to do

### High priority (blocking v2.0 GA)

| # | Type | Description | User action? |
|---|---|---|---|
| 4.2 | Security | Code signing (macOS notarization, Windows Authenticode) | Yes -- Apple Developer account + budget |
| 4.4 | Backend | Path A benchmark: build a gold-standard corpus (>=30 queries with relevance judgments) to gate the unified vector store migration | Yes -- historian judgment needed |
| 4.5 | Backend | Isolate 21 broken tests (better-sqlite3 + Ollama live) behind `integration` tag so CI is green | No |
| -- | Backend | Query expansion for primary sources: FR->EN expansion currently only in SecondaryRetriever, not TropyService | No |
| -- | Backend | 144 chunks with missing embeddings (5880 indexed, 5736 with embeddings) -- investigate and repair | No |

### Medium priority (quality + completeness)

| # | Type | Description | User action? |
|---|---|---|---|
| 3.6 | Design | Deduplicate CorpusExplorer: panel right OR Analyze mode, not both | Yes -- architecture choice |
| 3.16 | Frontend | Split `CorpusExplorerPanel.tsx` (1072 LOC) into sub-components | No |
| -- | Frontend | Remaining ~79 `any` in renderer (CorpusExplorerPanel, ProjectPanel, primarySourcesStore, ZoteroImport...) | No |
| -- | Frontend | Remaining ~30 hardcoded colors (TopicTimeline chart palette, CorpusExplorerPanel) | No |
| -- | Backend | Recipe `export` step ignores `document_id` input -- hardcoded to `<project>/document.md` | No |
| -- | Backend | Recipe kind `brainstorm` not yet implemented in runner | No |

### Low priority (nice-to-have for v2.0, can be v2.1)

| Type | Description |
|---|---|
| Design | Installer strategy (`docs/installer-strategy.md`): embedded Ollama, first-run wizard, bundled Pandoc/tectonic |
| Backend | Publish the Lezer extensions (`src/editor/lezer-extensions/`) as separate npm packages, MIT (CM6 plan arbitration 4 — unlocked since Phase 3; no Lezer pandoc-citation extension exists in the ecosystem) |
| Frontend | Surface adjudication acceptance rates in the usage-journal modal (aggregates already computed — `summarizeAdjudications`) |
| Frontend | Stats bar debts: i18n of labels + Lezer-based counts (`docs/TODO_barre-stats-document.md`) |
| Frontend | Brainstorm drafts propose with `model: 'unknown'` — expose the active chat model to the proposal source |
| Backend | `searchEuropeana` tool: scaffolded but not registered (needs API key) |
| Frontend | Brainstorm flagged-sources badge (follow-up from security events panel) |
| Frontend | "Drafts" panel for Brainstorm->Write flow |
| Backend | Electron auto-update via `electron-updater` |

---

## 3. Known technical debt

- **Electron 40.9.2** is current but will need periodic bumps
- **React component tests exist but 6 Brainstorm tests fail** (missing `window.electron.config` mock) — part of the 41 pre-existing failures with the mcp-server sqlite-ABI suites
- **`pdf-service.ts`** remains a 1084-line delegating facade (search pipeline)
- **`CorpusExplorerPanel.tsx`** at 1072 lines is the largest React component
- **Path B (parallel stores)** continues to ship; Path A unification is gated on benchmark

---

## 4. Files reference

| Document | Purpose |
|---|---|
| `docs/adr/0001-0007` | Architecture Decision Records (RAG, retrieval, MCP, providers, threat model, credentials, usage journal) |
| `docs/editor-architecture.md` | CM6 editor architecture (current) |
| `docs/editor-proposals.md` | AI proposal contract — no AI writing feature bypasses it |
| `docs/INSTRUCTIONS_journal-usage-ia.md` + `docs/journal-usage-ia.md` | Usage journal spec + user doc |
| `docs/TODO_barre-stats-document.md` | Document stats bar known debts |
| `docs/code-signing-decisions.md` | Parked code signing questions |
| `docs/installer-strategy.md` | Distribution plan (mode B slim installer recommended) |
| `docs/path-a-readiness.md` | RAG benchmark gate for unified vector store |
| `docs/source-traceability.md` | Brainstorm citation click-through design |
| `docs/linux-sandbox.md` | Linux sandboxing instructions |
| `docs/archive/` | Completed planning docs (fusion strategy, implementation plan, post-fusion plan, etc.) |
