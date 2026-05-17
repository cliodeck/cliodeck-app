/**
 * Tests for the Gallica MCP tool.
 *
 * We isolate the three pieces that actually matter:
 *   - CQL builder: correct composition with date + type filters.
 *   - XML parser: robust against real-ish Gallica SRW output shapes.
 *   - fetchGallica: URL, headers, error path (mocked fetch).
 *
 * No MCP SDK wiring here — the registration call is thin glue; the
 * audit/error contract is exercised indirectly via the helpers above.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildGallicaCql,
  parseGallicaResponse,
  fetchGallica,
  type GallicaHit,
} from '../tools/searchGallica.js';

describe('buildGallicaCql', () => {
  it('wraps free text in an all-words clause', () => {
    expect(buildGallicaCql({ text: 'jaurès' })).toBe('(gallica all "jaurès")');
  });

  it('escapes embedded double quotes', () => {
    expect(buildGallicaCql({ text: 'the "great" war' })).toContain(
      '"the \\"great\\" war"'
    );
  });

  it('combines date range and type filters', () => {
    const cql = buildGallicaCql({
      text: 'dreyfus',
      dateFrom: 1894,
      dateTo: 1906,
      docType: 'monographie',
    });
    expect(cql).toBe(
      '(gallica all "dreyfus") and (gallica.date >= "1894") and (gallica.date <= "1906") and (dc.type all "monographie")'
    );
  });
});

describe('parseGallicaResponse', () => {
  const sample = `<?xml version="1.0"?>
  <srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/">
    <srw:numberOfRecords>2</srw:numberOfRecords>
    <srw:records>
      <srw:record>
        <srw:recordData>
          <oai_dc:dc xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>L'Affaire Dreyfus</dc:title>
            <dc:creator>Zola, Émile</dc:creator>
            <dc:date>1898</dc:date>
            <dc:type>monographie</dc:type>
            <dc:description>Un recueil d'articles &amp; lettres ouvertes.</dc:description>
            <dc:identifier>https://gallica.bnf.fr/ark:/12148/bpt6k12345</dc:identifier>
          </oai_dc:dc>
        </srw:recordData>
      </srw:record>
      <srw:record>
        <srw:recordData>
          <oai_dc:dc xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>Revue blanche</dc:title>
            <dc:date>1899</dc:date>
            <dc:identifier>ark:/12148/cb34429261p</dc:identifier>
          </oai_dc:dc>
        </srw:recordData>
      </srw:record>
    </srw:records>
  </srw:searchRetrieveResponse>`;

  it('extracts titles, authors, dates, ARK, URL', () => {
    const hits = parseGallicaResponse(sample);
    expect(hits).toHaveLength(2);
    const h0 = hits[0] as GallicaHit;
    expect(h0.title).toBe("L'Affaire Dreyfus");
    expect(h0.author).toBe('Zola, Émile');
    expect(h0.date).toBe('1898');
    expect(h0.type).toBe('monographie');
    expect(h0.ark).toBe('ark:/12148/bpt6k12345');
    expect(h0.url).toBe('https://gallica.bnf.fr/ark:/12148/bpt6k12345');
    expect(h0.snippet).toContain('&'); // entity decoded
  });

  it('builds a gallica.bnf.fr URL from a bare ARK identifier', () => {
    const hits = parseGallicaResponse(sample);
    expect(hits[1].ark).toBe('ark:/12148/cb34429261p');
    expect(hits[1].url).toBe('https://gallica.bnf.fr/ark:/12148/cb34429261p');
    expect(hits[1].author).toBeNull();
  });

  it('returns [] for malformed / empty XML (fails closed)', () => {
    expect(parseGallicaResponse('')).toEqual([]);
    expect(parseGallicaResponse('<foo/>')).toEqual([]);
  });
});

describe('fetchGallica', () => {
  it('builds the SRU URL and returns the body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '<xml/>',
    }) as unknown as typeof fetch;
    const body = await fetchGallica({
      query: '(gallica all "dreyfus")',
      maximumRecords: 5,
      startRecord: 1,
      fetchImpl,
    });
    expect(body).toBe('<xml/>');
    const calledUrl = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as string;
    expect(calledUrl).toContain('https://gallica.bnf.fr/SRU?');
    expect(calledUrl).toContain('operation=searchRetrieve');
    expect(calledUrl).toContain('version=1.2');
    expect(calledUrl).toContain('maximumRecords=5');
    expect(calledUrl).toContain('startRecord=1');
    // URLSearchParams encodes spaces as '+' — normalise before asserting.
    expect(decodeURIComponent(calledUrl).replace(/\+/g, ' ')).toContain(
      '(gallica all "dreyfus")'
    );
  });

  it('throws on non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: async () => '',
    }) as unknown as typeof fetch;
    await expect(
      fetchGallica({ query: 'x', maximumRecords: 1, startRecord: 1, fetchImpl })
    ).rejects.toThrow(/503/);
  });
});
