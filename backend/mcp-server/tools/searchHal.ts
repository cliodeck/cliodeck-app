/**
 * search_hal — MCP tool querying HAL (Hyper Articles en Ligne), the
 * French open-access repository for scholarly publications run by
 * CCSD/CNRS (https://hal.science).
 *
 * Why this is a "builtin" secondary-source connector: HAL indexes ~3M
 * open-access scholarly records (peer-reviewed articles, book chapters,
 * theses, conference papers, reports) produced by French research —
 * the natural place a historian goes to find scholarship *about* a
 * topic in French. Unlike Gallica (digitised primary sources), HAL
 * surfaces secondary literature. The MCP description string flags this
 * explicitly so the model picks the right tool.
 *
 * Endpoint: https://api.archives-ouvertes.fr/search/
 *   Solr over the HAL catalogue, JSON response (wt=json).
 *   See https://api.archives-ouvertes.fr/docs/search
 *
 * Auth: none (public).
 * Rate limit: not officially published; HAL tolerates interactive use.
 * As with Gallica, the tool is model-driven (one call per turn) so no
 * client-side throttle; add a token-bucket if batch use appears.
 *
 * Parsing: native JSON — no XML dance. We ask Solr for a fixed field
 * list (`fl=…`) so a schema change that drops fields fails closed
 * (empty/null values) rather than crashing.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MCPAccessLogger } from '../logger.js';
import type { MCPRuntimeConfig } from '../config.js';

const TOOL_NAME = 'search_hal';
const HAL_ENDPOINT = 'https://api.archives-ouvertes.fr/search/';
const DEFAULT_TIMEOUT_MS = 15_000;
const SNIPPET_MAX = 400;

const FIELD_LIST = [
  'halId_s',
  'title_s',
  'authFullName_s',
  'abstract_s',
  'uri_s',
  'docType_s',
  'producedDateY_i',
  'journalTitle_s',
  'language_s',
].join(',');

export interface HalHit {
  id: string;
  halId: string | null;
  title: string;
  authors: string[];
  date: string | null;
  docType: string | null;
  journal: string | null;
  language: string | null;
  url: string | null;
  snippet: string;
}

interface HalRawDoc {
  halId_s?: string;
  title_s?: string[];
  authFullName_s?: string[];
  abstract_s?: string[];
  uri_s?: string;
  docType_s?: string;
  producedDateY_i?: number;
  journalTitle_s?: string;
  language_s?: string[];
}

interface HalRawResponse {
  response?: {
    docs?: HalRawDoc[];
  };
}

function firstString(a: string[] | undefined): string | null {
  if (!a || a.length === 0) return null;
  const v = a[0];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function parseHalResponse(json: unknown): HalHit[] {
  if (!json || typeof json !== 'object') return [];
  const body = json as HalRawResponse;
  const docs = body.response?.docs;
  if (!Array.isArray(docs)) return [];
  const hits: HalHit[] = [];
  for (const d of docs) {
    if (!d || typeof d !== 'object') continue;
    const title = firstString(d.title_s) ?? '(untitled)';
    const authors = Array.isArray(d.authFullName_s)
      ? d.authFullName_s.filter((s): s is string => typeof s === 'string' && s.length > 0)
      : [];
    const abstract = firstString(d.abstract_s) ?? '';
    const snippet =
      abstract.length > SNIPPET_MAX ? abstract.slice(0, SNIPPET_MAX) + '…' : abstract;
    const halId = typeof d.halId_s === 'string' ? d.halId_s : null;
    const url = typeof d.uri_s === 'string' ? d.uri_s : null;
    const id = halId ?? url ?? title;
    const date =
      typeof d.producedDateY_i === 'number' ? String(d.producedDateY_i) : null;
    hits.push({
      id,
      halId,
      title,
      authors,
      date,
      docType: typeof d.docType_s === 'string' ? d.docType_s : null,
      journal: typeof d.journalTitle_s === 'string' ? d.journalTitle_s : null,
      language: firstString(d.language_s),
      url,
      snippet,
    });
  }
  return hits;
}

export interface HalFetchOptions {
  query: string;
  filterQueries: string[];
  rows: number;
  start: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function fetchHal(opts: HalFetchOptions): Promise<unknown> {
  const params = new URLSearchParams();
  params.set('q', opts.query);
  params.set('fl', FIELD_LIST);
  params.set('rows', String(opts.rows));
  params.set('start', String(opts.start));
  params.set('wt', 'json');
  for (const fq of opts.filterQueries) {
    params.append('fq', fq);
  }
  const url = `${HAL_ENDPOINT}?${params.toString()}`;
  const impl = opts.fetchImpl ?? fetch;
  const res = await impl(url, {
    signal: opts.signal,
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`HAL Solr returned HTTP ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

/** Build Solr `fq` clauses from optional date range + docType filters. */
export function buildHalFilters(input: {
  dateFrom?: number;
  dateTo?: number;
  docType?: string;
}): string[] {
  const out: string[] = [];
  if (input.dateFrom !== undefined || input.dateTo !== undefined) {
    const lo = input.dateFrom !== undefined ? String(input.dateFrom) : '*';
    const hi = input.dateTo !== undefined ? String(input.dateTo) : '*';
    out.push(`producedDateY_i:[${lo} TO ${hi}]`);
  }
  if (input.docType) {
    // HAL uses uppercase codes (ART, COMM, THESE, OUV, COUV, REPORT…).
    // Strip anything outside [A-Z0-9_] before interpolating into the fq.
    const safe = input.docType.toUpperCase().replace(/[^A-Z0-9_]/g, '');
    if (safe.length > 0) out.push(`docType_s:${safe}`);
  }
  return out;
}

