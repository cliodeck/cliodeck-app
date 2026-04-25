# Archive — implementation snapshots

These documents are *snapshots* of how a feature was built — useful as
historical context (the data flow, the migration approach, the
rationale of trade-offs) but not the place to look for what's left to
do or what's currently true.

For the current architecture, see the top-level `docs/` folder; for the
forward-looking roadmap, see [`../plan-post-fusion.md`](../plan-post-fusion.md).

## What's here

| File | Captures | Caveats |
|---|---|---|
| `archival-metadata.md` | The **archival metadata** layer for primary sources (`repository`, `fonds`, `callNumber`, `producer`…) — what landed, schema migration approach, integration points. | The "what's still to do" list is *not* tracked in `plan-post-fusion.md`. Treat it as a domain-specific TODO that ships a follow-up PR; check the actual code (`backend/types/archival-metadata.ts`, `backend/integrations/tropy/TropySync.ts`) for ground truth. |
| `citation-integration.md` | The **CSL citation engine** scaffold — `citeproc-js` wiring, BibTeX→CSL adapter, the `CitationEngine.ts` API surface. | **Partially out of date.** Several "what remains to wire" items have shipped since (notably `CitationStyleSection.tsx` is in `ConfigPanel.tsx`, MilkdownEditor's autocomplete is wired). Check the actual files before assuming a TODO is open. |

## When to consult these vs. the live docs

Read the snapshot if you need to understand **why** something is shaped
the way it is — what alternatives were considered, what data flow was
chosen, what migration was performed.

Read the live doc / code if you need to know **what is true now**.

A snapshot is moved here when it stops driving day-to-day decisions, so
the top-level `docs/` folder stays focused on the active roadmap.
