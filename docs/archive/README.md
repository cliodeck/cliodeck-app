# Archive — implementation snapshots

These documents are *snapshots* of how a feature was built — useful as
historical context (the data flow, the migration approach, the
rationale of trade-offs) but not the place to look for what's left to
do or what's currently true.

For the current architecture, see the top-level `docs/` folder.

## What's here

| File | Captures |
|---|---|
| `fusion-cliobrain-implementation-plan.md` | The original step-by-step fusion plan (phases 0-4). All phases 0-3 completed. |
| `fusion-cliobrain-strategy.md` | Strategic rationale for absorbing ClioBrain into ClioDeck. |
| `plan-post-fusion.md` | Post-fusion audit and roadmap (phases 0-3 of the post-audit). All completed. |
| `actions-frederic.md` | Step-by-step list of human decisions needed during phases 0-3. All resolved. |
| `i18n-fusion-1.4b-review.md` | i18n review checklist for the 5 fusion sections. Accepted as-is. |
| `research-ollama-tools-1.8.md` | Research on Ollama tool-use model compatibility (step 1.8). |
| `research-historians-desktop.md` | Research note on Greenstreet's "Historian's Desktop" — inspired onboarding (2.9/2.10). |
| `archive-mcp-connectors.md` | Design doc for MCP archive connectors (Gallica, HAL, Europeana, etc.). |
| `archival-metadata.md` | The archival metadata layer for primary sources. |
| `citation-integration.md` | The CSL citation engine scaffold. |
| `PLAN_migration-editeur-cm6.md` | The CM6 editor migration plan (phases 0-5, arbitrations resolved 2026-07-16). All phases completed 2026-07-18. |
| `migration-cm6.md` | Working log of the CM6 migration: inventory, fidelity corpus, per-phase tracking, parity checklist (10/10). Superseded by `docs/editor-architecture.md`. |
| `PLAN_chapitres-livre.md` | The multi-file book chapters plan (phases 0-5, editorial arbitrations settled 2026-07-19). All phases completed. Current architecture: `docs/book-architecture.md`. |
| `journal-usage-ia-reperage.md` | Pre-implementation scouting for the AI usage journal (insertion points, provider registry decision). Feature shipped. |
| `chat-unification-etat-des-lieux.md` | State of play before merging the two chat shells (fusion step 5). Chantier done — see the unified `AssistantChat`. |
| `slides-etat-des-lieux.md` | State of play before folding presentations into the single editor. Chantier done. |
| `book-etat-des-lieux.md` | State of play before the multi-file chapters chantier: what was hollow, what was broken. Superseded by `docs/book-architecture.md`. |
| `TODO_barre-stats-document.md` | Document stats bar debts (i18n, regex counting). Both settled during the CM6 follow-ups. |
| `audits-2026-07-19.md` | The three parallel audits (security, UI, code coherence) on `main` @ `8df0a42`. Priority 1 and 2 fully resolved by the July 2026 campaign; the four survivors are tracked in `status-and-remaining-work.md`. **Its lesson outlives it: a green check only verifies what it can see.** |
| `bilan-chantier-livre.md` | End-to-end retrospective of the multi-file chapters chantier: the pandoc measurement that dictated the assembly strategy, and the seven bugs found on the way. Current architecture: `docs/book-architecture.md`. |
| `INSTRUCTIONS_journal-usage-ia.md` | The implementation brief for the AI usage journal — feature shipped. Kept for its arbitrations (§1 the imperative separation from the research journal, §7 the settled points), which remain binding. Current doc: `docs/journal-usage-ia.md`. |

## Dangling references inside these snapshots

Two snapshots cite documents that were **planned but never written**:
`docs/dev-setup.md` (from `actions-frederic.md`) and
`docs/fusion-cliobrain-module-map.md` / `docs/fusion-cliobrain-state-snapshot.md`
(from `fusion-cliobrain-implementation-plan.md`). They are absent from the git
history — nothing to link to. Left as-is rather than invented; do not spend
time looking for them.

Every other cross-reference in this folder was repointed to `docs/archive/…`
on 2026-07-25, when the paths broke by the files being archived.

## When to consult these vs. the live docs

Read the snapshot if you need to understand **why** something is shaped
the way it is — what alternatives were considered, what data flow was
chosen, what migration was performed.

Read the live doc / code if you need to know **what is true now**.

A snapshot is moved here when it stops driving day-to-day decisions, so
the top-level `docs/` folder stays focused on the active roadmap.
