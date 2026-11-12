/**
 * @vitest-environment jsdom
 *
 * Un PDF refusé parce que son embedding n'a pas la dimension du corpus (le modèle d'embeddings a
 * changé depuis la première indexation) se dit en clair, avec le geste qui le règle (L04-7).
 *
 * Le main renvoie un code et les deux dimensions (`embedding_dimension_mismatch`) : l'historien lit
 * leur traduction, pas « Embedding dimension mismatch: expected 768, got 1024 ».
 *
 * Le main est simulé : `pdf:index` répond ce que répond le vrai handler à ce refus.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBibliographyStore } from '../../bibliographyStore';
import { useProjectStore } from '../../projectStore';
import type { Citation } from '../types';

const PDF = '/projet/PDFs/Monnet_1952.pdf';
const OTHER = '/projet/PDFs/Schuman_1950.pdf';

const REFUSAL = {
  success: false,
  error: 'Embedding dimension mismatch: expected 768, got 1024',
  code: 'embedding_dimension_mismatch',
  expected: 768,
  actual: 1024,
};

let originalElectron: unknown;

function citation(id: string, file: string, title: string): Citation {
  return { id, type: 'article', author: 'Monnet, Jean', year: '1952', title, file };
}

const bib = () => useBibliographyStore.getState();

/** Le message que lit l'historien : traduit, avec les deux dimensions et le geste qui règle l'écart. */
function expectTranslated(message: string): void {
  expect(message).not.toContain('Embedding dimension mismatch');
  expect(message).toContain('1024');
  expect(message).toContain('768');
  expect(message).toContain('« Purger la base »');
  expect(message).toContain('« Indexer tous les PDFs »');
}

beforeEach(() => {
  originalElectron = (window as unknown as { electron?: unknown }).electron;
  (window as unknown as { electron: unknown }).electron = {
    pdf: {
      index: vi.fn(async () => REFUSAL),
      getAll: vi.fn(async () => ({ success: true, documents: [] })),
    },
  };
  useProjectStore.setState({
    currentProject: { id: 'projet', name: 'Projet', path: '/projet', type: 'article', createdAt: new Date(), lastOpenedAt: new Date() },
    loadState: { kind: 'idle' },
  });
  useBibliographyStore.setState({
    citations: [citation('Monnet_1952', PDF, 'Mémorandum'), citation('Schuman_1950', OTHER, 'Déclaration')],
    indexedFilePaths: new Set(),
    indexedBibtexKeys: new Set(),
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  (window as unknown as { electron: unknown }).electron = originalElectron;
  vi.restoreAllMocks();
});

describe('PDF d’une autre dimension que le corpus : le code devient le message traduit', () => {
  it('« Indexer le PDF » d’une fiche', async () => {
    const error = await bib()
      .indexPDFFromCitation('Monnet_1952')
      .then(
        () => null,
        (e: unknown) => e
      );

    expect(error).toBeInstanceOf(Error);
    expectTranslated((error as Error).message);
    expect(bib().indexedFilePaths.has(PDF)).toBe(false);
  });

  it('« Ré-indexer » une fiche', async () => {
    const error = await bib()
      .reindexPDFFromCitation('Monnet_1952')
      .then(
        () => null,
        (e: unknown) => e
      );

    expectTranslated((error as Error).message);
  });

  it('« Indexer tous les PDFs » : le lot s’arrête au premier refus, que les suivants auraient eu de même', async () => {
    const result = await bib().indexAllPDFs('/projet');

    expect(window.electron.pdf.index).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ indexed: 0, skipped: 0, stoppedOnDimension: true, remaining: 1 });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].startsWith('Mémorandum: ')).toBe(true);
    expectTranslated(result.errors[0]);
    expect(bib().batchIndexing).toMatchObject({ isIndexing: false, current: 1, total: 2 });
  });
});
