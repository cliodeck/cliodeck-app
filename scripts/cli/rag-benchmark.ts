/**
 * cliodeck rag-benchmark — gate artifact for Path A (ADR 0001).
 *
 * Runs `runBenchmark` over a user-supplied corpus/queries fixture. Deux
 * retrievers, lexicaux et déterministes, sans fournisseur d'embeddings :
 *   - `bm25` — le BM25 en mémoire du banc, avec son propre tokeniseur ;
 *   - `pdf-lexical` — la part lexicale de la recherche des PDF, par le vrai
 *     `BM25Index` et la fusion de `HybridSearch` (`pdf-lexical.ts`) : c'est
 *     lui qui voit un changement de la recherche de l'app.
 * A `hybrid` retriever wiring the project's EnhancedVectorStore + an
 * embedding provider lands when the Path A migration is ready to swap
 * stores; the harness contract is stable.
 *
 * Output: JSON BenchmarkResult on stdout (`recall` et `hitRate` côte à
 * côte). Exit codes follow the cliodeck CLI convention (0 / 1 / 2).
 */

import fs from 'fs/promises';
import {
  runBenchmark,
  type BenchmarkDoc,
  type BenchmarkQuery,
  type Retriever,
} from '../../backend/core/rag/benchmark.js';
import { inMemoryBM25Retriever } from '../../backend/core/rag/retrievers/in-memory-bm25.js';
import type { ParsedArgs } from './args.js';

const USAGE =
  'usage: cliodeck rag-benchmark --corpus <docs.json> --queries <queries.json>\n' +
  '                              [--retriever bm25|pdf-lexical] [--topK 10]\n';

interface RetrieverFactoryEntry {
  name: string;
  description: string;
  build(): Promise<Retriever>;
}

const RETRIEVERS: Record<string, RetrieverFactoryEntry> = {
  bm25: {
    name: 'bm25',
    description: 'In-memory Okapi BM25 (deterministic, no external dependency)',
    build: async () => inMemoryBM25Retriever(),
  },
  'pdf-lexical': {
    name: 'pdf-lexical',
    description:
      "Part lexicale de la recherche des PDF : BM25Index et fusion HybridSearch de l'app, sans embedding",
    // Chargé à la demande : `natural`, qu'importe `BM25Index`, charge `dotenv`, dont la bannière
    // s'écrit sur stdout. Importé en tête, il la mettait devant la sortie de toutes les commandes.
    build: async () =>
      (await import('../../backend/core/rag/retrievers/pdf-lexical.js')).pdfLexicalRetriever(),
  },
};

/**
 * `BM25Index` et `HybridSearch` écrivent leur trace par `console.log`, donc sur stdout, comme la
 * bannière de `dotenv` au chargement : tout passe sur stderr le temps du relevé, pour que stdout ne
 * porte que le JSON.
 */
async function withLogsOnStderr<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

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
    const result = await withLogsOnStderr(async () =>
      runBenchmark({
        docs,
        queries,
        retriever: await factory.build(),
        maxTopK: topK,
      })
    );
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
