/**
 * search_gallica — MCP tool querying Gallica (BnF), the digital library
 * of the Bibliothèque nationale de France.
 *
 * Why this is a "builtin" connector: Gallica's SRU endpoint is public,
 * requires no key, and indexes ~10 million items (books, periodicals,
 * manuscripts, maps, images) that are bread-and-butter primary sources
 * for French and francophone historians. Shipping it activated by
 * default is what lets ClioDeck claim "archives aware" out of the box.
 *
 * Endpoint: https://gallica.bnf.fr/SRU
 *   operation=searchRetrieve, version=1.2, recordSchema=dublincore
 *   See https://api.bnf.fr/api-gallica-de-recherche (SRU Gallica spec)
 *
 * Rate limit (documented by BnF): 5 requests/second per IP. The MCP
 * tool is interactive — the model issues one call at a time — so we do
 * not add a client-side throttle. If batch workflows appear, add a
 * token-bucket in a follow-up.
 *
 * Parsing: Gallica returns XML (SRW). We extract the subset we care
 * about (dc:title, dc:creator, dc:date, dc:identifier, dc:description,
 * dc:type) with a minimal tag-scanner — no new dependency, and the
 * structure we target is shallow and stable. If BnF changes the schema,
 * the parser fails closed (returns empty hits rather than crashing).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MCPAccessLogger } from '../logger.js';
import type { MCPRuntimeConfig } from '../config.js';

const TOOL_NAME = 'search_gallica';
const SRU_ENDPOINT = 'https://gallica.bnf.fr/SRU';
const DEFAULT_TIMEOUT_MS = 15_000;
const SNIPPET_MAX = 400;

export interface GallicaHit {
  id: string;
  ark: string | null;
  title: string;
  author: string | null;
  date: string | null;
  type: string | null;
  url: string | null;
  snippet: string;
}

/** Decode the handful of XML entities Gallica actually emits. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

/** Collect every `<prefix:local>...</prefix:local>` value under a record. */
function extractTag(recordXml: string, local: string): string[] {
  // Matches e.g. <dc:title ...>value</dc:title> or <oai_dc:title>value</...>
  // Non-greedy, case-sensitive (XML is).
  const re = new RegExp(
    `<(?:[A-Za-z][\\w.-]*:)?${local}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z][\\w.-]*:)?${local}>`,
    'g'
  );
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(recordXml)) !== null) {
    const v = decodeEntities(m[1].trim());
    if (v) out.push(v);
  }
  return out;
}

/** Split a SRW response into individual `<srw:record>` blocks. */
function splitRecords(xml: string): string[] {
  const re = /<(?:[A-Za-z][\w.-]*:)?record\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?record>/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/** Extract an ARK identifier from any dc:identifier value. */
function extractArk(identifiers: string[]): { ark: string | null; url: string | null } {
  for (const id of identifiers) {
    const m = id.match(/ark:\/[\w./-]+/);
    if (m) {
      const ark = m[0];
      const url = id.startsWith('http') ? id : `https://gallica.bnf.fr/${ark}`;
      return { ark, url };
    }
    if (id.startsWith('http') && id.includes('gallica.bnf.fr')) {
      return { ark: null, url: id };
    }
  }
  return { ark: null, url: null };
}

export function parseGallicaResponse(xml: string): GallicaHit[] {
  const records = splitRecords(xml);
  const hits: GallicaHit[] = [];
  for (const rec of records) {
    const titles = extractTag(rec, 'title');
    const creators = extractTag(rec, 'creator');
    const dates = extractTag(rec, 'date');
    const identifiers = extractTag(rec, 'identifier');
    const descriptions = extractTag(rec, 'description');
    const types = extractTag(rec, 'type');

    if (titles.length === 0 && identifiers.length === 0) continue;

    const { ark, url } = extractArk(identifiers);
    const id = ark ?? url ?? identifiers[0] ?? titles[0] ?? '';
    const desc = descriptions.join(' ');
    const snippet =
      desc.length > SNIPPET_MAX ? desc.slice(0, SNIPPET_MAX) + '…' : desc;

    hits.push({
      id,
      ark,
      title: titles[0] ?? '(untitled)',
      author: creators[0] ?? null,
      date: dates[0] ?? null,
      type: types[0] ?? null,
      url,
      snippet,
    });
  }
  return hits;
}

export interface GallicaFetchOptions {
  query: string;
  maximumRecords: number;
  startRecord: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function fetchGallica(opts: GallicaFetchOptions): Promise<string> {
  const params = new URLSearchParams({
    operation: 'searchRetrieve',
    version: '1.2',
    collapsing: 'true',
    query: opts.query,
    maximumRecords: String(opts.maximumRecords),
    startRecord: String(opts.startRecord),
  });
  const url = `${SRU_ENDPOINT}?${params.toString()}`;
  const impl = opts.fetchImpl ?? fetch;
  const res = await impl(url, {
    signal: opts.signal,
    headers: { Accept: 'application/xml' },
  });
  if (!res.ok) {
    throw new Error(`Gallica SRU returned HTTP ${res.status} ${res.statusText}`);
  }
  return await res.text();
}

/** Build an SRU CQL query from a free-text input + optional filters. */
export function buildGallicaCql(input: {
  text: string;
  dateFrom?: number;
  dateTo?: number;
  docType?: string;
}): string {
  const parts: string[] = [];
  // Escape embedded double quotes for CQL.
  const safe = input.text.replace(/"/g, '\\"');
  parts.push(`(gallica all "${safe}")`);
  if (input.dateFrom !== undefined) parts.push(`(gallica.date >= "${input.dateFrom}")`);
  if (input.dateTo !== undefined) parts.push(`(gallica.date <= "${input.dateTo}")`);
  if (input.docType) parts.push(`(dc.type all "${input.docType.replace(/"/g, '\\"')}")`);
  return parts.join(' and ');
}

export function registerSearchGallica(
  server: McpServer,
  _cfg: MCPRuntimeConfig,
  logger: MCPAccessLogger,
  deps: { fetchImpl?: typeof fetch } = {}
): void {
  server.tool(
    TOOL_NAME,
    'Search Gallica (Bibliothèque nationale de France) — ~10M digitised primary sources: books, periodicals, manuscripts, maps, images. Returns bibliographic records with ARK identifiers and direct URLs.',
    {
      query: z.string().min(1).describe('Free-text query (French or any language Gallica indexes)'),
      topK: z.number().int().min(1).max(50).optional().default(10),
      dateFrom: z.number().int().min(0).max(9999).optional().describe('Earliest publication year (inclusive)'),
      dateTo: z.number().int().min(0).max(9999).optional().describe('Latest publication year (inclusive)'),
      docType: z.string().optional().describe('Filter on Dublin Core dc:type (e.g. "monographie", "périodique", "carte")'),
    },
    async ({ query, topK, dateFrom, dateTo, docType }) => {
      const start = Date.now();
      const k = topK ?? 10;
      const cql = buildGallicaCql({ text: query, dateFrom, dateTo, docType });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      try {
        const xml = await fetchGallica({
          query: cql,
          maximumRecords: k,
          startRecord: 1,
          signal: controller.signal,
          fetchImpl: deps.fetchImpl,
        });
        const hits = parseGallicaResponse(xml).slice(0, k);

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
                  source: 'gallica.bnf.fr',
                  query,
                  cql,
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
          content: [{ type: 'text', text: `Error (search_gallica): ${message}` }],
          isError: true,
        };
      } finally {
        clearTimeout(timer);
      }
    }
  );
}
