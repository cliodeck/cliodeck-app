/**
 * @vitest-environment jsdom
 *
 * « Télécharger tous les PDFs manquants » (#125) : le lot ne posait `file`
 * qu'en mémoire. Si l'indexation échouait ou si l'app était fermée, le PDF
 * restait dans le dossier, mais l'entrée n'avait plus de fichier au
 * lancement suivant et « Indexer tous les PDFs » l'écartait sans la compter.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useBibliographyStore } from '../../bibliographyStore';
import { withDownloadedAttachment } from '../zoteroSlice';
import type { Citation } from '../types';
import { BibliographyMetadataService } from '../../../../../../backend/services/BibliographyMetadataService';

const PDF = '/projet/PDFs/Schuh_-_2024_-_AI_As_Artificial_Memory.pdf';

const fromBib = (): Citation => ({
  id: 'Schuh_2024',
  type: 'article',
  author: 'Schuh, Julian',
  year: '2024',
  title: 'AI As Artificial Memory',
  zoteroKey: 'ZK1',
  zoteroAttachments: [{ key: 'ATT1', filename: 'Schuh.pdf', contentType: 'application/pdf' }] as Citation['zoteroAttachments'],
});

let originalElectron: unknown;
let saveMetadata: ReturnType<typeof vi.fn>;

beforeEach(() => {
  originalElectron = (window as unknown as { electron?: unknown }).electron;
  saveMetadata = vi.fn().mockResolvedValue({ success: true });
  (window as unknown as { electron: unknown }).electron = {
    config: { get: vi.fn().mockResolvedValue({ mode: 'api', userId: 'u', apiKey: 'k' }) },
    project: { getConfig: vi.fn().mockResolvedValue({}) },
    zotero: { downloadPDF: vi.fn().mockResolvedValue({ success: true, filePath: PDF }) },
    // L'indexation échoue : c'est là que le lien se perdait.
    pdf: { index: vi.fn().mockResolvedValue({ success: false, error: 'Ollama éteint' }) },
    bibliography: { saveMetadata },
  };
  useBibliographyStore.setState({ citations: [fromBib()] });
});

afterEach(() => {
  (window as unknown as { electron: unknown }).electron = originalElectron;
});

describe('téléchargement en lot depuis Zotero (#125)', () => {
  it('sauvegarde le rattachement du PDF même quand l’indexation échoue', async () => {
    const result = await useBibliographyStore.getState().downloadAllMissingPDFs('/projet');

    expect(result.errors).toHaveLength(1);
    expect(saveMetadata).toHaveBeenCalledTimes(1);
    const saved = (saveMetadata.mock.calls[0][0] as { citations: Citation[] }).citations;
    expect(saved[0].zoteroAttachments?.[0]).toMatchObject({ downloaded: true, localPath: PDF });
  });

  it('au lancement suivant, l’entrée relue du .bib retrouve son PDF', async () => {
    await useBibliographyStore.getState().downloadAllMissingPDFs('/projet');
    const saved = (saveMetadata.mock.calls[0][0] as { citations: Citation[] }).citations;

    // Ce que `saveMetadata` écrit dans bibliography-metadata.json.
    const metadata = {
      version: 2,
      citations: Object.fromEntries(
        saved.map((c) => [c.zoteroKey ?? c.id, { id: c.id, zoteroKey: c.zoteroKey, zoteroAttachments: c.zoteroAttachments }])
      ),
    } as unknown as Parameters<typeof BibliographyMetadataService.mergeCitationsWithMetadata>[1];

    // Le service du main manipule le type `Citation` du backend (champs calculés
    // en plus) ; seuls les champs lus ici comptent.
    type BackendCitations = Parameters<typeof BibliographyMetadataService.mergeCitationsWithMetadata>[0];
    const [reloaded] = BibliographyMetadataService.mergeCitationsWithMetadata(
      [fromBib()] as unknown as BackendCitations,
      metadata
    );
    expect(reloaded.file).toBe(PDF);
  });
});

describe('withDownloadedAttachment', () => {
  it('pose le fichier et marque la seule pièce jointe téléchargée', () => {
    const c = fromBib();
    c.zoteroAttachments = [
      { key: 'ATT1', filename: 'a.pdf' },
      { key: 'ATT2', filename: 'b.pdf' },
    ] as Citation['zoteroAttachments'];
    const [updated] = withDownloadedAttachment([c], 'Schuh_2024', 'ATT2', PDF);

    expect(updated.file).toBe(PDF);
    expect(updated.zoteroAttachments?.[0]).not.toHaveProperty('downloaded');
    expect(updated.zoteroAttachments?.[1]).toMatchObject({ downloaded: true, localPath: PDF });
  });
});
