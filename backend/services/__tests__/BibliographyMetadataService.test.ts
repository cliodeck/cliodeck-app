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
import type { Citation, ZoteroAttachmentInfo } from '../../types/citation.js';
import { symlinkAvailable } from '../../__tests__/helpers/native-guards.js';

const makeCitation = (overrides: Partial<Citation>): Citation =>
  ({
    id: 'Lester_1935',
    type: 'misc',
    title: 'Diary',
    author: 'Lester, Sean',
    year: '1935',
    ...overrides,
  }) as Citation;

/** Une pièce jointe PDF telle que la synchronisation la rapporte : pas encore téléchargée. */
const attachment = (key: string, filename = `${key}.pdf`): ZoteroAttachmentInfo => ({
  key,
  filename,
  contentType: 'application/pdf',
  downloaded: false,
});

describe('BibliographyMetadataService', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cliodeck-biblio-meta-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  describe('saveFromSync', () => {
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

      await BibliographyMetadataService.saveFromSync(tmpDir, citations);

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

      await BibliographyMetadataService.saveFromSync(tmpDir, citations);

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
      await BibliographyMetadataService.saveFromSync(tmpDir, saved);

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

    // Avant le 2026-09-14, la synchronisation rattachait aussi les instantanés
    // HTML de Zotero : le .bib désigne alors une page web, pas un PDF.
    const downloadedPdf = [
      {
        key: 'att-pdf',
        filename: 'Vaswani.pdf',
        contentType: 'application/pdf',
        downloaded: true,
        localPath: '/projet/PDFs/Vaswani.pdf',
      },
    ] as Citation['zoteroAttachments'];

    const reloaded = async (file: string, attachments: Citation['zoteroAttachments']) => {
      await BibliographyMetadataService.saveFromSync(tmpDir, [
        makeCitation({ zoteroKey: 'S84VK4DC', file, zoteroAttachments: attachments }),
      ]);
      const metadata = await BibliographyMetadataService.loadMetadata(tmpDir);
      const fresh = [makeCitation({ zoteroKey: 'S84VK4DC', file })];
      return BibliographyMetadataService.mergeCitationsWithMetadata(fresh, metadata)[0];
    };

    it('préfère le PDF téléchargé quand le .bib désigne un instantané HTML', async () => {
      const merged = await reloaded('/projet/PDFs/1706.html', downloadedPdf);
      expect(merged.file).toBe('/projet/PDFs/Vaswani.pdf');
    });

    it('garde le PDF du .bib quand il en désigne un', async () => {
      const merged = await reloaded('/projet/PDFs/choisi-a-la-main.pdf', downloadedPdf);
      expect(merged.file).toBe('/projet/PDFs/choisi-a-la-main.pdf');
    });

    it('garde l’instantané tant qu’aucun PDF n’a été téléchargé', async () => {
      const pending = [{ key: 'att-pdf', filename: 'Vaswani.pdf', contentType: 'application/pdf', downloaded: false }];
      const merged = await reloaded('/projet/PDFs/1706.html', pending as Citation['zoteroAttachments']);
      expect(merged.file).toBe('/projet/PDFs/1706.html');
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

/**
 * Illisible n'est pas absent (S07-1-10). `loadMetadata` rendait `null` sur toute erreur de lecture
 * ou de JSON : la synchronisation repartait alors sans les rattachements de PDF et réécrivait le
 * fichier, que l'historien aurait pu réparer.
 */
describe('BibliographyMetadataService — métadonnées illisibles', () => {
  let tmpDir: string;
  const metadataPath = () => BibliographyMetadataService.getMetadataPath(tmpDir);
  const RATTACHEMENTS = JSON.stringify({
    version: 2,
    lastUpdated: '2026-04-01T00:00:00.000Z',
    citations: { ABCD1234: { id: 'Lester_1935', zoteroKey: 'ABCD1234', zoteroAttachments: [{ key: 'att', filename: 'a.pdf' }] } },
  });

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cliodeck-biblio-meta-'));
    await fs.promises.mkdir(path.dirname(metadataPath()), { recursive: true });
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('témoin : absent, c’est null', async () => {
    expect(await BibliographyMetadataService.loadMetadata(tmpDir)).toBeNull();
  });

  it('JSON tronqué : lève, au lieu de passer pour absent', async () => {
    fs.writeFileSync(metadataPath(), RATTACHEMENTS.slice(0, 60));

    await expect(BibliographyMetadataService.loadMetadata(tmpDir)).rejects.toMatchObject({
      code: 'metadata-unreadable',
      filePath: metadataPath(),
    });
  });

  it('un JSON qui n’est pas un fichier de métadonnées lève aussi', async () => {
    fs.writeFileSync(metadataPath(), '[]');

    await expect(BibliographyMetadataService.loadMetadata(tmpDir)).rejects.toMatchObject({ code: 'metadata-unreadable' });
  });

  it('BOM en tête : lu, pas pris pour un fichier abîmé', async () => {
    fs.writeFileSync(metadataPath(), `\uFEFF${RATTACHEMENTS}`);

    const loaded = await BibliographyMetadataService.loadMetadata(tmpDir);

    expect(Object.keys(loaded?.citations ?? {})).toEqual(['ABCD1234']);
  });

  // Ni fichier neuf à la place, ni mise de côté : le bandeau demande à l'historien de le réparer ou
  // d'en remettre une copie (L05-3).
  const untouched = async (write: () => Promise<void>) => {
    const damaged = RATTACHEMENTS.slice(0, 60);
    fs.writeFileSync(metadataPath(), damaged);
    const before = fs.readdirSync(path.dirname(metadataPath()));

    await expect(write()).rejects.toMatchObject({ code: 'metadata-unreadable' });
    expect(fs.readFileSync(metadataPath(), 'utf8')).toBe(damaged);
    expect(fs.readdirSync(path.dirname(metadataPath()))).toEqual(before);
  };

  it('un rattachement ne remplace pas un fichier illisible', async () => {
    await untouched(() =>
      BibliographyMetadataService.patchAttachment(
        tmpDir,
        makeCitation({ zoteroKey: 'ABCD1234', zoteroAttachments: [attachment('att')] }),
        'att',
        '/projet/PDFs/a.pdf'
      )
    );
  });

  it('la synchronisation ne remplace pas un fichier devenu illisible pendant qu’elle tournait', async () => {
    await untouched(() =>
      BibliographyMetadataService.saveFromSync(tmpDir, [makeCitation({ zoteroKey: 'ABCD1234', zoteroAttachments: [attachment('att')] })])
    );
  });
});

/**
 * D18 : `.cliodeck` lié hors du projet. Une synchronisation Zotero écrivait les pièces jointes du
 * projet dans le dossier d'un autre, et les relisait de là.
 */
describe.skipIf(!symlinkAvailable)('BibliographyMetadataService — .cliodeck lié hors du projet', () => {
  let tmpDir: string;
  let outside: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cliodeck-biblio-meta-'));
    outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cliodeck-biblio-meta-ailleurs-'));
    fs.symlinkSync(outside, path.join(tmpDir, '.cliodeck'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    await fs.promises.rm(outside, { recursive: true, force: true });
  });

  it('ni écrit ni lu à l’autre bout du lien', async () => {
    const theirs = path.join(outside, 'bibliography-metadata.json');
    const content = JSON.stringify({ version: 2, lastUpdated: 'x', citations: { AUTRE: { id: 'autre' } } });
    fs.writeFileSync(theirs, content);

    await BibliographyMetadataService.saveFromSync(tmpDir, [makeCitation({ zoteroKey: 'ABCD1234' })]);
    await BibliographyMetadataService.patchAttachment(
      tmpDir,
      makeCitation({ zoteroKey: 'ABCD1234', zoteroAttachments: [attachment('att')] }),
      'att',
      path.join(tmpDir, 'PDFs', 'a.pdf')
    );

    expect(await BibliographyMetadataService.loadMetadata(tmpDir)).toBeNull();
    expect(fs.readFileSync(theirs, 'utf8')).toBe(content);
    expect(fs.readdirSync(outside)).toEqual(['bibliography-metadata.json']);
  });
});

/**
 * Un rattachement de PDF s'écrit seul (S07-1-5). Le renderer réécrivait tout le fichier à partir
 * de sa liste de références, prise avant le téléchargement : deux téléchargements simultanés
 * s'effaçaient l'un l'autre, et une synchronisation effaçait ceux faits pendant qu'elle tournait.
 */
describe('BibliographyMetadataService — patchAttachment', () => {
  let tmpDir: string;
  const pdf = (name: string) => path.join(tmpDir, 'PDFs', `${name}.pdf`);
  const stored = async () => (await BibliographyMetadataService.loadMetadata(tmpDir))!.citations;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cliodeck-biblio-meta-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('20 rattachements simultanés : les 20 sont écrits', async () => {
    const citations = Array.from({ length: 20 }, (_, i) =>
      makeCitation({ id: `Lester_${i}`, zoteroKey: `ZK${i}`, zoteroAttachments: [attachment(`ATT${i}`)] })
    );
    await BibliographyMetadataService.saveFromSync(tmpDir, citations);

    await Promise.all(
      citations.map((c, i) => BibliographyMetadataService.patchAttachment(tmpDir, c, `ATT${i}`, pdf(`n${i}`)))
    );

    const after = await stored();
    expect(Object.keys(after)).toHaveLength(20);
    for (let i = 0; i < 20; i++) {
      expect(after[`ZK${i}`].zoteroAttachments).toEqual([{ ...attachment(`ATT${i}`), downloaded: true, localPath: pdf(`n${i}`) }]);
    }
  });

  it('ne touche que cette pièce jointe de cette entrée', async () => {
    const tags = [{ tag: 'presse', automatic: false }];
    const other = makeCitation({ id: 'Autre_1936', zoteroKey: 'OTHER', zoteroAttachments: [attachment('ATTO')], zoteroTags: tags });
    const target = makeCitation({
      zoteroKey: 'TARGET',
      zoteroAttachments: [attachment('ATT1'), attachment('ATT2')],
      zoteroTags: tags,
      dateAdded: '2021-01-01',
    });
    await BibliographyMetadataService.saveFromSync(tmpDir, [other, target]);
    const before = await stored();

    // La référence du renderer peut différer du fichier : seul le rattachement compte.
    await BibliographyMetadataService.patchAttachment(tmpDir, { ...target, zoteroTags: [] }, 'ATT2', pdf('deux'));

    const after = await stored();
    expect(after.OTHER).toEqual(before.OTHER);
    expect(after.TARGET).toEqual({
      ...before.TARGET,
      zoteroAttachments: [attachment('ATT1'), { ...attachment('ATT2'), downloaded: true, localPath: pdf('deux') }],
    });
  });

  it('une entrée qui manque est créée depuis la référence', async () => {
    const citation = makeCitation({
      zoteroKey: 'NEW1',
      zoteroAttachments: [attachment('ATTN')],
      zoteroTags: [{ tag: 'lu', automatic: false }],
    });

    await BibliographyMetadataService.patchAttachment(tmpDir, citation, 'ATTN', pdf('nouveau'));

    expect((await stored()).NEW1).toEqual({
      id: 'Lester_1935',
      zoteroKey: 'NEW1',
      zoteroAttachments: [{ ...attachment('ATTN'), downloaded: true, localPath: pdf('nouveau') }],
      zoteroTags: [{ tag: 'lu', automatic: false }],
    });
  });

  it('une référence sans clé Zotero est rangée sous sa clé BibTeX', async () => {
    await BibliographyMetadataService.patchAttachment(
      tmpDir,
      makeCitation({ id: 'manuel_2020', zoteroAttachments: [attachment('ATTM')] }),
      'ATTM',
      pdf('manuel')
    );

    expect((await stored()).manuel_2020.zoteroAttachments?.[0]).toMatchObject({ downloaded: true, localPath: pdf('manuel') });
  });
});

/**
 * La synchronisation écrit ce qu'elle a lu de Zotero, sur le fichier tel qu'il est au moment
 * d'écrire (S07-1-6). Elle remplaçait le fichier par l'état lu à son début : un PDF rattaché
 * pendant ses minutes de lecture perdait son rattachement.
 */
describe('BibliographyMetadataService — saveFromSync relit le fichier', () => {
  let tmpDir: string;
  const pdf = (name: string) => path.join(tmpDir, 'PDFs', `${name}.pdf`);
  const stored = async () => (await BibliographyMetadataService.loadMetadata(tmpDir))!.citations;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cliodeck-biblio-meta-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('un PDF rattaché depuis la lecture de la synchronisation reste rattaché', async () => {
    const x = makeCitation({ zoteroKey: 'XKEY', zoteroAttachments: [attachment('ATTX')] });
    await BibliographyMetadataService.saveFromSync(tmpDir, [x]);
    // La synchronisation a lu l'état ci-dessus ; pendant qu'elle lit Zotero, le PDF de X arrive.
    const readBySync = [{ ...x, zoteroTags: [{ tag: 'nouveau', automatic: false }] }];
    await BibliographyMetadataService.patchAttachment(tmpDir, x, 'ATTX', pdf('x'));

    await BibliographyMetadataService.saveFromSync(tmpDir, readBySync);

    const after = await stored();
    expect(after.XKEY.zoteroAttachments).toEqual([{ ...attachment('ATTX'), downloaded: true, localPath: pdf('x') }]);
    expect(after.XKEY.zoteroTags).toEqual([{ tag: 'nouveau', automatic: false }]);
  });

  it('ce qui vient de Zotero vient de la synchronisation, et une entrée qu’elle a supprimée part', async () => {
    const kept = makeCitation({ zoteroKey: 'KEPT', zoteroAttachments: [attachment('ATTK', 'ancien.pdf')], dateModified: '2020' });
    const gone = makeCitation({ id: 'Parti_1940', zoteroKey: 'GONE', zoteroAttachments: [attachment('ATTG')] });
    await BibliographyMetadataService.saveFromSync(tmpDir, [kept, gone]);
    await BibliographyMetadataService.patchAttachment(tmpDir, gone, 'ATTG', pdf('parti'));

    await BibliographyMetadataService.saveFromSync(tmpDir, [
      { ...kept, zoteroAttachments: [attachment('ATTK', 'renomme.pdf'), attachment('ATTK2')], dateModified: '2026' },
    ]);

    const after = await stored();
    expect(Object.keys(after)).toEqual(['KEPT']);
    expect(after.KEPT).toMatchObject({
      dateModified: '2026',
      zoteroAttachments: [attachment('ATTK', 'renomme.pdf'), attachment('ATTK2')],
    });
  });

  it('une pièce jointe retirée dans Zotero ne revient pas avec son rattachement', async () => {
    const x = makeCitation({ zoteroKey: 'XKEY', zoteroAttachments: [attachment('ATTX'), attachment('ATTY')] });
    await BibliographyMetadataService.saveFromSync(tmpDir, [x]);
    await BibliographyMetadataService.patchAttachment(tmpDir, x, 'ATTY', pdf('y'));

    await BibliographyMetadataService.saveFromSync(tmpDir, [{ ...x, zoteroAttachments: [attachment('ATTX')] }]);

    expect((await stored()).XKEY.zoteroAttachments).toEqual([attachment('ATTX')]);
  });
});
