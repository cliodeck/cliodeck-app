/**
 * Tests for the HAL MCP tool.
 *
 * Same shape as `searchGallica.test.ts`: exercise the three pieces that
 * actually matter — filter builder, response parser, and the HTTP
 * wrapper (mocked). The registration call is thin glue; the audit /
 * error contract is exercised indirectly via the helpers above.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildHalFilters,
  parseHalResponse,
  fetchHal,
  type HalHit,
} from '../tools/searchHal.js';

describe('buildHalFilters', () => {
  it('returns [] when no optional filter is given', () => {
    expect(buildHalFilters({})).toEqual([]);
  });

  it('builds a bounded date range', () => {
    expect(buildHalFilters({ dateFrom: 1990, dateTo: 2000 })).toEqual([
      'producedDateY_i:[1990 TO 2000]',
    ]);
  });

  it('uses Solr wildcard for an open-ended range', () => {
    expect(buildHalFilters({ dateFrom: 1990 })).toEqual([
      'producedDateY_i:[1990 TO *]',
    ]);
    expect(buildHalFilters({ dateTo: 2000 })).toEqual([
      'producedDateY_i:[* TO 2000]',
    ]);
  });

  it('uppercases docType and strips anything unsafe', () => {
    expect(buildHalFilters({ docType: 'art' })).toEqual(['docType_s:ART']);
    expect(buildHalFilters({ docType: 'COMM; DROP TABLE' })).toEqual([
      'docType_s:COMMDROPTABLE',
    ]);
  });

  it('combines date range and docType', () => {
    expect(
      buildHalFilters({ dateFrom: 1894, dateTo: 1906, docType: 'THESE' })
    ).toEqual(['producedDateY_i:[1894 TO 1906]', 'docType_s:THESE']);
  });
});

describe('parseHalResponse', () => {
  const sample = {
    response: {
      numFound: 2,
      docs: [
        {
          halId_s: 'hal-12345',
          title_s: [
            'De l’histoire à la fiction : les écrivains et l’affaire Dreyfus',
            'From History to Fiction',
          ],
          authFullName_s: ['Alice Dupont', 'Bob Martin'],
          abstract_s: ['Un long résumé qui dépasse les 400 caractères. '.repeat(20)],
          uri_s: 'https://hal.science/hal-12345v1',
          docType_s: 'THESE',
          producedDateY_i: 2012,
          journalTitle_s: undefined,
          language_s: ['fr', 'en'],
        },
        {
          halId_s: 'hal-67890',
          title_s: ['Revue d’histoire'],
          authFullName_s: ['Claire Durand'],
          abstract_s: [],
          uri_s: 'https://hal.inrae.fr/hal-67890v1',
          docType_s: 'ART',
          producedDateY_i: 1999,
          journalTitle_s: 'Annales',
          language_s: ['fr'],
        },
      ],
    },
  };

  it('maps the Solr doc fields onto HalHit shape', () => {
    const hits = parseHalResponse(sample);
    expect(hits).toHaveLength(2);
    const h0 = hits[0] as HalHit;
    expect(h0.halId).toBe('hal-12345');
    expect(h0.title).toBe(
      'De l’histoire à la fiction : les écrivains et l’affaire Dreyfus'
    );
    expect(h0.authors).toEqual(['Alice Dupont', 'Bob Martin']);
    expect(h0.date).toBe('2012');
    expect(h0.docType).toBe('THESE');
    expect(h0.language).toBe('fr');
    expect(h0.url).toBe('https://hal.science/hal-12345v1');
    expect(h0.snippet.endsWith('…')).toBe(true);
    expect(h0.snippet.length).toBeLessThanOrEqual(401);
  });

  it('handles missing optional fields without throwing', () => {
    const hits = parseHalResponse(sample);
    const h1 = hits[1] as HalHit;
    expect(h1.journal).toBe('Annales');
    expect(h1.snippet).toBe('');
  });

  it('returns [] for malformed / empty JSON (fails closed)', () => {
    expect(parseHalResponse(null)).toEqual([]);
    expect(parseHalResponse({})).toEqual([]);
    expect(parseHalResponse({ response: {} })).toEqual([]);
    expect(parseHalResponse({ response: { docs: 'nope' } })).toEqual([]);
  });
});

describe('fetchHal', () => {
  it('builds the Solr URL with fq params and returns the JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ response: { docs: [] } }),
    }) as unknown as typeof fetch;
    const body = await fetchHal({
      query: 'dreyfus',
      filterQueries: ['producedDateY_i:[1894 TO 1906]', 'docType_s:ART'],
      rows: 5,
      start: 0,
      fetchImpl,
    });
    expect(body).toEqual({ response: { docs: [] } });
    const calledUrl = (fetchImpl as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][0] as string;
    expect(calledUrl).toContain('https://api.archives-ouvertes.fr/search/?');
    expect(calledUrl).toContain('wt=json');
    expect(calledUrl).toContain('rows=5');
    expect(calledUrl).toContain('fl=halId_s');
    // URLSearchParams encodes [ ] and spaces — normalise before asserting.
    const decoded = decodeURIComponent(calledUrl).replace(/\+/g, ' ');
    expect(decoded).toContain('fq=producedDateY_i:[1894 TO 1906]');
    expect(decoded).toContain('fq=docType_s:ART');
    expect(decoded).toContain('q=dreyfus');
  });

  it('throws on non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({}),
    }) as unknown as typeof fetch;
    await expect(
      fetchHal({
        query: 'x',
        filterQueries: [],
        rows: 1,
        start: 0,
        fetchImpl,
      })
    ).rejects.toThrow(/503/);
  });
});
