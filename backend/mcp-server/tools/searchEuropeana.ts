/**
 * search_europeana — MCP tool querying Europeana's aggregated catalogue
 * of European GLAM institutions (museums, libraries, archives).
 *
 * STATUS: scaffold. The tool is NOT registered in `server.ts` yet —
 * Europeana requires a free API key per user, and we have not yet wired
 * the "builtin connector with user-supplied key" UX end-to-end.
 *
 * Endpoint: https://api.europeana.eu/record/v2/search.json
 *   ?wskey=<API_KEY>&query=<q>&rows=<n>&profile=standard
 *   Docs: https://pro.europeana.eu/page/search
 *
 * TODO (integration):
 *   - Resolve API key from workspace secureStorage at tool-call time
 *     (not at registration time — the user may set it after start).
 *   - Surface a clear "missing key" error to the model so it can ask
 *     the user to configure the connector in Settings → Archives.
 *   - Decide whether to pass language filter (`qf=LANGUAGE:fre`) and
 *     type (IMAGE / TEXT / VIDEO / SOUND / 3D).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MCPAccessLogger } from '../logger.js';
import type { MCPRuntimeConfig } from '../config.js';

const TOOL_NAME = 'search_europeana';
const ENDPOINT = 'https://api.europeana.eu/record/v2/search.json';

export interface EuropeanaHit {
  id: string;
  title: string;
  dataProvider: string | null;
  year: string | null;
  type: string | null;
  rights: string | null;
  url: string | null;
  thumbnail: string | null;
}

interface EuropeanaRawItem {
  id?: string;
  title?: string[];
  dataProvider?: string[];
  year?: string[];
  type?: string;
  rights?: string[];
  guid?: string;
  edmPreview?: string[];
}

export function parseEuropeanaJson(json: unknown): EuropeanaHit[] {
  if (!json || typeof json !== 'object') return [];
  const items = (json as { items?: EuropeanaRawItem[] }).items;
  if (!Array.isArray(items)) return [];
  return items.map((it) => ({
    id: it.id ?? '',
    title: it.title?.[0] ?? '(untitled)',
    dataProvider: it.dataProvider?.[0] ?? null,
    year: it.year?.[0] ?? null,
    type: it.type ?? null,
    rights: it.rights?.[0] ?? null,
    url: it.guid ?? null,
    thumbnail: it.edmPreview?.[0] ?? null,
  }));
}

export interface EuropeanaDeps {
  fetchImpl?: typeof fetch;
  getApiKey: () => string | null | Promise<string | null>;
}

export function registerSearchEuropeana(
  server: McpServer,
  _cfg: MCPRuntimeConfig,
  logger: MCPAccessLogger,
  deps: EuropeanaDeps
): void {
  server.tool(
    TOOL_NAME,
    'Search Europeana — aggregated catalogue of European museums, libraries, archives (~50M items). Requires a free API key (configure in Settings → Archives).',
    {
      query: z.string().min(1),
      topK: z.number().int().min(1).max(50).optional().default(10),
      mediaType: z.enum(['IMAGE', 'TEXT', 'VIDEO', 'SOUND', '3D']).optional(),
    },
    async ({ query, topK, mediaType }) => {
      const k = topK ?? 10;
      const key = await deps.getApiKey();
      if (!key) {
        const msg =
          'Europeana API key not configured. Open Settings → Archives to add one (free at https://pro.europeana.eu/pages/get-api).';
        logger.log({
          kind: 'tool_call',
          at: new Date().toISOString(),
          name: TOOL_NAME,
          input: { query, topK: k, mediaType },
          output: { error: 'missing_api_key' },
        });
        return { content: [{ type: 'text', text: msg }], isError: true };
      }
      const params = new URLSearchParams({
        wskey: key,
        query,
        rows: String(k),
        profile: 'standard',
      });
      if (mediaType) params.append('qf', `TYPE:${mediaType}`);
      const impl = deps.fetchImpl ?? fetch;
      try {
        const res = await impl(`${ENDPOINT}?${params.toString()}`);
        if (!res.ok) throw new Error(`Europeana HTTP ${res.status}`);
        const json = await res.json();
        const hits = parseEuropeanaJson(json);
        logger.log({
          kind: 'tool_call',
          at: new Date().toISOString(),
          name: TOOL_NAME,
          input: { query, topK: k, mediaType },
          output: { itemCount: hits.length },
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ source: 'europeana.eu', query, hits }, null, 2),
            },
          ],
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.log({
          kind: 'tool_call',
          at: new Date().toISOString(),
          name: TOOL_NAME,
          input: { query, topK: k, mediaType },
          output: { error: message },
        });
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    }
  );
}
