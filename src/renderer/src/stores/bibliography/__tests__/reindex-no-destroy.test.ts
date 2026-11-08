/**
 * @vitest-environment jsdom
 *
 * « Réindexer » une référence ne détruit plus rien avant d'avoir le remplaçant (S03-1-3, S03-2-2).
 *
 * Le bouton de la fiche supprimait d'abord le document indexé (`pdf.delete`), puis indexait. Ollama
 * arrêté, PDF devenu illisible, délai du worker : la référence sortait du corpus, et le chat ne la
 * trouvait plus. Même réussie, la suppression passait à NULL les citations des autres documents qui
 * pointaient vers elle. Or `pdf:index` remplace déjà le document de ce fichier, après avoir écrit
 * les nouveaux extraits, en lui rattachant citations et collections (`mergeDocumentsInto`).
 *
 * Et la fiche prenait `citation.file` sans `isPdfPath` : une notice dont le champ `file` est un
 * instantané HTML hérité (`PDFs/1706.html`) indexait le HTML, qui échoue, au lieu du PDF connu.
 *
 * Le main est simulé : un corpus, un `pdf:index` qui remplace le document du même fichier quand il
 * réussit et ne touche à rien quand il échoue, un `pdf:delete` qui retire le document et coupe ses
 * citations entrantes, comme `ON DELETE SET NULL`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBibliographyStore } from '../../bibliographyStore';
import { useProjectStore } from '../../projectStore';
import type { Citation } from '../types';

const PDF = '/projet/PDFs/Vaswani_et_al._-_2017_-_Attention_Is_All_You_Need.pdf';
const SNAPSHOT = '/projet/PDFs/1706.html';
const DOWNLOADED = '/projet/PDFs/ATT1.pdf';

interface IndexedDocument {
  id: string;
  fileURL: string;
  bibtexKey?: string;
}

/** Le corpus du projet, et les citations d'autres documents vers un document de ce corpus. */
let corpus: IndexedDocument[] = [];
let incoming: Array<{ from: string; to: string | null }> = [];
/** La réponse du main à `pdf:index` : réussite, ou l'échec d'un fournisseur arrêté. */
let indexFails = false;
let indexPdf: ReturnType<typeof vi.fn>;
let deletePdf: ReturnType<typeof vi.fn>;
let originalElectron: unknown;

function citation(overrides: Partial<Citation>): Citation {
  return {
    id: 'Vaswani_2017',
    type: 'article',
    author: 'Vaswani, Ashish',
    year: '2017',
    title: 'Attention Is All You Need',
    ...overrides,
  };
}

function installMain(): void {
  indexPdf = vi.fn(async (file: string, bibtexKey?: string) => {
    if (indexFails) return { success: false, error: 'Embedding failed: fetch failed (Ollama)' };
    // Comme `PDFIndexer.indexPDF` : le nouveau document d'abord, puis les copies du même fichier
    // fondues en lui, citations entrantes rattachées.
    const id = `doc-${corpus.length + 1}`;
    const replaced = corpus.filter((d) => d.fileURL === file).map((d) => d.id);
    corpus = [...corpus.filter((d) => !replaced.includes(d.id)), { id, fileURL: file, bibtexKey }];
    incoming = incoming.map((c) => (c.to !== null && replaced.includes(c.to) ? { ...c, to: id } : c));
    return { success: true, document: { id } };
  });
  deletePdf = vi.fn(async (id: string) => {
    corpus = corpus.filter((d) => d.id !== id);
    incoming = incoming.map((c) => (c.to === id ? { ...c, to: null } : c));
    return { success: true };
  });
  (window as unknown as { electron: unknown }).electron = {
    pdf: {
      index: indexPdf,
      delete: deletePdf,
      getAll: vi.fn(async () => ({ success: true, documents: corpus })),
    },
  };
}

const bib = () => useBibliographyStore.getState();
const keysInCorpus = () => corpus.map((d) => d.bibtexKey);

beforeEach(() => {
  originalElectron = (window as unknown as { electron?: unknown }).electron;
  indexFails = false;
  // La référence est indexée, et un autre document du corpus la cite.
  corpus = [
    { id: 'doc-vaswani', fileURL: PDF, bibtexKey: 'Vaswani_2017' },
    { id: 'doc-citant', fileURL: '/projet/PDFs/Citant.pdf', bibtexKey: 'Citant_2020' },
  ];
  incoming = [{ from: 'doc-citant', to: 'doc-vaswani' }];
  installMain();
  useProjectStore.setState({
    currentProject: { id: 'projet', name: 'Projet', path: '/projet', type: 'article', createdAt: new Date(), lastOpenedAt: new Date() },
    loadState: { kind: 'idle' },
  });
  useBibliographyStore.setState({
    citations: [citation({ file: PDF })],
    indexedFilePaths: new Set([PDF]),
    indexedBibtexKeys: new Set(['Vaswani_2017', 'Citant_2020']),
  });
});

