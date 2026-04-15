import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listCSLStyles, listCSLLocales } from '../citation-handlers.js';

describe('citation-handlers — discovery helpers', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('lists .csl files with humanized labels', () => {
    fs.writeFileSync(path.join(tmp, 'chicago-note-bibliography.csl'), '<x/>');
    fs.writeFileSync(path.join(tmp, 'mla.csl'), '<x/>');
    fs.writeFileSync(path.join(tmp, 'README.md'), 'not a style');
    const styles = listCSLStyles(tmp);
    const ids = styles.map((s) => s.id).sort();
    expect(ids).toEqual(['chicago-note-bibliography', 'mla']);
    const chicago = styles.find((s) => s.id === 'chicago-note-bibliography');
    expect(chicago?.label).toBe('Chicago Note Bibliography');
  });

  it('lists locales-xx-XX.xml files', () => {
    fs.writeFileSync(path.join(tmp, 'locales-en-US.xml'), '<x/>');
    fs.writeFileSync(path.join(tmp, 'locales-fr-FR.xml'), '<x/>');
    fs.writeFileSync(path.join(tmp, 'other.xml'), '<x/>');
    const locales = listCSLLocales(tmp).sort();
    expect(locales).toEqual(['en-US', 'fr-FR']);
  });

  it('returns [] when the resources folder does not exist', () => {
    const missing = path.join(tmp, 'nope');
    expect(listCSLStyles(missing)).toEqual([]);
    expect(listCSLLocales(missing)).toEqual([]);
  });
});

// Mock CitationEngine to verify handler routing without loading citeproc.
vi.mock('../../../../../backend/core/citation/CitationEngine.js', () => {
  class MockCitationEngine {
    formatCitation(): { footnotes: string[]; bibliography: string[] } {
      return { footnotes: ['FN1'], bibliography: ['BIB1'] };
    }
    listStyles(): string[] {
      return ['chicago-note-bibliography'];
    }
  }
  return { CitationEngine: MockCitationEngine };
});

vi.mock('../../../services/bibliography-service.js', () => ({
  bibliographyService: {
    getCitations: () => [
      {
        id: 'k1',
        key: 'k1',
        type: 'book',
        title: 'A Book',
        author: 'Doe, Jane',
        year: '2020',
      },
    ],
  },
}));

vi.mock('electron', () => {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  return {
    ipcMain: {
      handle: (channel: string, fn: (...a: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      },
    },
    app: { isPackaged: false },
    __handlers: handlers,
  };
});

describe('citation-handlers — IPC routing', () => {
  it('registers the four channels and routes format/preview through the engine', async () => {
    const electronMod = (await import('electron')) as unknown as {
      __handlers: Map<string, (...a: unknown[]) => Promise<unknown>>;
    };
    const mod = await import('../citation-handlers.js');
    mod.__resetCitationEngineForTests();
    mod.setupCitationHandlers();
    const handlers = electronMod.__handlers;
    expect(handlers.has('citation:listStyles')).toBe(true);
    expect(handlers.has('citation:listLocales')).toBe(true);
    expect(handlers.has('citation:format')).toBe(true);
    expect(handlers.has('citation:preview')).toBe(true);

    const fmt = (await handlers.get('citation:format')!(
      {},
      [{ id: 'k1', type: 'book' }],
      'chicago-note-bibliography',
      'en-US'
    )) as { success: boolean; footnotes: string[]; bibliography: string[] };
    expect(fmt.success).toBe(true);
    expect(fmt.footnotes).toEqual(['FN1']);
    expect(fmt.bibliography).toEqual(['BIB1']);

    const prev = (await handlers.get('citation:preview')!(
      {},
      'k1',
      'chicago-note-bibliography',
      'en-US'
    )) as { success: boolean; footnote: string; bibliography: string };
    expect(prev.success).toBe(true);
    expect(prev.footnote).toBe('FN1');
    expect(prev.bibliography).toBe('BIB1');

    // Unknown key path returns a failure envelope.
    const missing = (await handlers.get('citation:preview')!(
      {},
      'nope',
      'chicago-note-bibliography',
      'en-US'
    )) as { success: boolean; footnote: string };
    expect(missing.success).toBe(false);
    expect(missing.footnote).toBe('');
  });
});
