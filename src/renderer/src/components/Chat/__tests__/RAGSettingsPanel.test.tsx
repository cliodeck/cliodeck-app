// @vitest-environment jsdom
/**
 * Fenêtre de contexte du panneau de chat : la limite vient d'Ollama
 * (`/api/show`), plus d'une table codée en dur, et l'utilisateur peut
 * saisir librement une valeur au-delà. Le modèle et la fenêtre choisis
 * sont écrits dans la configuration (`llm.ollamaChatModel`,
 * `llm.ollamaNumCtx`) — le même champ que les réglages de l'application.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

vi.mock('../CollectionMultiSelect', () => ({
  CollectionMultiSelect: () => <div data-testid="collections-stub" />,
}));
vi.mock('../DocumentMultiSelect', () => ({
  DocumentMultiSelect: () => <div data-testid="documents-stub" />,
}));

import { RAGSettingsPanel } from '../RAGSettingsPanel';
import { useRAGQueryStore } from '../../../stores/ragQueryStore';

interface ShowInfo {
  contextLength?: number;
  modelfileNumCtx?: number;
}

function installElectron(show: ShowInfo | Error) {
  const configSet = vi.fn(async (_key: string, _value: unknown) => ({ success: true }));
  const showModel = vi.fn(async (model: string) => {
    if (show instanceof Error) throw show;
    return { success: true, info: { model, ...show } };
  });
  (window as unknown as { electron: unknown }).electron = {
    config: {
      get: vi.fn(async () => ({})),
      set: configSet,
      getAll: vi.fn(async () => ({ llm: {}, rag: {} })),
    },
    ollama: {
      listModels: vi.fn(async () => ({ success: true, models: [] })),
      showModel,
    },
    embeddedLLM: { isDownloaded: vi.fn(async () => ({ success: true, downloaded: false })) },
    corpus: { getCollections: vi.fn(async () => ({ success: true, collections: [] })) },
    pdf: { getAll: vi.fn(async () => ({ success: true, documents: [] })) },
    project: { getConfig: vi.fn(async () => null) },
  };
  return { configSet, showModel };
}

const MODELS = [
  { id: 'qwen3.5:35b', name: 'qwen3.5:35b', size: '22 GB' },
  { id: 'gemma3:4b', name: 'gemma3:4b', size: '3 GB' },
];

function openAdvanced(): void {
  fireEvent.click(screen.getByText('ragPanel.advanced'));
}

function contextInput(): HTMLInputElement {
  return screen.getByLabelText('ragPanel.contextWindowInput') as HTMLInputElement;
}

describe('RAGSettingsPanel — fenêtre de contexte et modèle', () => {
  beforeEach(() => {
    useRAGQueryStore.setState((s) => ({
      ...s,
      isSettingsPanelOpen: true,
      availableModels: MODELS,
      params: { ...s.params, provider: 'ollama', model: 'qwen3.5:35b', numCtx: 4096 },
    }));
  });
  afterEach(() => {
    cleanup();
    useRAGQueryStore.setState((s) => ({ ...s, isSettingsPanelOpen: false, availableModels: [] }));
  });

  it('affiche la longueur déclarée par Ollama et l’offre en bouton', async () => {
    const { showModel } = installElectron({ contextLength: 1_010_000, modelfileNumCtx: 40_960 });
    render(<RAGSettingsPanel />);
    openAdvanced();

    await waitFor(() => expect(showModel).toHaveBeenCalledWith('qwen3.5:35b'));
    await screen.findByText(/ragPanel\.contextDeclared/);
    expect(screen.getByText(/ragPanel\.contextModelfile/)).toBeTruthy();

    // Le curseur monte au moins jusqu'à la longueur déclarée : l'ancienne
    // table plafonnait ce modèle à 4 096 jetons.
    const slider = screen.getByLabelText('ragPanel.contextWindow') as HTMLInputElement;
    expect(Number(slider.max)).toBeGreaterThanOrEqual(1_010_000);

    fireEvent.click(screen.getByText('ragPanel.contextUseModelMax'));
    expect(useRAGQueryStore.getState().params.numCtx).toBe(1_010_000);
  });

  it('accepte une saisie libre au-delà de la longueur déclarée et l’écrit dans la configuration', async () => {
    const { configSet } = installElectron({ contextLength: 262_144 });
    render(<RAGSettingsPanel />);
    openAdvanced();
    await screen.findByText(/ragPanel\.contextDeclared/);

    fireEvent.change(contextInput(), { target: { value: '1000000' } });
    fireEvent.blur(contextInput());

    expect(useRAGQueryStore.getState().params.numCtx).toBe(1_000_000);
    // Au-delà de la longueur d'entraînement : accepté, mais signalé.
    expect(screen.getByRole('status').textContent).toMatch(/contextAboveDeclared/);
    await waitFor(() => {
      expect(configSet).toHaveBeenCalledWith('llm', { ollamaNumCtx: 1_000_000 });
    });
  });

  it('borne une saisie absurde aux limites de sécurité au lieu de la rejeter', async () => {
    installElectron({ contextLength: 262_144 });
    render(<RAGSettingsPanel />);
    openAdvanced();

    fireEvent.change(contextInput(), { target: { value: '99999999' } });
    fireEvent.keyDown(contextInput(), { key: 'Enter' });
    expect(useRAGQueryStore.getState().params.numCtx).toBe(2_097_152);

    fireEvent.change(contextInput(), { target: { value: 'abc' } });
    fireEvent.blur(contextInput());
    // Saisie invalide : on revient à la valeur courante.
    expect(useRAGQueryStore.getState().params.numCtx).toBe(2_097_152);
    await act(async () => undefined);
  });

  it('retombe sur une estimation quand Ollama ne répond pas', async () => {
    installElectron(new Error('ECONNREFUSED'));
    render(<RAGSettingsPanel />);
    openAdvanced();
    await screen.findByText(/ragPanel\.contextEstimated/);
  });

  it('écrit le fournisseur en mise à jour partielle, sans relire toute la section', async () => {
    const { configSet } = installElectron({ contextLength: 131_072 });
    render(<RAGSettingsPanel />);
    const configGet = (window as unknown as { electron: { config: { get: ReturnType<typeof vi.fn> } } })
      .electron.config.get;

    fireEvent.change(screen.getByLabelText('ragSettings.provider'), { target: { value: 'ollama' } });
    expect(useRAGQueryStore.getState().params.provider).toBe('ollama');
    await waitFor(() => {
      expect(configSet).toHaveBeenCalledWith('llm', { generationProvider: 'ollama' });
    });
    expect(configGet).not.toHaveBeenCalled();
  });

  it('écrit le modèle choisi dans la configuration', async () => {
    const { configSet, showModel } = installElectron({ contextLength: 131_072 });
    render(<RAGSettingsPanel />);

    fireEvent.change(screen.getByLabelText(/Model/), { target: { value: 'gemma3:4b' } });
    expect(useRAGQueryStore.getState().params.model).toBe('gemma3:4b');
    await waitFor(() => {
      expect(configSet).toHaveBeenCalledWith('llm', { ollamaChatModel: 'gemma3:4b' });
    });
    // Et la longueur déclarée est relue pour le nouveau modèle.
    await waitFor(() => expect(showModel).toHaveBeenCalledWith('gemma3:4b'));
  });
});