export function registerSearchHal(
  server: McpServer,
  _cfg: MCPRuntimeConfig,
  logger: MCPAccessLogger,
  deps: { fetchImpl?: typeof fetch } = {}
): void {
  server.tool(
    TOOL_NAME,
    'Search HAL (Hyper Articles en Ligne, CNRS/CCSD) — ~3M open-access scholarly records in French & other languages: peer-reviewed articles, book chapters, theses, conference papers, reports. SECONDARY source — use this for scholarship *about* a topic, not for primary archival material (for primary sources, prefer search_gallica).',
    {
      query: z.string().min(1).describe('Free-text Solr query (any language HAL indexes)'),
      topK: z.number().int().min(1).max(50).optional().default(10),
      dateFrom: z.number().int().min(0).max(9999).optional().describe('Earliest production year (inclusive)'),
      dateTo: z.number().int().min(0).max(9999).optional().describe('Latest production year (inclusive)'),
      docType: z.string().optional().describe('Filter on HAL docType_s (e.g. "ART" journal article, "COMM" conference paper, "THESE" thesis, "OUV" book, "COUV" book chapter, "REPORT")'),
    },
    async ({ query, topK, dateFrom, dateTo, docType }) => {
      const start = Date.now();
      const k = topK ?? 10;
      const filters = buildHalFilters({ dateFrom, dateTo, docType });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      try {
        const raw = await fetchHal({
          query,
          filterQueries: filters,
          rows: k,
          start: 0,
          signal: controller.signal,
          fetchImpl: deps.fetchImpl,
        });
        const hits = parseHalResponse(raw).slice(0, k);

        logger.log({
          kind: 'tool_call',
          at: new Date().toISOString(),
          name: TOOL_NAME,
          input: { query, topK: k, dateFrom, dateTo, docType },
          output: { itemCount: hits.length },
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  source: 'hal.science',
                  kind: 'secondary',
                  query,
                  filters,
                  topK: k,
                  hits,
                  elapsedMs: Date.now() - start,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.log({
          kind: 'tool_call',
          at: new Date().toISOString(),
          name: TOOL_NAME,
          input: { query, topK: k, dateFrom, dateTo, docType },
          output: { error: message },
        });
        return {
          content: [{ type: 'text', text: `Error (search_hal): ${message}` }],
          isError: true,
        };
      } finally {
        clearTimeout(timer);
      }
    }
  );
}
