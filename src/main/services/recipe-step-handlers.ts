/**
 * Real step handlers for the recipe runner.
 *
 * Replaces the `stub` handlers that ship with `runner.ts` so search/graph/
 * export steps hit real services:
 *   - search → retrievalService (PDFs + Tropy primaries, optional vault)
 *   - graph  → KnowledgeGraphBuilder (Louvain communities etc.)
 *   - export → pdfExportService (Pandoc pipeline)
 *
 * brainstorm/write steps still use the runner's built-in LLM handler.
 *
 * The handlers interpolate `{{ inputs.foo }}` / `{{ stepId }}` in their
 * string params via the runner — so we only need to read already-resolved
 * values from `step.with` here.
 */

import fs from 'fs/promises';
import path from 'path';
import { retrievalService } from './retrieval-service.js';
import { pdfService } from './pdf-service.js';
import { pdfExportService } from './pdf-export.js';
import { KnowledgeGraphBuilder } from '../../../backend/core/analysis/KnowledgeGraphBuilder.js';
import type { VectorStore } from '../../../backend/core/vector-store/VectorStore.js';
import type {
  StepContext,
  StepHandler,
  StepResult,
} from '../../../backend/recipes/runner.js';

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}
function asStringArray(v: unknown): string[] | undefined {
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return undefined;
}

const searchHandler: StepHandler = async (step, _ctx): Promise<StepResult> => {
  const source = asString(step.with.source, 'both');
  const query = asString(step.with.query).trim();
  const limit = asNumber(step.with.limit) ?? 20;
  const collectionKeys = asStringArray(step.with.collection);

  // Map the recipe's source vocabulary to RetrievalService's sourceType.
  // - 'zotero' (bibliography PDFs) → 'secondary'
  // - 'tropy'  (primary archives)  → 'primary'
  // - anything else                → 'both'
  const sourceType =
    source === 'zotero'
      ? ('secondary' as const)
      : source === 'tropy'
        ? ('primary' as const)
        : ('both' as const);

  if (!query && !collectionKeys?.length) {
    return {
      output: {
        source,
        note:
          'search step: no query nor collection provided — skipping retrieval',
        results: [],
      },
    };
  }

  const hits = await retrievalService.search({
    query: query || (collectionKeys?.[0] ?? ''),
    topK: limit,
    sourceType,
    collectionKeys,
  });

  return {
    output: {
      source,
      query,
      count: hits.length,
      results: hits.map((h) => ({
        title: h.document.title ?? 'Sans titre',
        similarity: h.similarity,
        sourceType: h.sourceType,
        snippet: h.chunk.content.replace(/\s+/g, ' ').slice(0, 300),
        documentId: h.chunk.documentId ?? null,
      })),
    },
  };
};

const graphHandler: StepHandler = async (step, _ctx): Promise<StepResult> => {
  const vs = (
    pdfService as unknown as { vectorStore?: VectorStore }
  ).vectorStore;
  if (!vs) {
    throw new Error(
      'graph step: pdf-service vector store not initialised (open a project first)'
    );
  }
  const similarityThreshold = asNumber(step.with.similarityThreshold) ?? 0.7;
  const builder = new KnowledgeGraphBuilder(vs);
  const g = await builder.buildGraph({
    includeSimilarityEdges: true,
    similarityThreshold,
    computeLayout: false,
  });

  // graphology → plain JSON so it survives IPC + goes into the log.
  type NodeAttrs = { label?: string; type?: string; community?: number };
  type EdgeAttrs = { type?: string; weight?: number };
  const nodes: Array<{ id: string; label: string; community?: number }> = [];
  g.forEachNode((id: string, attrs: NodeAttrs) =>
    nodes.push({
      id,
      label: attrs.label ?? id,
      community: attrs.community,
    })
  );
  const edges: Array<{
    source: string;
    target: string;
    type?: string;
    weight?: number;
  }> = [];
  g.forEachEdge((_id: string, attrs: EdgeAttrs, source: string, target: string) =>
    edges.push({ source, target, type: attrs.type, weight: attrs.weight })
  );

  return {
    output: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      nodes,
      edges,
    },
  };
};

const exportHandler: StepHandler = async (
  step,
  ctx
): Promise<StepResult> => {
  const format = asString(step.with.format, 'pdf');
  if (format !== 'pdf') {
    throw new Error(
      `export step: format '${format}' not wired yet (only 'pdf' via Pandoc)`
    );
  }
  const outputPath = asString(step.with.output);
  if (!outputPath) {
    throw new Error('export step: missing "with.output" path');
  }
  // Resolve document content: for now we read <project>/document.md; the
  // `document_id` input is accepted but reserved for multi-doc projects.
  const docPath = path.join(ctx.workspaceRoot, 'document.md');
  let content: string;
  try {
    content = await fs.readFile(docPath, 'utf8');
  } catch (e) {
    throw new Error(
      `export step: could not read ${docPath}: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  const bibliographyPath = asString(step.with.bibliography);
  const result = await pdfExportService.exportToPDF({
    projectPath: ctx.workspaceRoot,
    projectType: 'article',
    content,
    outputPath,
    bibliographyPath: bibliographyPath || undefined,
  });
  if (!result.success) {
    throw new Error(result.error ?? 'export step: Pandoc pipeline failed');
  }
  return { output: { path: result.outputPath ?? outputPath } };
};

export const recipeStepHandlers = {
  search: searchHandler,
  graph: graphHandler,
  export: exportHandler,
} as const;
