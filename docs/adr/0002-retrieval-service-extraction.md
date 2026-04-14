# ADR 0002 — Extract RetrievalService from pdf-service

Status: accepted — 2026-04-14
Context: fusion phase B/C (Brainstorm chat reuse + Obsidian vault as third source)

## Context

The legacy retrieval pipeline — multilingual query expansion, embedding cache, hybrid HNSW+BM25 over PDFs, and primary Tropy search — lived entirely inside `pdf-service.ts`. That file had grown to 1084 lines, mixing four distinct responsibilities: PDF indexing, search, embedding cache management, and graph building.

The Brainstorm chat (fusion step B) needed to run the same retrieval against the same indexes, but could not reuse the pipeline without dragging in PDF ingestion code and its singleton state. Copying the search path into `fusion-chat-service` would have forked the algorithm within a month.

## Decision

Extract the retrieval pipeline into a standalone `RetrievalService`. `pdf-service.search` becomes a thin facade that delegates to `retrievalService`. `fusion-chat-service` calls `retrievalService` directly.

The service is configured per-project via `configure(projectContext)` before any search call. The method chain is: query expansion → embedding (with cache) → dense HNSW + sparse BM25 → RRF fusion → primary Tropy overlay.

The unification made it straightforward to add the Obsidian vault as a third source via a `includeVault?: boolean` flag on the search options — the vault store plugs into the same fusion step rather than running as a parallel pipeline.

## Consequences

- `pdf-service.search` is a delegation shim; the 1084-line file shrinks toward its actual responsibility (PDF ingestion + graph).
- `fusion-chat-service` no longer imports `pdf-service` for retrieval; the two chat surfaces (legacy and Brainstorm) now share one code path.
- Adding the Obsidian vault was a matter of wiring a third store into `retrievalService` rather than a second full pipeline (unlike the parallel-store path considered in ADR 0001 for 2.4b — that store still exists, but `retrievalService` is what actually reads it at query time).
- Tests that exercised retrieval through `pdf-service` keep passing via the facade; new tests target `retrievalService` directly.

### Trade-offs (honest)

- **`configure()` injection adds runtime coupling.** The service must be configured per-project before any search call works; a call before `configure()` throws. This is simpler than threading project context through every call signature, but it makes the error mode "forgot to configure" rather than "type error at compile time."
- **Stateful singleton.** The service holds per-project caches and store handles. If the app ever supports multiple open projects simultaneously, this becomes a refactor — the singleton would need to become a keyed registry, and every caller would need the key. Today's "one project open at a time" invariant is load-bearing.
- **Embedding cache lifetime is tied to the singleton**, not to the project. Switching projects requires explicit reset; we rely on `configure()` to clear. A missed reset would serve stale vectors.

## References

- `0fea996` — B1: pure extraction, no behavior change (the mechanical move; diff is mostly cut/paste with import fixes).
- `07c6586` — B2: brainstorm wiring; `fusion-chat-service` switches off `pdf-service` for retrieval.
- `fd6cb45` — C: Obsidian vault as third source via `includeVault?: boolean`.
- ADR 0001 — RAG pipeline arbitration (the parallel Obsidian store this service now reads from).
