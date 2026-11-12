/**
 * RAG benchmark harness (fusion step 2.4a — gate artifact per ADR 0001).
 *
 * Measures retrieval quality on a fixed (corpus, queries, gold-standard
 * judgments) triple. Any change to the vector-store surface, chunking
 * preset, ranking weights, or compressor thresholds MUST pass this
 * harness before merging to `feat/fusion-cliobrain` — per the risk
 * table in the plan ("Divergence qualité RAG après fusion 2.4 — Élevé").
 *
 * Metrics reported:
 *   - `recall@K` for K ∈ {1, 3, 5, 10} — rappel : pour chaque question, la
 *     part de ses extraits pertinents rendus dans le top K, moyennée
 *   - `hitRate@K` — taux de succès : la part des questions qui ont au moins un
 *     pertinent dans le top K. C'est ce que `recall` publiait jusqu'en 2026-11
 *     (S04-1-20) : un relevé antérieur se compare sur `hitRate`.
 *   - `mrr` (mean reciprocal rank of the first relevant hit)
 *   - latency percentiles (p50 / p95)
 *
 * Retrieval is abstracted behind a `Retriever` interface so the harness
 * is pipeline-agnostic — the ClioDeck legacy vector store, the Obsidian
 * parallel store, a future unified store, and any dev prototype all
 * implement the same shape and can be compared head-to-head.
 *
 * Scope for this commit: the harness + a tiny synthetic fixture to
 * sanity-check the implementation. Real gold-standard corpora
 * (historian-curated query/doc pairs) are provided by the user through
 * the same interface when the swap PR lands.
 */

export interface BenchmarkDoc {
  id: string;
  /** Chunks belonging to the document. Chunk ids are globally unique. */
  chunks: Array<{ id: string; content: string }>;
}

export interface BenchmarkQuery {
  id: string;
  text: string;
  /** Chunk ids considered relevant. Order doesn't matter. */
  relevant: string[];
}

export interface BenchmarkHit {
  chunkId: string;
  /** Any numeric score — higher = more relevant. */
  score: number;
}

export interface Retriever {
  /** Called once at setup. Retriever loads / indexes the corpus. */
  index(docs: BenchmarkDoc[]): Promise<void>;
  /** Called per query. Returns top-K hits. */
  search(queryText: string, topK: number): Promise<BenchmarkHit[]>;
  /** Optional cleanup hook. */
  close?(): Promise<void>;
}

export interface BenchmarkResult {
  /** Rappel : part des extraits pertinents d'une question rendus dans le top K, moyennée. */
  recall: Record<number, number>;
  /** Taux de succès : part des questions qui ont au moins un pertinent dans le top K. */
  hitRate: Record<number, number>;
  mrr: number;
  latencyMs: { p50: number; p95: number; mean: number };
  queryCount: number;
  perQuery: Array<{
    queryId: string;
    firstRelevantRank: number | null;
    /** Extraits pertinents distincts parmi les `hitsConsidered` rendus. */
    relevantFound: number;
    relevantCount: number;
    hitsConsidered: number;
    latencyMs: number;
  }>;
}

export interface RunBenchmarkOptions {
  docs: BenchmarkDoc[];
  queries: BenchmarkQuery[];
  retriever: Retriever;
  ks?: number[];
  /** Hard cap on topK retrieved per query (should be ≥ max(ks)). */
  maxTopK?: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * (sorted.length - 1))
  );
  return sorted[idx];
}

export async function runBenchmark(
  opts: RunBenchmarkOptions
): Promise<BenchmarkResult> {
  const ks = (opts.ks ?? [1, 3, 5, 10]).slice().sort((a, b) => a - b);
  const maxTopK = opts.maxTopK ?? Math.max(...ks, 10);

  await opts.retriever.index(opts.docs);

  const successes: Record<number, number> = Object.fromEntries(
    ks.map((k) => [k, 0])
  );
  const recallSums: Record<number, number> = Object.fromEntries(
    ks.map((k) => [k, 0])
  );
  let mrrSum = 0;
  const latencies: number[] = [];
  const perQuery: BenchmarkResult['perQuery'] = [];

  for (const q of opts.queries) {
    const relevantSet = new Set(q.relevant);
    const started = Date.now();
    const hits = await opts.retriever.search(q.text, maxTopK);
    const latency = Date.now() - started;
    latencies.push(latency);

    // Rang (1 = premier) de chaque pertinent rendu, une fois chacun : un
    // retriever qui rend deux fois le même extrait ne le compte pas double.
    const foundRanks: number[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < hits.length; i++) {
      const id = hits[i].chunkId;
      if (relevantSet.has(id) && !seen.has(id)) {
        seen.add(id);
        foundRanks.push(i + 1);
      }
    }
    const firstRank = foundRanks.length > 0 ? foundRanks[0] : null;

    if (firstRank !== null) {
      mrrSum += 1 / firstRank;
      for (const k of ks) {
        if (firstRank <= k) successes[k] += 1;
      }
    }
    // Une question sans pertinent compte 0, comme pour le taux de succès.
    if (relevantSet.size > 0) {
      for (const k of ks) {
        recallSums[k] += foundRanks.filter((rank) => rank <= k).length / relevantSet.size;
      }
    }

    perQuery.push({
      queryId: q.id,
      firstRelevantRank: firstRank,
      relevantFound: foundRanks.length,
      relevantCount: relevantSet.size,
      hitsConsidered: hits.length,
      latencyMs: latency,
    });
  }

  await opts.retriever.close?.();

  const queryCount = opts.queries.length || 1;
  const recall: Record<number, number> = {};
  const hitRate: Record<number, number> = {};
  for (const k of ks) {
    recall[k] = recallSums[k] / queryCount;
    hitRate[k] = successes[k] / queryCount;
  }

  const sorted = latencies.slice().sort((a, b) => a - b);
  const mean =
    latencies.reduce((s, v) => s + v, 0) / (latencies.length || 1);

  return {
    recall,
    hitRate,
    mrr: mrrSum / queryCount,
    latencyMs: {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      mean,
    },
    queryCount,
    perQuery,
  };
}

/**
 * Compare two results; useful for before/after diffs in CI / local
 * experiments. Returns a plain object with deltas so a human can scan it
 * without needing to know the metric structure.
 */
export function diffResults(
  before: BenchmarkResult,
  after: BenchmarkResult
): {
  recallDelta: Record<number, number>;
  hitRateDelta: Record<number, number>;
  mrrDelta: number;
  meanLatencyDelta: number;
} {
  const recallDelta: Record<number, number> = {};
  const hitRateDelta: Record<number, number> = {};
  for (const k of Object.keys(before.recall)) {
    const kn = Number(k);
    recallDelta[kn] = (after.recall[kn] ?? 0) - before.recall[kn];
    hitRateDelta[kn] = (after.hitRate[kn] ?? 0) - before.hitRate[kn];
  }
  return {
    recallDelta,
    hitRateDelta,
    mrrDelta: after.mrr - before.mrr,
    meanLatencyDelta: after.latencyMs.mean - before.latencyMs.mean,
  };
}
