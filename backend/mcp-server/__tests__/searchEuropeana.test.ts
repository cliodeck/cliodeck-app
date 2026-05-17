/**
 * Tests for the Europeana MCP tool (fusion 1.9).
 *
 * Two layers:
 *   - `parseEuropeanaJson` is a pure function over the Europeana
 *     `/record/v2/search.json` shape; we feed it real-ish JSON.
 *   - The registered handler is invoked with a fake `McpServer`,
 *     a stub `getApiKey`, and a mocked `fetchImpl`. This covers the
 *     missing-key path (the most common failure for a key-gated
 *     connector) and the URL-construction contract (wskey, query,
 *     rows, optional `qf=TYPE:`).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parseEuropeanaJson,
  registerSearchEuropeana,
  type EuropeanaHit,
} from '../tools/searchEuropeana.js';
import {
  createCapturingServer,
  createInMemoryLogger,
  createTempWorkspace,
  makeMcpConfig,
  rmrf,
} from './_helpers.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

describe('parseEuropeanaJson', () => {
  it('maps title/dataProvider/year/type/rights/url/thumbnail off the items array', () => {
    const hits = parseEuropeanaJson({
      items: [
        {
          id: '/2021603/europeana_fashion_8b1',
          title: ['Robe de soirée', 'Evening dress'],
          dataProvider: ['Mode Museum Antwerp'],
          year: ['1923'],
          type: 'IMAGE',
          rights: ['http://creativecommons.org/licenses/by/4.0/'],
          guid: 'https://www.europeana.eu/portal/record/2021603.html',
          edmPreview: ['https://api.europeana.eu/thumbnail/v3/200/abc'],
        },
        {
          id: '/9200', // bare item with most fields missing
        },
      ],
    });
    expect(hits).toHaveLength(2);
    const h0 = hits[0] as EuropeanaHit;
    expect(h0.id).toBe('/2021603/europeana_fashion_8b1');
    expect(h0.title).toBe('Robe de soirée');
    expect(h0.dataProvider).toBe('Mode Museum Antwerp');
    expect(h0.year).toBe('1923');
    expect(h0.type).toBe('IMAGE');
    expect(h0.rights).toBe('http://creativecommons.org/licenses/by/4.0/');
    expect(h0.url).toBe('https://www.europeana.eu/portal/record/2021603.html');
    expect(h0.thumbnail).toBe('https://api.europeana.eu/thumbnail/v3/200/abc');
    // Missing fields fall back to nulls / "(untitled)" so the model gets
    // a stable shape even when Europeana returns sparse records.
    const h1 = hits[1] as EuropeanaHit;
    expect(h1.title).toBe('(untitled)');
    expect(h1.year).toBeNull();
    expect(h1.thumbnail).toBeNull();
  });

  it('returns [] for malformed input (fails closed)', () => {
    expect(parseEuropeanaJson(null)).toEqual([]);
    expect(parseEuropeanaJson({})).toEqual([]);
    expect(parseEuropeanaJson({ items: 'nope' })).toEqual([]);
  });
});

describe('registerSearchEuropeana — handler', () => {
  it('returns a clear "missing API key" error before issuing any HTTP call', async () => {
    const root = createTempWorkspace();
    try {
      const { server, tools } = createCapturingServer();
      const { logger, events } = createInMemoryLogger();
      const fetchImpl = vi.fn();
      registerSearchEuropeana(
        server as unknown as McpServer,
        makeMcpConfig(root),
        logger as never,
        { getApiKey: () => null, fetchImpl: fetchImpl as unknown as typeof fetch }
      );

      const tool = tools.get('search_europeana')!;
      expect(tool).toBeDefined();
      const result = await tool.handler({ query: 'dada', topK: 5 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/api key not configured/i);
      expect(fetchImpl).not.toHaveBeenCalled();
      // Audit log records the missing-key failure for observability.
      expect(events).toHaveLength(1);
      expect(events[0].output).toEqual({ error: 'missing_api_key' });
    } finally {
      rmrf(root);
    }
  });

  it('builds the GET URL with wskey/query/rows/profile and parses the response', async () => {
    const root = createTempWorkspace();
    try {
      const { server, tools } = createCapturingServer();
      const { logger, events } = createInMemoryLogger();
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              id: '/x',
              title: ['Le Front populaire'],
              dataProvider: ['BnF'],
              year: ['1936'],
              type: 'TEXT',
              guid: 'https://example.org/record/x',
            },
          ],
        }),
      });

      registerSearchEuropeana(
        server as unknown as McpServer,
        makeMcpConfig(root),
        logger as never,
        {
          getApiKey: () => 'KEY-123',
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }
      );

      const tool = tools.get('search_europeana')!;
      const result = await tool.handler({
        query: 'front populaire',
        topK: 4,
        mediaType: 'TEXT',
      });

      // Verify URL composition (wskey + qf for mediaType).
      const calledUrl = fetchImpl.mock.calls[0][0] as string;
      const decoded = decodeURIComponent(calledUrl).replace(/\+/g, ' ');
      expect(decoded).toContain('wskey=KEY-123');
      expect(decoded).toContain('query=front populaire');
      expect(decoded).toContain('rows=4');
      expect(decoded).toContain('profile=standard');
      expect(decoded).toContain('qf=TYPE:TEXT');

      // The handler shapes the JSON it returns to the model.
      const payload = JSON.parse(result.content[0].text);
      expect(payload.source).toBe('europeana.eu');
      expect(payload.hits).toHaveLength(1);
      expect(payload.hits[0].title).toBe('Le Front populaire');

      expect(events[0].output).toEqual({ itemCount: 1 });
    } finally {
      rmrf(root);
    }
  });

  it('reports HTTP failures as a tool error with the status code', async () => {
    const root = createTempWorkspace();
    try {
      const { server, tools } = createCapturingServer();
      const { logger, events } = createInMemoryLogger();
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => ({}),
      });

      registerSearchEuropeana(
        server as unknown as McpServer,
        makeMcpConfig(root),
        logger as never,
        {
          getApiKey: () => 'KEY',
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }
      );

      const tool = tools.get('search_europeana')!;
      const result = await tool.handler({ query: 'x', topK: 1 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Europeana HTTP 502/);
      expect(events[0].output).toEqual({ error: 'Europeana HTTP 502' });
    } finally {
      rmrf(root);
    }
  });
});