afterEach(() => {
  (window as unknown as { electron: unknown }).electron = originalElectron;
  vi.restoreAllMocks();
});

describe('« Réindexer » ne supprime rien avant d’avoir le remplaçant', () => {
  it('réussite : aucun pdf.delete, le document est remplacé et la citation entrante le suit', async () => {
    expect(await bib().reindexPDFFromCitation('Vaswani_2017')).toEqual({});

    expect(deletePdf).not.toHaveBeenCalled();
    expect(indexPdf).toHaveBeenCalledTimes(1);
    expect(indexPdf.mock.calls[0][0]).toBe(PDF);
    // Un seul document pour la référence, et le document qui la citait la cite toujours.
    expect(keysInCorpus().filter((k) => k === 'Vaswani_2017')).toHaveLength(1);
    const replacement = corpus.find((d) => d.bibtexKey === 'Vaswani_2017')!.id;
    expect(incoming).toEqual([{ from: 'doc-citant', to: replacement }]);
    expect(bib().indexedFilePaths.has(PDF)).toBe(true);
  });

  it('échec de l’indexation (Ollama arrêté) : l’erreur remonte, et rien n’est retiré', async () => {
    indexFails = true;
    const ended: Array<{ success: boolean; error?: string }> = [];
    const onEnd = (e: Event) => ended.push((e as CustomEvent<{ success: boolean; error?: string }>).detail);
    window.addEventListener('bibliography:indexing-end', onEnd);
    try {
      await expect(bib().reindexPDFFromCitation('Vaswani_2017')).rejects.toThrow(/fetch failed/);
    } finally {
      window.removeEventListener('bibliography:indexing-end', onEnd);
    }

    expect(deletePdf).not.toHaveBeenCalled();
    // La référence reste dans le corpus, cherchable par le chat, et sa citation entrante tient.
    expect(corpus.map((d) => d.id)).toEqual(['doc-vaswani', 'doc-citant']);
    expect(incoming).toEqual([{ from: 'doc-citant', to: 'doc-vaswani' }]);
    // La fiche la montre toujours indexée.
    expect(bib().indexedFilePaths.has(PDF)).toBe(true);
    // Le panneau des PDF apprend l'échec, avec son message.
    expect(ended).toEqual([expect.objectContaining({ success: false, error: expect.stringMatching(/fetch failed/) })]);
  });
});

describe('« Réindexer » une notice dont le champ file est un instantané HTML', () => {
  it('réindexe le PDF déjà indexé sous sa clé, pas le HTML', async () => {
    useBibliographyStore.setState({ citations: [citation({ file: SNAPSHOT })] });

    await bib().reindexPDFFromCitation('Vaswani_2017');

    expect(indexPdf.mock.calls.map((call) => call[0])).toEqual([PDF]);
    expect(deletePdf).not.toHaveBeenCalled();
  });

  it('sans document indexé, prend la pièce jointe Zotero téléchargée', async () => {
    corpus = corpus.filter((d) => d.bibtexKey !== 'Vaswani_2017');
    useBibliographyStore.setState({
      citations: [
        citation({
          file: SNAPSHOT,
          zoteroKey: 'S84VK4DC',
          zoteroAttachments: [
            { key: 'ATT1', filename: 'ATT1.pdf', contentType: 'application/pdf', downloaded: true, localPath: DOWNLOADED },
          ] as Citation['zoteroAttachments'],
        }),
      ],
    });

    await bib().reindexPDFFromCitation('Vaswani_2017');

    expect(indexPdf.mock.calls.map((call) => call[0])).toEqual([DOWNLOADED]);
  });

  it('rien d’autre que le HTML : refus avant tout appel, et rien n’est retiré', async () => {
    corpus = corpus.filter((d) => d.bibtexKey !== 'Vaswani_2017');
    const before = [...corpus];
    useBibliographyStore.setState({ citations: [citation({ file: SNAPSHOT })] });

    await expect(bib().reindexPDFFromCitation('Vaswani_2017')).rejects.toThrow(/No PDF file/);

    expect(indexPdf).not.toHaveBeenCalled();
    expect(deletePdf).not.toHaveBeenCalled();
    expect(corpus).toEqual(before);
  });
});
