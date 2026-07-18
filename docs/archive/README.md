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
| `journal-usage-ia-reperage.md` | Pre-implementation scouting for the AI usage journal (insertion points, provider registry decision). Feature shipped. |

## When to consult these vs. the live docs

Read the snapshot if you need to understand **why** something is shaped
the way it is — what alternatives were considered, what data flow was
chosen, what migration was performed.

Read the live doc / code if you need to know **what is true now**.

A snapshot is moved here when it stops driving day-to-day decisions, so
the top-level `docs/` folder stays focused on the active roadmap.
