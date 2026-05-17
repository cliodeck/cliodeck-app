/**
 * cliodeck rag-benchmark — gate artifact for Path A (ADR 0001).
 *
 * Runs `runBenchmark` over a user-supplied corpus/queries fixture. Today
 * the only retriever shipped here is `bm25` (in-memory, deterministic) —
 * enough to validate the harness end-to-end against any user-curated
 * gold standard. A `hybrid` retriever wiring the project's
 * EnhancedVectorStore + an embedding provider lands when the Path A
 * migration is ready to swap stores; the harness contract is stable.
 *
 * Output: JSON BenchmarkResult on stdout. Exit codes follow the
 * cliodeck CLI convention (0 / 1 / 2).
 */

import fs from 'fs/promises';
import {
  runBenchmark,
  type BenchmarkDoc,
  type BenchmarkQuery,
} from '../../backend/core/rag/benchmark.js';
import { inMemoryBM25Retriever } from '../../backend/core/rag/retrievers/in-memory-bm25.js';
import type { ParsedArgs } from './args.js';

const USAGE =
  'usage: cliodeck rag-benchmark --corpus <docs.json> --queries <queries.json>\n' +
  '                              [--retriever bm25] [--topK 10]\n';

interface RetrieverFactoryEntry {
  name: string;
  description: string;
  build(): ReturnType<typeof inMemoryBM25Retriever>;
}

const RETRIEVERS: Record<string, RetrieverFactoryEntry> = {
  bm25: {
    name: 'bm25',
    description: 'In-memory Okapi BM25 (deterministic, no external dependency)',
    build: () => inMemoryBM25Retriever(),
  },
};

async function readJson<T>(path: string): Promise<T> {
  const raw = await fs.readFile(path, 'utf8');
  return JSON.parse(raw) as T;
}

export async function cmdRagBenchmark(args: ParsedArgs): Promise<number> {
  const corpusPath = args.flags.corpus;
  const queriesPath = args.flags.queries;
  const retrieverName = (args.flags.retriever as string) || 'bm25';
  const topK = args.flags.topK ? Number(args.flags.topK) : undefined;

  if (!corpusPath || !queriesPath) {
    process.stderr.write(USAGE);
    return 2;
  }
  const factory = RETRIEVERS[retrieverName];
  if (!factory) {
    process.stderr.write(
      `Unknown retriever "${retrieverName}". Available: ${Object.keys(RETRIEVERS).join(', ')}\n`
    );
    return 2;
  }

  let docs: BenchmarkDoc[];
  let queries: BenchmarkQuery[];
  try {
    docs = await readJson<BenchmarkDoc[]>(corpusPath);
    queries = await readJson<BenchmarkQuery[]>(queriesPath);
  } catch (e) {
    process.stderr.write(
      `Failed to load fixtures: ${e instanceof Error ? e.message : String(e)}\n`
    );
    return 1;
  }
  if (!Array.isArray(docs) || !Array.isArray(queries)) {
    process.stderr.write('Corpus and queries must each be JSON arrays.\n');
    return 1;
  }

  try {
    const result = await runBenchmark({
      docs,
      queries,
      retriever: factory.build(),
      maxTopK: topK,
    });
    process.stdout.write(
      JSON.stringify(
        {
          retriever: factory.name,
          description: factory.description,
          ...result,
        },
        null,
        2
      ) + '\n'
    );
    return 0;
  } catch (e) {
    process.stderr.write(
      `Benchmark failed: ${e instanceof Error ? e.message : String(e)}\n`
    );
    return 1;
  }
}
