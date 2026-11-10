// @vitest-environment jsdom
/**
 * Similarité : panneau ou options restés ouverts pendant un changement de projet (S18-1-25).
 *
 * Le cache n'était relu qu'à l'ouverture du panneau : resté ouvert, il gardait les segments et les
 * recommandations de A. Les collections du filtre n'étaient chargées qu'au montage des options, et
 * seulement si la liste était vide : celles de A restaient proposées dans B.
 *
 * Vrais panneaux, stores et registre ; seul le pont `window.electron` est simulé, par projet.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

vi.mock('../../Chat/CollectionMultiSelect', () => ({
  CollectionMultiSelect: () => <div data-testid="collections-stub" />,
}));
vi.mock('../SimilarityResults', () => ({
  SimilarityResults: () => <div data-testid="results-stub" />,
}));

import { SimilarityPanel } from '../SimilarityPanel';
import { SimilarityOptions } from '../SimilarityOptions';
import { useSimilarityStore } from '../../../stores/similarityStore';
import { useRAGQueryStore } from '../../../stores/ragQueryStore';
import { useProjectStore } from '../../../stores/projectStore';
import { projectLifecycle } from '../../../lifecycle/projectLifecycle';

type Served = 'A' | 'B';
let served: Served;
let originalElectron: unknown;

const project = (p: Served) => ({
  id: p,
  name: `Projet ${p}`,
  path: `/projets/${p}`,
  type: 'article' as const,
  createdAt: new Date(),
  lastOpenedAt: new Date(),
});

const result = (id: string) => ({
  segmentId: id,
  segment: { id, content: `Segment ${id}`, startLine: 1, endLine: 2, type: 'paragraph' },
  recommendations: [],
  analyzedAt: 1,
});

const CACHE: Record<Served, unknown[]> = { A: [result('seg-a')], B: [result('seg-b')] };
const COLLECTIONS: Record<Served, unknown[]> = {
  A: [{ key: 'GUERRE', name: 'Guerre froide' }],
  B: [{ key: 'FRONT', name: 'Front populaire' }],
};

function show(p: Served | null): void {
  projectLifecycle.enter(p ? project(p).path : null);
  useProjectStore.setState({ currentProject: p ? project(p) : null });
}

async function switchTo(p: Served): Promise<void> {
  await act(async () => {
    projectLifecycle.beginTransition();
    served = p;
    show(p);
  });
}

beforeEach(() => {
  served = 'A';
  originalElectron = (window as unknown as { electron?: unknown }).electron;
  (window as unknown as { electron: unknown }).electron = {
    similarity: {
      getAllResults: vi.fn(async () => ({ success: true, results: CACHE[served] })),
      onProgress: vi.fn(() => () => undefined),
      cancel: vi.fn(async () => ({ success: true })),
    },
    corpus: { getCollections: vi.fn(async () => ({ success: true, collections: COLLECTIONS[served] })) },
    project: { getConfig: vi.fn(async () => null) },
  };
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  show('A');
  useSimilarityStore.setState({ results: new Map(), isPanelOpen: true, isAnalyzing: false });
  useRAGQueryStore.setState({ availableCollections: [], isLoadingCollections: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  show(null);
  useSimilarityStore.setState({ isPanelOpen: false, results: new Map() });
  (window as unknown as { electron?: unknown }).electron = originalElectron;
});

it('le panneau ouvert relit le cache du projet entrant', async () => {
  render(<SimilarityPanel />);
  await waitFor(() => expect([...useSimilarityStore.getState().results.keys()]).toEqual(['seg-a']));

  await switchTo('B');

  await waitFor(() => expect([...useSimilarityStore.getState().results.keys()]).toEqual(['seg-b']));
});

it('les options ouvertes relisent les collections du projet entrant', async () => {
  render(<SimilarityOptions onClose={() => undefined} />);
  await waitFor(() => expect(useRAGQueryStore.getState().availableCollections.map((c) => c.key)).toEqual(['GUERRE']));

  await switchTo('B');

  await waitFor(() => expect(useRAGQueryStore.getState().availableCollections.map((c) => c.key)).toEqual(['FRONT']));
});
