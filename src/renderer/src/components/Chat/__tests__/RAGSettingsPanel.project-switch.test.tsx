// @vitest-environment jsdom
/**
 * Panneau RAG resté ouvert pendant un changement de projet : les documents et les collections
 * proposés sont relus pour le projet entrant (S15-1-10).
 *
 * Ils n'étaient chargés qu'à l'ouverture du panneau, si la liste était vide : le registre les vide
 * à la bascule, et sans relecture le panneau de B n'aurait plus rien proposé jusqu'à sa réouverture.
 *
 * Vrais panneau, store et registre ; seul le pont `window.electron` est simulé, par projet.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

vi.mock('../CollectionMultiSelect', () => ({
  CollectionMultiSelect: () => <div data-testid="collections-stub" />,
}));
vi.mock('../DocumentMultiSelect', () => ({
  DocumentMultiSelect: () => <div data-testid="documents-stub" />,
}));

import { RAGSettingsPanel } from '../RAGSettingsPanel';
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

const DOCUMENTS: Record<Served, unknown[]> = {
  A: [{ id: 'doc-a', title: 'Le préfet et la grève' }],
  B: [{ id: 'doc-b', title: 'Les comités de 1936' }],
};
const COLLECTIONS: Record<Served, unknown[]> = {
  A: [{ key: 'GUERRE', name: 'Guerre froide' }],
  B: [{ key: 'FRONT', name: 'Front populaire' }],
};

function show(p: Served | null): void {
  projectLifecycle.enter(p ? project(p).path : null);
  useProjectStore.setState({ currentProject: p ? project(p) : null });
}

beforeEach(() => {
  served = 'A';
  originalElectron = (window as unknown as { electron?: unknown }).electron;
  (window as unknown as { electron: unknown }).electron = {
    config: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => ({ success: true })),
      getAll: vi.fn(async () => ({ llm: {}, rag: {} })),
    },
    ollama: {
      listModels: vi.fn(async () => ({ success: true, models: [] })),
      showModel: vi.fn(async () => ({ success: false })),
    },
    embeddedLLM: { isDownloaded: vi.fn(async () => ({ success: true, downloaded: false })) },
    corpus: { getCollections: vi.fn(async () => ({ success: true, collections: COLLECTIONS[served] })) },
    pdf: { getAll: vi.fn(async () => ({ success: true, documents: DOCUMENTS[served] })) },
    project: { getConfig: vi.fn(async () => null) },
  };
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  show('A');
  useRAGQueryStore.setState({
    isSettingsPanelOpen: true,
    availableDocuments: [],
    availableCollections: [],
    isLoadingDocuments: false,
    isLoadingCollections: false,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  show(null);
  useRAGQueryStore.setState({ isSettingsPanelOpen: false });
  (window as unknown as { electron?: unknown }).electron = originalElectron;
});

it('le panneau ouvert relit documents et collections pour le projet entrant', async () => {
  render(<RAGSettingsPanel />);
  await waitFor(() => expect(useRAGQueryStore.getState().availableDocuments.map((d) => d.id)).toEqual(['doc-a']));
  await waitFor(() => expect(useRAGQueryStore.getState().availableCollections.map((c) => c.key)).toEqual(['GUERRE']));

  await act(async () => {
    projectLifecycle.beginTransition();
    served = 'B';
    show('B');
  });

  await waitFor(() => expect(useRAGQueryStore.getState().availableDocuments.map((d) => d.id)).toEqual(['doc-b']));
  await waitFor(() => expect(useRAGQueryStore.getState().availableCollections.map((c) => c.key)).toEqual(['FRONT']));
});
