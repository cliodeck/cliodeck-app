# Status and remaining work

> Updated: 2026-07-25 — version `1.0.0-rc.3`, licence GPL-3.0-or-later.
> Context: everything below has landed on `main`. The fusion merged at
> `v1.0.0-rc.2`; the usage journal, the CM6 editor migration, the chat and
> slides unifications and the book-chapters chantier have all merged since,
> as has the July 2026 bug campaign (PRs #41–#74, 31 issues triaged).
> **One issue is open: [#75](https://github.com/cliodeck/cliodeck-app/issues/75)**
> (macOS notarization), blocked on an Apple Developer ID certificate.
> Replaces the archived `plan-post-fusion.md` as the current reference.
>
> Health of `main` at that date: `npm run typecheck` clean;
> `npx vitest run` **1234 passed, 68 skipped, 0 failing**; `npm run lint`
> 0 errors / ~414 warnings. CI runs all three
> (`.github/workflows/tests.yml`).

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
- **4.2** -- Code signing: still the GA blocker. macOS is tracked in issue **#75** (the `mac` build block is prepared but inert; blocked on the Developer ID certificate). Windows / Linux / CI-vs-local questions remain in `docs/code-signing-decisions.md`
- **4.3** -- Cloud consent banner implemented (per-session, covers remote Ollama). **Renderer-only** — see audit item 17 below
- **4.4** -- Anti-hallucination system prompts done. OCR quality reports (per-document + corpus) done. Path A benchmark harness exists but gold-standard corpus not yet built.
- **4.5** -- **Done 2026-07-18/19**: environmental suites guarded by `skipIf`, the 8 failures those guards were hiding fixed, and a CI job now runs the suite on the Node ABI so the guards cannot hide a regression

### Additional work done (outside the plan)
- OCR quality reports: per-document + corpus-wide (confidence, chunk quality, histogram)
- Recipe editor (form-based + CodeMirror YAML since the CM6 migration)
- Spatial canvas/board view for ideas
- Knowledge graph for ideas + entities
- **AI usage journal** (merged): separate `journal.db`, provider-registry
  capture hook, CLI, exports, Cmd/Ctrl+J modal — see ADR 0007
- **Editor migration to CodeMirror 6** (merged, phases 0-5 complete,
  2026-07-16→18): Milkdown and Monaco removed, live rendering, Lezer
  footnote/pandoc-citation extensions, proposal contract (changeOrigin +
  adjudication journaling), −4.7 MB renderer bundle. See
  `docs/editor-architecture.md`, `docs/editor-proposals.md`,
  `docs/archive/PLAN_migration-editeur-cm6.md`
- **Book chapters** (merged, phases 1-5 complete, 2026-07-19):
  the `book` project type is no longer an empty shell — multi-file chapter
  manifest with disk reconciliation, chapter panel, per-chapter editor state
  cache (undo survives switching), manuscript outline, manuscript-wide
  footnote renumbering / citation check / statistics, per-book settings
  (note style and numbering, bibliography placement, heading numbering), and
  assembly-based PDF/Word exports with per-chapter footnote namespacing.
  See `docs/book-architecture.md`, `docs/archive/PLAN_chapitres-livre.md`
- **Chat unification** (merged, fusion step 5): a single `AssistantChat` shell
  (variants `full` / `panel`) over the shared `chat-engine.ts`
- **Slides unification** (merged): presentations edit in the single CM6 editor
  (`src/editor/slides.ts`)
- **Manuscript as a fourth RAG corpus** (merged): `manuscript_*` tables in
  `brain.db`, incremental by content hash, indexed after save, surfaced to the
  assistant with its own `manuscrit` source kind. See `docs/manuscript-corpus.md`
- **Manuscript-wide search** (merged): `src/renderer/src/services/manuscript-search.ts`
  + `components/Book/ManuscriptSearch.tsx` — the item deferred from book phase 3
- **ESLint configuration** (merged, #36): `npm run lint` works and gates CI at
  0 errors
- **Test CI** (merged): `.github/workflows/tests.yml` — build, typecheck (×3
  projects), vitest on the **Node ABI**, lint, and a skipped-test summary
- **July 2026 bug campaign** (merged): 31 issues triaged with adversarial
  verification, PRs #41–#74. Root pattern found: *re-reading live singleton
  state after an await* on project switch

---

## 2. What remains to do

### High priority (blocking v2.0 GA)

| # | Type | Description | User action? |
|---|---|---|---|
| 4.2 | Security | Code signing. macOS = issue **#75** (wiring plan written; blocked on the Developer ID certificate). Windows Authenticode still undecided | Yes -- Apple Developer account + budget |
| 4.4 | Backend | Path A benchmark: build a gold-standard corpus (>=30 queries with relevance judgments) to gate the unified vector store migration | Yes -- historian judgment needed |
| -- | Backend | 144 chunks with missing embeddings (5880 indexed, 5736 with embeddings) -- investigate and repair. *Observed on one corpus in May 2026; not re-measured since* | No |
| 17 | Security | Cloud-consent guard is **renderer-only** (`cloudConsentStore`, `useCloudConsentGuard`). A main-process caller can reach a cloud provider without passing it. Carried over from the July audits | No |
| 18 | Security | `fusion-handlers.ts` has 30 `ipcMain.handle` registrations and only a handful of `validate()` calls. Carried over from the July audits | No |
| 16 | Security | The user is still **not warned** when `safeStorage` is unavailable and keys fall back to plaintext (ADR 0006 documents the behaviour; the Settings security section does not surface it) | No |

### Medium priority (quality + completeness)

| # | Type | Description | User action? |
|---|---|---|---|
| 23 | Frontend | ~167 hardcoded colours outside `index.css` (where the token definitions legitimately live) -- `Similarity/*`, `TopicTimeline` chart palette, `CorpusExplorerPanel`. Carried over from the July audits | No |
| -- | Frontend | 8 remaining `any` in the renderer (down from ~79) | No |
| -- | Backend | Publish `@cliodeck/lezer-footnotes` and `@cliodeck/lezer-pandoc-citations` to npm. Both are **packaged** under `packages/` at v0.1.0 under MIT, and neither is published yet | Yes -- npm account |
| -- | Backend | Electron auto-update via `electron-updater` (not a dependency yet) | No |

### Low priority (nice-to-have for v2.0, can be v2.1)

| Type | Description |
|---|---|
| Design | Installer strategy (`docs/installer-strategy.md`): embedded Ollama, first-run wizard, bundled Pandoc/tectonic. Nothing in its section 7 has been built |
| Backend | Book: index (`\index{}`) and typed cross-references — same technical family as footnotes/citations (Lezer extension + resolution at assembly) |
| Backend | Book: Word export ignores `noteStyle`/`noteNumbering` (LaTeX path only) |
| Frontend | Manuscript corpus: no UI at all — no index state, no re-index button, no `rag.indexManuscript` toggle in preferences (the service reads the setting; nothing writes it) |
| Backend | Manuscript corpus: changing the embedding model invalidates the index; `reindexAll()` exists but no trigger calls it |
| Backend | MCP tool-use: the 6-turn agent-loop cap is hardcoded and untuned (ADR 0003) |
| Frontend | Book: pending AI proposals expire on chapter switch (accepted limit, book phase 2) |
| Backend | `pdf-service.ts` is 839 lines and still a delegating facade for search |

Delivered since this list was written, and removed from it: multi-chapter
search, manuscript RAG indexing, the Brainstorm flagged-sources badge (#8),
the Brainstorm→Write drafts panel (#7), `searchEuropeana` registration (it is
wired in `backend/mcp-server/server.ts`, reading its key at call time), and the
recipe kind `brainstorm` (`llmHandler('brainstorm')` in `backend/recipes/runner.ts`).

Fixed on 2026-07-25 while auditing the docs: manuscript extracts had **no
click-through** — `SourcePopover`'s `canOpen` excluded `sourceType:
'manuscript'`, disabling "Ouvrir la source" on the author's own text. Routing it
through the existing `sources:open-note` channel would have resolved the path
against the Obsidian vault, so it got its own in-app route
(`services/open-manuscript-source.ts`). See `docs/source-traceability.md`.

---


### Angle mort de la « CI verte » — 8 échecs corrigés, CI créée

> **Résolu.** La marche à suivre décrite ci-dessous a été appliquée :
> `.github/workflows/tests.yml` recompile `better-sqlite3` pour l'ABI Node
> avant de lancer la suite, et enchaîne build → typecheck (racine, main,
> preload) → vitest → lint → récapitulatif des tests sautés. La section reste
> ici parce que la **leçon** vaut au-delà du cas : un filet ne vérifie que ce
> qu'il sait voir. Les deux consignes toujours actives sont la dernière
> (ne pas supprimer les gardes) et l'avertissement final sur la restauration
> de l'ABI Electron en local.

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

**La CI elle-même — fait.** `.github/workflows/tests.yml` (créé 2026-07)
exécute la marche à suivre ci-dessous. Elle est conservée comme
justification du workflow, à relire avant toute modification de celui-ci :

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
- **No red suites left**: the 6 Brainstorm jsdom failures were fixed
  (missing `window.electron.config` mock, 2026-07-18) and the 8 sqlite-ABI
  failures in 2026-07-19. What remains are 68 legitimate **skips** — suites
  guarded on the native binding or on a live Ollama
  (`backend/__tests__/helpers/native-guards.ts`)
- **`pdf-service.ts`** remains a delegating facade for search — down to 839
  lines from 1084, still mixing indexing and graph building
- **~414 lint warnings** (`no-explicit-any`, `react-hooks/exhaustive-deps`,
  unused vars): the stock to work off rule by rule. CI gates errors at 0 and
  lets warnings through deliberately
- **Path B (parallel stores)** continues to ship; Path A unification is gated
  on benchmark — and now has **three** parallel stores to absorb (Obsidian
  vault, primary sources, manuscript) rather than two

---

## 4. Files reference

Live documents — what is true now:

| Document | Purpose |
|---|---|
| `docs/adr/0001-0007` | Architecture Decision Records (RAG, retrieval, MCP, providers, threat model, credentials, usage journal). Next free number: **0008** |
| `docs/editor-architecture.md` | CM6 editor architecture |
| `docs/editor-proposals.md` | AI proposal contract — no AI writing feature bypasses it |
| `docs/book-architecture.md` | The `book` project type: manifest, assembly, exports |
| `docs/manuscript-corpus.md` | The manuscript as a fourth RAG corpus |
| `docs/journal-usage-ia.md` | AI usage journal — two-layer model, schema, philosophy |
| `docs/source-traceability.md` | Brainstorm citation click-through design |
| `docs/path-a-readiness.md` | RAG benchmark gate for unified vector store |
| `docs/code-signing-decisions.md` | Open code-signing questions (macOS = issue #75) |
| `docs/installer-strategy.md` | Distribution plan (mode B slim installer recommended) — still unbuilt |
| `docs/linux-sandbox.md` | Linux sandboxing instructions (user-facing) |
| `docs/archive/` | Dated snapshots: completed plans, closed audits, delivered specs. See its `README.md` |

Archived on 2026-07-25 (were listed here before): the three audits of
2026-07-19, the book-chantier retrospective, and the usage-journal
implementation brief — all point-in-time documents whose work is done.
