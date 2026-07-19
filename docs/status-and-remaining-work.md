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

Remaining Phase 3: none — **3.6** was resolved during the RC cycle ('analyze'
mode renamed to 'explore' (A10), 'corpus' right view removed (A19):
`CorpusExplorerPanel` now lives only in `ExplorePanel` tabs) and **3.16** too
(panel split into `CorpusGraphSection` / `CorpusTopicsSection` /
`TextometricsPanel` / `TopicTimeline`; the panel itself is 258 LOC).

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
- **Book chapters** (`feat/livre-chapitres`, phases 1-5 complete, 2026-07-19):
  the `book` project type is no longer an empty shell — multi-file chapter
  manifest with disk reconciliation, chapter panel, per-chapter editor state
  cache (undo survives switching), manuscript outline, manuscript-wide
  footnote renumbering / citation check / statistics, per-book settings
  (note style and numbering, bibliography placement, heading numbering), and
  assembly-based PDF/Word exports with per-chapter footnote namespacing.
  See `docs/book-architecture.md`, `docs/archive/PLAN_chapitres-livre.md`

---

## 2. What remains to do

### High priority (blocking v2.0 GA)

| # | Type | Description | User action? |
|---|---|---|---|
| 4.2 | Security | Code signing (macOS notarization, Windows Authenticode) | Yes -- Apple Developer account + budget |
| 4.4 | Backend | Path A benchmark: build a gold-standard corpus (>=30 queries with relevance judgments) to gate the unified vector store migration | Yes -- historian judgment needed |
| 4.5 | Backend | ~~Isolate broken tests so CI is green~~ **Done 2026-07-18**: environmental suites guarded by `skipIf` (`backend/__tests__/helpers/native-guards.ts`); remaining reds = 6 Brainstorm jsdom tests (renderer batch) | No |
| -- | Backend | ~~Query expansion for primary sources~~ **Done 2026-07-18**: TropyService now reuses `expandQueryToText` (built-in dict + `rag.queryExpansionDictionary`), identity when no term matches | No |
| -- | Backend | 144 chunks with missing embeddings (5880 indexed, 5736 with embeddings) -- investigate and repair | No |

### Medium priority (quality + completeness)

| # | Type | Description | User action? |
|---|---|---|---|
| -- | Frontend | Remaining ~79 `any` in renderer (CorpusExplorerPanel, ProjectPanel, primarySourcesStore, ZoteroImport...) | No |
| -- | Frontend | Remaining ~30 hardcoded colors (TopicTimeline chart palette, CorpusExplorerPanel) | No |
| -- | Backend | ~~Recipe `export` step ignores `document_id`~~ **Done 2026-07-18**: runner interpolates `{{ }}` in step `with` params (except `prompt`), handler accepts `document_id`/`document`, builtin recipe aligned | No |
| -- | Backend | Recipe kind `brainstorm` not yet implemented in runner | No |

### Low priority (nice-to-have for v2.0, can be v2.1)

| Type | Description |
|---|---|
| Design | Installer strategy (`docs/installer-strategy.md`): embedded Ollama, first-run wizard, bundled Pandoc/tectonic |
| Backend | Publish the Lezer extensions (`src/editor/lezer-extensions/`) as separate npm packages, MIT (CM6 plan arbitration 4 — unlocked since Phase 3; no Lezer pandoc-citation extension exists in the ecosystem) |

| Frontend | Book: multi-chapter search (deferred from phase 3 — needs its own result panel and refresh model) |
| Backend | Book: index (`\index{}`) and typed cross-references — same technical family as footnotes/citations (Lezer extension + resolution at assembly) |
| Backend | Book: Word export ignores `noteStyle`/`noteNumbering` (LaTeX path only) |
| Backend | Index the manuscript itself in the RAG — nothing currently reads the text being written; a book is where it would matter most |
| Backend | `searchEuropeana` tool: scaffolded but not registered (needs API key) |
| Frontend | Brainstorm flagged-sources badge (follow-up from security events panel) |
| Frontend | "Drafts" panel for Brainstorm->Write flow |
| Backend | Electron auto-update via `electron-updater` |

---


### Angle mort de la « CI verte » — 8 échecs corrigés, la CI reste à créer

