/**
 * @vitest-environment jsdom
 *
 * « Télécharger tous les PDFs manquants » (#125) : le lot ne posait `file`
 * qu'en mémoire. Si l'indexation échouait ou si l'app était fermée, le PDF
 * restait dans le dossier, mais l'entrée n'avait plus de fichier au
 * lancement suivant et « Indexer tous les PDFs » l'écartait sans la compter.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { useBibliographyStore } from '../../bibliographyStore';
import { useProjectStore } from '../../projectStore';
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
/** Le projet sur le disque, où le main simulé écrit le rattachement par le vrai service. */
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-lot-zotero-'));
let updateAttachment: ReturnType<typeof vi.fn>;

beforeEach(() => {
  originalElectron = (window as unknown as { electron?: unknown }).electron;
  fs.rmSync(path.join(project, '.cliodeck'), { recursive: true, force: true });
  updateAttachment = vi.fn(
    async (options: { citation: Citation; attachmentKey: string; localPath: string }) => {
      await BibliographyMetadataService.patchAttachment(project, options.citation as never, options.attachmentKey, options.localPath);
      return { success: true };
    }
  );
  (window as unknown as { electron: unknown }).electron = {
    config: { get: vi.fn().mockResolvedValue({ mode: 'api', userId: 'u', apiKey: 'k' }) },
    project: { getConfig: vi.fn().mockResolvedValue({}) },
    zotero: { downloadPDF: vi.fn().mockResolvedValue({ success: true, filePath: PDF }) },
    // L'indexation échoue : c'est là que le lien se perdait.
    pdf: { index: vi.fn().mockResolvedValue({ success: false, error: 'Ollama éteint' }) },
    bibliography: { updateAttachment },
  };
  useBibliographyStore.setState({ citations: [fromBib()] });
  // Le lot s'arrête si son projet n'est plus l'ouvert (S18-2-0) : il est ouvert ici.
  useProjectStore.setState({
    currentProject: { id: 'projet', name: 'Projet', path: '/projet', type: 'article', createdAt: new Date(), lastOpenedAt: new Date() },
    loadState: { kind: 'idle' },
  });
});

afterEach(() => {
  (window as unknown as { electron: unknown }).electron = originalElectron;
});

afterAll(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

describe('téléchargement en lot depuis Zotero (#125)', () => {
  it('sauvegarde le rattachement du PDF même quand l’indexation échoue', async () => {
    const result = await useBibliographyStore.getState().downloadAllMissingPDFs('/projet');

    expect(result.errors).toHaveLength(1);
    expect(updateAttachment).toHaveBeenCalledTimes(1);
    expect(updateAttachment.mock.calls[0][0]).toMatchObject({ attachmentKey: 'ATT1', localPath: PDF });
    const written = await BibliographyMetadataService.loadMetadata(project);
    expect(written?.citations.ZK1.zoteroAttachments?.[0]).toMatchObject({ downloaded: true, localPath: PDF });
  });

  it('au lancement suivant, l’entrée relue du .bib retrouve son PDF', async () => {
    await useBibliographyStore.getState().downloadAllMissingPDFs('/projet');

    // Ce que le rattachement a écrit dans bibliography-metadata.json.
    const metadata = await BibliographyMetadataService.loadMetadata(project);

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
