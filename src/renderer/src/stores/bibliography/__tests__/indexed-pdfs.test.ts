/**
 * @vitest-environment jsdom
 *
 * Un PDF n'est « indexé » que s'il est cherchable (S03-1-0).
 *
 * `refreshIndexedPDFs` comptait indexé tout document que rend `pdf:get-all`, extraits ou pas. Une
 * indexation interrompue avant ses extraits (Ollama arrêté, app quittée en route) laissait un
 * document vide : « Indexer tous les PDF » ne le reproposait plus, l'action de la fiche répondait
 * « déjà indexé », et la recherche ne le trouvait jamais. L'indexeur n'écrit plus de tel document,
 * mais une base l'a peut-être gardé d'avant : le prochain lot doit le reprendre.
 *
 * Un PDF sans couche de texte (`lowText`, #132) n'a pas d'extrait non plus, et pourtant il est
 * indexé : le reproposer referait le même travail pour rien, à chaque lot.
 *
 * Le main est simulé : `pdf:get-all` rend ce que rend `VectorStore.getAllDocuments` (`chunkCount`,
 * métadonnées avec `textDensity`), `pdf:index` réussit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBibliographyStore } from '../../bibliographyStore';
import { useProjectStore } from '../../projectStore';
import type { Citation } from '../types';

/** Indexé avant qu'Ollama ne tombe : un document, aucun extrait. */
const EMPTY = '/projet/PDFs/Fickers_2020.pdf';
/** Même cas, sous une autre clé, pour un document dont le chemin a changé depuis. */
const EMPTY_MOVED = '/projet/PDFs/Ranges/Hughes_2025.pdf';
/** Un scan sans OCR : aucun extrait, et pourtant indexé. */
const SCAN = '/projet/PDFs/Wang_2025.pdf';
/** Indexé pour de bon. */
const INDEXED = '/projet/PDFs/Kansteiner_2022.pdf';

const citation = (id: string, file: string): Citation => ({
  id,
  type: 'article',
  author: 'Auteur',
  year: '2020',
  title: id,
  file,
});

const documents = [
  { id: 'doc-fickers', fileURL: EMPTY, bibtexKey: 'Fickers_2020', chunkCount: 0, metadata: {} },
  {
    id: 'doc-hughes',
    fileURL: '/projet/PDFs/Hughes_2025.pdf',
    bibtexKey: 'Hughes_2025',
    chunkCount: 0,
    metadata: { textDensity: { charsPerPage: 1800, lowText: false } },
  },
  {
    id: 'doc-wang',
    fileURL: SCAN,
    bibtexKey: 'Wang_2025',
    chunkCount: 0,
    metadata: { textDensity: { charsPerPage: 0, lowText: true } },
  },
  {
    id: 'doc-kansteiner',
    fileURL: INDEXED,
    bibtexKey: 'Kansteiner_2022',
    chunkCount: 12,
    metadata: { textDensity: { charsPerPage: 2100, lowText: false } },
  },
];

let originalElectron: unknown;
let indexPdf: ReturnType<typeof vi.fn>;
const bib = () => useBibliographyStore.getState();

beforeEach(() => {
  originalElectron = (window as unknown as { electron?: unknown }).electron;
  indexPdf = vi.fn().mockResolvedValue({ success: true });
  (window as unknown as { electron: unknown }).electron = {
    pdf: { index: indexPdf, getAll: vi.fn().mockResolvedValue({ success: true, documents }) },
  };
  useBibliographyStore.setState({
    citations: [
      citation('Fickers_2020', EMPTY),
      citation('Hughes_2025', EMPTY_MOVED),
      citation('Wang_2025', SCAN),
      citation('Kansteiner_2022', INDEXED),
    ],
    indexedFilePaths: new Set<string>(),
    indexedBibtexKeys: new Set<string>(),
  });
  // Les lots s'arrêtent si leur projet n'est plus l'ouvert (S18-2-0) : il est ouvert ici.
  useProjectStore.setState({
    currentProject: { id: 'projet', name: 'Projet', path: '/projet', type: 'article', createdAt: new Date(), lastOpenedAt: new Date() },
    loadState: { kind: 'idle' },
  });
});

afterEach(() => {
  (window as unknown as { electron: unknown }).electron = originalElectron;
});

describe('documents sans extrait', () => {
  it('sans extrait et sans lowText : ni le fichier ni la clé ne comptent comme indexés', async () => {
    await bib().refreshIndexedPDFs();

    expect(bib().isFileIndexed(EMPTY)).toBe(false);
    expect(bib().isBibtexKeyIndexed('Fickers_2020')).toBe(false);
    // Le fichier de la notice n'est plus celui du document : seule la clé l'aurait fait compter.
    expect(bib().isFileIndexed(EMPTY_MOVED)).toBe(false);
    expect(bib().isBibtexKeyIndexed('Hughes_2025')).toBe(false);
  });

  it('sans extrait mais lowText : compté indexé, comme un document qui a ses extraits', async () => {
    await bib().refreshIndexedPDFs();

    expect(bib().isFileIndexed(SCAN)).toBe(true);
    expect(bib().isBibtexKeyIndexed('Wang_2025')).toBe(true);
    expect(bib().isFileIndexed(INDEXED)).toBe(true);
    expect(bib().isBibtexKeyIndexed('Kansteiner_2022')).toBe(true);
  });

  it('« Indexer tous les PDF » repropose les documents vides, et eux seuls', async () => {
    const result = await bib().indexAllPDFs('/projet');

    expect(indexPdf.mock.calls.map((call) => call[0]).sort()).toEqual([EMPTY, EMPTY_MOVED].sort());
    expect(result).toMatchObject({ indexed: 2, skipped: 0, errors: [] });
  });

  it('l’action de la notice indexe un document vide, et répond « déjà indexé » pour le scan', async () => {
    await bib().refreshIndexedPDFs();

    expect(await bib().indexPDFFromCitation('Fickers_2020')).toEqual({ alreadyIndexed: false });
    expect(await bib().indexPDFFromCitation('Wang_2025')).toEqual({ alreadyIndexed: true });
    expect(indexPdf.mock.calls.map((call) => call[0])).toEqual([EMPTY]);
  });
});
