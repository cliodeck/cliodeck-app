# Path A readiness — RAG benchmark gate

Status: scaffolded — 2026-04-14

## What Path A is

Per [ADR 0001](adr/0001-rag-pipeline-arbitration.md), Path A is the
unification of the Obsidian vault store (`.cliodeck/v2/obsidian-vectors.db`,
parallel) into the main `EnhancedVectorStore`
(`.cliodeck/vectors.db`) using the generalised
[`SourceDocument` / `SourceChunk` types](../backend/types/source-document.ts).

The migration itself is a schema change + a rewrite of every consumer that
narrows on `PDFDocument`. ADR 0001 gates the swap on a benchmark that
proves equivalent retrieval quality before vs after.

## What ships in this commit

- **`cliodeck rag-benchmark`** — CLI command driving `runBenchmark`
  ([`backend/core/rag/benchmark.ts`](../backend/core/rag/benchmark.ts))
  on a user-supplied corpus + queries fixture.
- **`inMemoryBM25Retriever`** ([source](../backend/core/rag/retrievers/in-memory-bm25.ts))
  — deterministic, dependency-free Okapi BM25 baseline. Useful for
  validating the harness end-to-end and for measuring how much hybrid
  search adds on top of pure lexical retrieval.

What is **not** shipped: a real `EnhancedVectorStoreRetriever` adapter.
That requires wiring an embedding provider through the CLI (Ollama or a
cloud key), and the comparison only makes sense once the unified store
exists. Both arrive in the swap PR.

## What the user must supply

A pair of JSON files:

### `corpus.json`
```json
[
  {
    "id": "d1",
    "chunks": [
      { "id": "d1-c1", "content": "<chunk text>" },
      { "id": "d1-c2", "content": "<chunk text>" }
    ]
  }
]
```
Match the `BenchmarkDoc` type:

```ts
interface BenchmarkDoc {
  id: string;
  chunks: Array<{ id: string; content: string }>;
}
```

### `queries.json`
```json
[
  {
    "id": "q1",
    "text": "<query as the historian would type it>",
    "relevant": ["d1-c1", "d2-c3"]
  }
]
```
Match the `BenchmarkQuery` type:

```ts
interface BenchmarkQuery {
  id: string;
  text: string;
  relevant: string[];   // chunk ids judged relevant by a human
}
```

`relevant` is the gold-standard signal. **Quality of the benchmark =
quality of these judgments.** Anything below ~30 queries with explicit
relevance judgments is too noisy to ship a Path A decision on.

## Running

Build first (the CLI lives in `dist/scripts/cliodeck-cli.js` after build):

```bash
npm run build
node dist/scripts/cliodeck-cli.js rag-benchmark \
  --corpus path/to/corpus.json \
  --queries path/to/queries.json
```

Output is JSON: `recall@K`, `mrr`, `latencyMs.p50/p95/mean`, plus a
per-query breakdown (so you can see which queries the retriever misses).

## What "ready for Path A" means

The migration PR can land when:

1. A user-supplied gold standard exists (≥30 queries, judged by a
   historian familiar with the corpus).
2. `cliodeck rag-benchmark --retriever bm25` produces a baseline.
3. The Path A retriever — once implemented — produces results within
   ε of the baseline (for `recall@10` and `mrr`), and stays under the
   p95 latency target.

Until those three exist, the parallel-store layout (Path B) stays
shipping. There is no behavioural cost to Path B for end users — the
unified `RetrievalService` already routes both stores transparently
(see [ADR 0002](adr/0002-retrieval-service-extraction.md)). Path A is
purely an internal cleanup whose value is removing one duplicated
schema, not a feature unlock.
