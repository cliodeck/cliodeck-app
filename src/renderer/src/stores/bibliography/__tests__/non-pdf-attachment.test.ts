/**
 * @vitest-environment jsdom
 *
 * Une notice peut désigner un fichier qui n'est pas un PDF : jusqu'au
 * 2026-09-14, la synchronisation Zotero rapatriait aussi les instantanés de
 * pages web. « Indexer tous les PDF » les prenait pour des PDF — quatre
 * erreurs « Invalid PDF structure » à chaque lot sur un projet réel — et
 * « Télécharger les PDF manquants » les prenait pour des PDF déjà là.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useBibliographyStore } from '../../bibliographyStore';
import type { Citation } from '../types';

const PDF = '/projet/PDFs/Fickers_-_2020_-_Update_für_die_Hermeneutik.pdf';
const SNAPSHOT = '/projet/PDFs/1706.html';
const SNAPSHOT_ONLY = '/projet/PDFs/damma-workshop-whitepaper.html';
const DOWNLOADED = '/projet/PDFs/Vaswani_et_al._-_2017_-_Attention_Is_All_You_Need.pdf';

const citations = (): Citation[] => [
  { id: 'Fickers_2020', type: 'article', author: 'Fickers, Andreas', year: '2020', title: 'Update für die Hermeneutik', file: PDF },
  {
    id: 'Vaswani_2017',
    type: 'article',
    author: 'Vaswani, Ashish',
    year: '2017',
    title: 'Attention Is All You Need',
    file: SNAPSHOT,
    zoteroKey: 'S84VK4DC',
    zoteroAttachments: [
      { key: 'ATT1', filename: 'Vaswani et al. - 2017 - Attention Is All You Need.pdf', contentType: 'application/pdf' },
    ] as Citation['zoteroAttachments'],
  },
  { id: 'Bultmann_2022', type: 'article', author: 'Bultmann, Daniel', year: '2022', title: 'DAMMA Workshop', file: SNAPSHOT_ONLY },
];

let originalElectron: unknown;
let indexPdf: ReturnType<typeof vi.fn>;
let downloadPdf: ReturnType<typeof vi.fn>;

beforeEach(() => {
  originalElectron = (window as unknown as { electron?: unknown }).electron;
  indexPdf = vi.fn().mockResolvedValue({ success: true });
  downloadPdf = vi.fn().mockResolvedValue({ success: true, filePath: DOWNLOADED });
  (window as unknown as { electron: unknown }).electron = {
    config: { get: vi.fn().mockResolvedValue({ mode: 'api', userId: 'u', apiKey: 'k' }) },
    project: { getConfig: vi.fn().mockResolvedValue({}) },
    zotero: { downloadPDF: downloadPdf },
    pdf: { index: indexPdf, getAll: vi.fn().mockResolvedValue({ success: true, documents: [] }) },
    bibliography: { saveMetadata: vi.fn().mockResolvedValue({ success: true }) },
  };
  useBibliographyStore.setState({
    citations: citations(),
    indexedFilePaths: new Set<string>(),
    indexedBibtexKeys: new Set<string>(),
  });
});

afterEach(() => {
  (window as unknown as { electron: unknown }).electron = originalElectron;
});

describe('pièce jointe qui n’est pas un PDF', () => {
  it('« Indexer tous les PDF » n’envoie que les PDF, sans compter d’erreur', async () => {
    const result = await useBibliographyStore.getState().indexAllPDFs();

    expect(indexPdf.mock.calls.map((call) => call[0])).toEqual([PDF]);
    expect(result).toEqual({ indexed: 1, skipped: 0, errors: [] });
  });

  it('« Télécharger les PDF manquants » va chercher le PDF d’une notice qui n’a qu’un instantané', async () => {
    await useBibliographyStore.getState().downloadAllMissingPDFs('/projet');

    expect(downloadPdf).toHaveBeenCalledTimes(1);
    expect(downloadPdf.mock.calls[0][0]).toMatchObject({ attachmentKey: 'ATT1' });
    const vaswani = useBibliographyStore.getState().citations.find((c) => c.id === 'Vaswani_2017');
    expect(vaswani?.file).toBe(DOWNLOADED);
  });

  it('indexer à l’unité une notice sans PDF est refusé avant tout appel', async () => {
    await expect(useBibliographyStore.getState().indexPDFFromCitation('Bultmann_2022')).rejects.toThrow();
    expect(indexPdf).not.toHaveBeenCalled();
  });
});
