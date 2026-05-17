/**
 * Tests for BibliographyMetadataService.
 *
 * The service persists Zotero attachment data per citation. Its storage
 * key used to be `citation.id` (= bibtexKey), which collides when a
 * Zotero library exports many items under the same author/year pair
 * (e.g. 68 diary entries → 2 unique bibtexKeys). After that collision,
 * only 2 rows of attachments were kept and the other 66 were silently
 * lost. These tests pin down the fix: index by `zoteroKey` when present.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BibliographyMetadataService } from '../BibliographyMetadataService.js';
import type { Citation } from '../../types/citation.js';

const makeCitation = (overrides: Partial<Citation>): Citation =>
  ({
    id: 'Lester_1935',
    type: 'misc',
    title: 'Diary',
    author: 'Lester, Sean',
    year: '1935',
    ...overrides,
  }) as Citation;

describe('BibliographyMetadataService', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cliodeck-biblio-meta-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  describe('saveMetadata', () => {
    it('keeps one row per zoteroKey even when bibtexKeys collide', async () => {
      const citations: Citation[] = [
        makeCitation({
          id: 'Lester_1935',
          zoteroKey: 'ABC123',
          zoteroAttachments: [{ key: 'att-abc', filename: 'jan.pdf' } as any],
        }),
        makeCitation({
          id: 'Lester_1935', // SAME bibtexKey — this is the collision
          zoteroKey: 'DEF456',
          zoteroAttachments: [{ key: 'att-def', filename: 'feb.pdf' } as any],
        }),
        makeCitation({
          id: 'Lester_1935',
          zoteroKey: 'GHI789',
          zoteroAttachments: [{ key: 'att-ghi', filename: 'mar.pdf' } as any],
        }),
      ];

      await BibliographyMetadataService.saveMetadata(tmpDir, citations);

      const loaded = await BibliographyMetadataService.loadMetadata(tmpDir);
      expect(loaded).not.toBeNull();
      const keys = Object.keys(loaded!.citations).sort();
      expect(keys).toEqual(['ABC123', 'DEF456', 'GHI789']);
      expect(loaded!.citations['ABC123'].zoteroAttachments?.[0].filename).toBe('jan.pdf');
      expect(loaded!.citations['DEF456'].zoteroAttachments?.[0].filename).toBe('feb.pdf');
      expect(loaded!.citations['GHI789'].zoteroAttachments?.[0].filename).toBe('mar.pdf');
    });

    it('falls back to bibtexKey for non-Zotero citations (no zoteroKey)', async () => {
      const citations: Citation[] = [
        makeCitation({
          id: 'manual_entry_1',
          zoteroAttachments: [{ key: 'att-manual', filename: 'manual.pdf' } as any],
        }),
      ];

      await BibliographyMetadataService.saveMetadata(tmpDir, citations);

      const loaded = await BibliographyMetadataService.loadMetadata(tmpDir);
      expect(loaded!.citations).toHaveProperty('manual_entry_1');
    });
  });

  describe('mergeCitationsWithMetadata', () => {
    it('routes attachments back by zoteroKey, not by colliding bibtexKey', async () => {
      const saved: Citation[] = [
        makeCitation({
          id: 'Lester_1935',
          zoteroKey: 'ABC123',
          zoteroAttachments: [{ key: 'att-abc', filename: 'jan.pdf' } as any],
        }),
        makeCitation({
          id: 'Lester_1935',
          zoteroKey: 'DEF456',
          zoteroAttachments: [{ key: 'att-def', filename: 'feb.pdf' } as any],
        }),
      ];
      await BibliographyMetadataService.saveMetadata(tmpDir, saved);

      // Simulate a fresh parse from bibtex: the attachments are gone,
      // only id/zoteroKey survive.
      const fresh: Citation[] = [
        makeCitation({ id: 'Lester_1935', zoteroKey: 'ABC123' }),
        makeCitation({ id: 'Lester_1935', zoteroKey: 'DEF456' }),
      ];
      const metadata = await BibliographyMetadataService.loadMetadata(tmpDir);
      const merged = BibliographyMetadataService.mergeCitationsWithMetadata(fresh, metadata);

      expect(merged[0].zoteroAttachments?.[0].filename).toBe('jan.pdf');
      expect(merged[1].zoteroAttachments?.[0].filename).toBe('feb.pdf');
    });
  });

  describe('v1 → v2 migration', () => {
    it('re-indexes legacy files by zoteroKey on first load', async () => {
      const legacyPath = BibliographyMetadataService.getMetadataPath(tmpDir);
      await fs.promises.mkdir(path.dirname(legacyPath), { recursive: true });
      // v1 stored keyed by bibtexKey, so a collision already dropped entries.
      // Migration can only re-index what's there; it can't recover lost rows.
      const legacyFile = {
        version: 1,
        lastUpdated: '2026-04-01T00:00:00.000Z',
        citations: {
          Lester_1935: {
            id: 'Lester_1935',
            zoteroKey: 'LAST_SURVIVOR',
            zoteroAttachments: [{ key: 'att-last', filename: 'last.pdf' }],
          },
        },
      };
      await fs.promises.writeFile(legacyPath, JSON.stringify(legacyFile), 'utf-8');

      const loaded = await BibliographyMetadataService.loadMetadata(tmpDir);
      expect(loaded?.version).toBe(2);
      expect(Object.keys(loaded!.citations)).toEqual(['LAST_SURVIVOR']);
    });
  });
});
