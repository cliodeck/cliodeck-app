# ADR 0001 — RAG pipeline arbitration: keep ClioDeck, defer full unification

Status: accepted — 2026-04-13
Context: fusion step 2.4 (see `docs/fusion-cliobrain-implementation-plan.md`)

## Decision

On the RAG pipeline consolidation, **keep ClioDeck's implementations** of `HybridSearch`, `BM25Index`, `ContextCompressor`, and `VectorStore`. Do **not** swap to the ClioBrain equivalents as the plan text suggested.

## Rationale

After comparing both codebases head-to-head:

| Parameter | ClioBrain | ClioDeck |
|---|---|---|
| RRF K | 60 | 60 |
| Dense retrieval weight | 0.6 | 0.6 |
| Sparse retrieval weight | 0.4 | 0.4 |
| HybridSearch LOC | 155 | 241 |
| BM25Index LOC | 138 | 239 |
| ContextCompressor LOC | 171 | 316 |

Key findings:

1. **Algorithmic convergence**: both codebases already use RRF K=60 with 60/40 dense/sparse weighting. The plan's headline claim ("Adopter le pipeline ClioBrain") was written against the module map (step 0.2) rather than the source; the sources converge.
2. **ClioDeck is strictly richer**:
   - `HybridSearch` renormalizes weights automatically on `setWeights(...)`; the ClioBrain version does not.
   - `ContextCompressor` has four strategies (incl. query-aware sentence extraction that preserves chunks containing query terms); ClioBrain has three threshold bands (light / medium / aggressive).
   - `BM25Index` has more thorough tokenization and position tracking.
3. **No meaningful behavioral gap on the happy path** — a switch would be pure churn for less functionality.

## What's preserved from ClioBrain

The following ideas came through the fusion and are already incorporated elsewhere:

- **Three-level compression threshold model** (15k / 30k char bands) — already reconciled inside ClioDeck's richer compressor; its `small/medium/aggressive` strategy selection covers the same cases with additional query-awareness.
- **`ContextCompressor` applied to `SearchResult` streams** — this call pattern is the one `HybridSearch` already feeds; no change needed.

## What is actually still to do on 2.4

The plan's "branching chunking PDF/OCR de ClioDeck en amont" is partly a non-issue (ClioDeck is already upstream), but one real dependency remains:

**`ObsidianVaultIndexer` reactivation** (deferred from step 2.1).

The indexer was not ported in 2.1 because it consumes `DocumentChunk` / `VectorStore` / `BM25Index` / `OllamaClient` types that are PDF-centric in ClioDeck (`PDFDocument.pageCount`, `DocumentChunk.pageNumber`). Reactivating it requires one of:

- **Path A — generalise** `PDFDocument` → `SourceDocument` with a `sourceType` discriminant across the entire vector-store surface. Touches `EnhancedVectorStore`, `HNSWVectorStore`, `PrimarySourcesVectorStore`, IPC handlers, renderer search components. 1–2 days, high blast radius.
- **Path B — parallel store** (now tracked as step 2.4b): give the Obsidian indexer its own SQLite + HNSW files under `.cliodeck/v2/obsidian-vectors.db`, independent of the PDF vector store. Unification to Path A happens when its value exceeds the cost — likely after Phase 3 UI surfaces both sources in Brainstorm.

We proceed with **Path B** first to unblock Phase 3, reserving Path A for a dedicated PR with a benchmark (per the fusion plan's risks table: "Divergence qualité RAG après fusion 2.4 — Élevé").

## Consequences

- The plan's section 2.4 text is superseded by this ADR; follow-up commits reference 2.4b (Path B) instead of a literal "adopt ClioBrain" swap.
- A RAG benchmark (ClioDeck PDF pipeline before vs after any future unification) becomes a blocking artifact for Path A. It does not block 2.4b.
- ClioBrain's `DocumentIngestionPipeline` is not ported — ClioDeck already has `pdf-service.ts` fulfilling that role for PDFs. A parallel `obsidian-service.ts` arrives with 2.4b.