**Constat (2026-07-19)** : les gardes `skipIf` de
`backend/__tests__/helpers/native-guards.ts` sautent les suites SQLite quand
`better-sqlite3` est compilé pour l'ABI Electron (l'état normal d'un poste de
dev, posé par le `postinstall`). En recompilant pour l'ABI Node
(`npm rebuild better-sqlite3`), **8 échecs réels apparaissaient** : la suite
« verte » l'était parce que ces tests ne tournaient pas.

**Corrigé (RC3)** — aucun ne révélait un bug de production, mais deux
révélaient de vraies faiblesses :

| Suite | Cause | Correction |
|---|---|---|
| `workspace/migrator.test.ts` (4) + `scripts/cli-migrate.test.ts` (1) | les fixtures écrivaient un fichier **texte** nommé `.db`, que le migrateur ouvrait pour de bon | vraies bases SQLite minimales, marquées et relues après migration ; **et** garde de production durcie (voir ci-dessous) |
| `mcp-server/search{Obsidian,Tropy,Zotero}.test.ts` (3) | budget de troncature affirmé à 800 alors que la production utilisait 4 000 — même bug que `searchHal`, dont la cause racine était la constante `TRUNCATE` recopiée dans six outils | constante factorisée dans `backend/mcp-server/tools/budget.ts` ; les tests s'y réfèrent au lieu de coder le nombre en dur |

Effet de bord utile : la garde de `migrateWorkspaceToFlat` supposait que
`new Database()` échoue sur un fichier qui n'est pas une base. better-sqlite3
ouvre **paresseusement** : l'erreur ne survenait qu'à la première requête, en
dehors du `try`. Un `brain.db` corrompu ou partiel faisait donc échouer toute
la migration. Une sonde explicite ferme le trou.

**Reste à faire — la CI elle-même.** Le dépôt n'a **aucun workflow exécutant
les tests** : `.github/workflows/` ne contient que `claude.yml` et
`claude-code-review.yml`. Tant que rien ne tourne en intégration continue,
les gardes continueront de masquer une future régression sur un poste de dev.
Marche à suivre quand la CI sera créée :

1. job Node (pas Electron) : `actions/setup-node`, `npm ci` ;
2. **`npm rebuild better-sqlite3`** avant les tests — c'est ce qui compile le
   binding pour l'ABI Node et désactive les `skipIf` ;
3. `npx vitest run` : les 8 suites ci-dessus doivent y tourner pour de bon ;
4. ne pas supprimer les gardes : elles restent utiles en local, où le binding
   est compilé pour Electron. Elles ne masqueront alors plus que
   l'indisponibilité authentique du binding.

En local, après avoir recompilé pour Node, **restaurer impérativement l'ABI
Electron** : `npm run rebuild:native`.

## 3. Known technical debt

- **Electron 40.9.2** is current but will need periodic bumps
- **React component tests**: the 6 Brainstorm failures are fixed (missing `window.electron.config` mock, 2026-07-18); remaining red suites are the mcp-server sqlite-ABI ones
- **`pdf-service.ts`** remains a 1084-line delegating facade (search pipeline)
- **Path B (parallel stores)** continues to ship; Path A unification is gated on benchmark

---

## 4. Files reference

| Document | Purpose |
|---|---|
| `docs/adr/0001-0007` | Architecture Decision Records (RAG, retrieval, MCP, providers, threat model, credentials, usage journal) |
| `docs/editor-architecture.md` | CM6 editor architecture (current) |
| `docs/editor-proposals.md` | AI proposal contract — no AI writing feature bypasses it |
| `docs/INSTRUCTIONS_journal-usage-ia.md` + `docs/journal-usage-ia.md` | Usage journal spec + user doc |
| `docs/archive/TODO_barre-stats-document.md` | Document stats bar known debts |
| `docs/code-signing-decisions.md` | Parked code signing questions |
| `docs/installer-strategy.md` | Distribution plan (mode B slim installer recommended) |
| `docs/path-a-readiness.md` | RAG benchmark gate for unified vector store |
| `docs/source-traceability.md` | Brainstorm citation click-through design |
| `docs/linux-sandbox.md` | Linux sandboxing instructions |
| `docs/archive/` | Completed planning docs (fusion strategy, implementation plan, post-fusion plan, etc.) |
