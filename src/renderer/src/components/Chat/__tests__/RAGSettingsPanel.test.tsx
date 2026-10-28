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
import { useWorkspaceModeStore } from '../../../stores/workspaceModeStore';

interface ShowInfo {
  contextLength?: number;
  modelfileNumCtx?: number;
  capabilities?: string[];
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

  it('propose de couper le raisonnement seulement pour un modèle pensant, et l’écrit en configuration', async () => {
    const { configSet } = installElectron({ contextLength: 262_144, capabilities: ['completion', 'thinking'] });
    render(<RAGSettingsPanel />);
    openAdvanced();
    const box = (await screen.findByLabelText('ragPanel.think')) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(useRAGQueryStore.getState().params.think).toBe(false);
    await waitFor(() => {
      expect(configSet).toHaveBeenCalledWith('llm', { ollamaThink: false });
    });
  });

  it('cache le réglage du raisonnement pour un modèle qui ne pense pas', async () => {
    installElectron({ contextLength: 131_072, capabilities: ['completion', 'tools'] });
    render(<RAGSettingsPanel />);
    openAdvanced();
    await screen.findByText(/ragPanel\.contextDeclared/);
    expect(screen.queryByLabelText('ragPanel.think')).toBeNull();
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

/**
 * Quatrième case « Mon manuscrit » (docs/poids-du-manuscrit.md, palier 2) :
 * la case montre la valeur EFFECTIVE — épinglée par l'utilisateur, sinon le
 * défaut de l'espace (Brainstorm : non) — et cliquer épingle pour la
 * session. Le mock de react-i18next rend le repli anglais quand il y en a
 * un, la clé sinon.
 */
describe('RAGSettingsPanel — « Mon manuscrit » (tri-état)', () => {
  const allSources = {
    includeBibliography: true,
    includePrimary: true,
    includeNotes: true,
    includeManuscript: undefined,
  };

  function manuscriptToggle(): HTMLInputElement {
    return screen.getByTestId('include-manuscript-toggle') as HTMLInputElement;
  }

  beforeEach(() => {
    useRAGQueryStore.setState((s) => ({
      ...s,
      isSettingsPanelOpen: true,
      availableModels: MODELS,
      params: { ...s.params, provider: 'ollama', model: 'qwen3.5:35b', numCtx: 4096, ...allSources },
    }));
    useWorkspaceModeStore.getState().setActive('write');
  });
  afterEach(() => {
    cleanup();
    useWorkspaceModeStore.getState().setActive('write');
    useRAGQueryStore.setState((s) => ({
      ...s,
      isSettingsPanelOpen: false,
      availableModels: [],
      params: { ...s.params, ...allSources },
    }));
  });

  it('suit l’espace quand rien n’est épinglé : cochée en Écrire, décochée en Brainstorm', async () => {
    installElectron({ contextLength: 131_072 });
    render(<RAGSettingsPanel />);

    expect(manuscriptToggle().checked).toBe(true);
    expect(screen.getByTestId('manuscript-toggle-hint').textContent).toContain(
      'Depends on the workspace: not consulted in Brainstorm, consulted elsewhere'
    );
    expect(screen.queryByTestId('manuscript-toggle-reset')).toBeNull();

    act(() => {
      useWorkspaceModeStore.getState().setActive('brainstorm');
    });
    expect(manuscriptToggle().checked).toBe(false);
    // Le défaut a parlé : rien n'a été écrit dans le magasin.
    expect(useRAGQueryStore.getState().params.includeManuscript).toBeUndefined();
    await act(async () => undefined);
  });

  it('cliquer épingle pour la session ; « rétablir le défaut » rend la main à l’espace', async () => {
    installElectron({ contextLength: 131_072 });
    useWorkspaceModeStore.getState().setActive('brainstorm');
    render(<RAGSettingsPanel />);
    expect(manuscriptToggle().checked).toBe(false);

    fireEvent.click(manuscriptToggle());
    expect(useRAGQueryStore.getState().params.includeManuscript).toBe(true);
    expect(manuscriptToggle().checked).toBe(true);
    expect(screen.getByTestId('manuscript-toggle-hint').textContent).toContain('Pinned for this session.');
    expect(screen.getByTestId('manuscript-toggle-reset').textContent).toBe('restore the default');

    // Un choix épinglé survit au changement d'espace.
    act(() => {
      useWorkspaceModeStore.getState().setActive('write');
    });
    expect(manuscriptToggle().checked).toBe(true);
    fireEvent.click(manuscriptToggle());
    expect(useRAGQueryStore.getState().params.includeManuscript).toBe(false);
    expect(manuscriptToggle().checked).toBe(false);

    fireEvent.click(screen.getByTestId('manuscript-toggle-reset'));
    expect(useRAGQueryStore.getState().params.includeManuscript).toBeUndefined();
    // Écrire → le défaut consulte le manuscrit.
    expect(manuscriptToggle().checked).toBe(true);
    expect(screen.queryByTestId('manuscript-toggle-reset')).toBeNull();
    await act(async () => undefined);
  });

  it('manuscrit seul reste une sélection valide ; l’avertissement n’apparaît que quand plus rien n’est consulté', async () => {
    installElectron({ contextLength: 131_072 });
    render(<RAGSettingsPanel />);

    act(() => {
      useRAGQueryStore.getState().setParams({
        includeBibliography: false,
        includePrimary: false,
        includeNotes: false,
      });
    });
    // Manuscrit seul (défaut de l'espace Écrire ; les notes de lecture, qui
    // suivent le même défaut, épinglées à non pour isoler le manuscrit) :
    // « Recherche dans : … », pas d'avertissement.
    act(() => {
      useRAGQueryStore.getState().setParams({ includeReadingNotes: false });
    });
    expect(manuscriptToggle().checked).toBe(true);
    expect(screen.getByTestId('search-in-hint').textContent).not.toContain('Select at least one source.');
    expect(screen.getByTestId('search-in-hint').textContent).toContain('Searching in:');

    // Décocher le manuscrit : plus rien d'effectif → avertissement.
    fireEvent.click(manuscriptToggle());
    expect(screen.getByTestId('search-in-hint').textContent).toContain('Select at least one source.');

    // Le recocher : la sélection « manuscrit seul » revient, sans avertissement.
    fireEvent.click(manuscriptToggle());
    expect(screen.getByTestId('search-in-hint').textContent).not.toContain('Select at least one source.');
    act(() => {
      useRAGQueryStore.getState().setParams({ includeReadingNotes: undefined });
    });
    await act(async () => undefined);
  });
});

/**
 * Cinquième case « Notes de lecture » : le même tri-état que « Mon
 * manuscrit » (défaut selon l'espace, épingle de session, « rétablir le
 * défaut »), « notes seules » comme sélection valide, et un sous-texte qui
 * dit quand la case est cochée mais les notes non consultées — index
 * désactivé, ou fournisseur distant sans consentement. Une sélection de
 * documents ne les retire pas de « Recherche dans : … ».
 */
describe('RAGSettingsPanel — « Notes de lecture » (cinquième case, tri-état)', () => {
  const allSources = {
    includeBibliography: true,
    includePrimary: true,
    includeNotes: true,
    includeManuscript: undefined,
    includeReadingNotes: undefined,
    selectedDocumentIds: [] as string[],
  };
  const localFlags = { indexEnabled: true, cloudConsent: false, generationIsCloud: false };

  function notesToggle(): HTMLInputElement {
    return screen.getByTestId('include-reading-notes-toggle') as HTMLInputElement;
  }
  const searchIn = () => screen.getByTestId('search-in-hint').textContent ?? '';
  const hint = () => screen.getByTestId('reading-notes-toggle-hint').textContent ?? '';

  beforeEach(() => {
    useRAGQueryStore.setState((s) => ({
      ...s,
      isSettingsPanelOpen: true,
      availableModels: MODELS,
      params: { ...s.params, provider: 'ollama', model: 'qwen3.5:35b', numCtx: 4096, ...allSources },
    }));
    useRAGQueryStore.getState().setReadingNotesFlags(localFlags);
    useWorkspaceModeStore.getState().setActive('write');
  });
  afterEach(() => {
    cleanup();
    useWorkspaceModeStore.getState().setActive('write');
    useRAGQueryStore.getState().setReadingNotesFlags(localFlags);
    useRAGQueryStore.setState((s) => ({
      ...s,
      isSettingsPanelOpen: false,
      availableModels: [],
      params: { ...s.params, ...allSources },
    }));
  });

  it('suit l’espace quand rien n’est épinglé ; cliquer épingle pour la session ; « rétablir le défaut » rend la main', async () => {
    installElectron({ contextLength: 131_072 });
    render(<RAGSettingsPanel />);

    expect(notesToggle().checked).toBe(true);
    expect(hint()).toContain('Depends on the workspace: not consulted in Brainstorm, consulted elsewhere');
    expect(screen.queryByTestId('reading-notes-toggle-reset')).toBeNull();

    act(() => {
      useWorkspaceModeStore.getState().setActive('brainstorm');
    });
    expect(notesToggle().checked).toBe(false);
    // Le défaut a parlé : rien n'a été écrit dans le magasin.
    expect(useRAGQueryStore.getState().params.includeReadingNotes).toBeUndefined();

    fireEvent.click(notesToggle());
    expect(useRAGQueryStore.getState().params.includeReadingNotes).toBe(true);
    expect(notesToggle().checked).toBe(true);
    expect(hint()).toContain('Pinned for this session.');
    expect(screen.getByTestId('reading-notes-toggle-reset').textContent).toBe('restore the default');
    // La case du manuscrit n'a pas bougé : les deux sont indépendantes.
    expect((screen.getByTestId('include-manuscript-toggle') as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByTestId('reading-notes-toggle-reset'));
    expect(useRAGQueryStore.getState().params.includeReadingNotes).toBeUndefined();
    // Brainstorm → le défaut ne consulte pas les notes.
    expect(notesToggle().checked).toBe(false);
    expect(screen.queryByTestId('reading-notes-toggle-reset')).toBeNull();
    await act(async () => undefined);
  });

  it('notes seules reste une sélection valide ; l’avertissement n’apparaît que quand plus rien n’est consulté', async () => {
    installElectron({ contextLength: 131_072 });
    render(<RAGSettingsPanel />);

    act(() => {
      useRAGQueryStore.getState().setParams({
        includeBibliography: false,
        includePrimary: false,
        includeNotes: false,
        includeManuscript: false,
      });
    });
    // Le mock de react-i18next rend le repli sans interpolation : la liste
    // n'est pas observable ici (elle l'est dans le test du résolveur), seule
    // l'alternative « Recherche dans » / avertissement l'est.
    expect(notesToggle().checked).toBe(true);
    expect(searchIn()).toContain('Searching in:');
    expect(searchIn()).not.toContain('Select at least one source.');

    fireEvent.click(notesToggle());
    expect(searchIn()).toContain('Select at least one source.');

    fireEvent.click(notesToggle());
    expect(searchIn()).not.toContain('Select at least one source.');
    await act(async () => undefined);
  });

  it('une sélection de documents garde les notes dans « Recherche dans » ; le sous-texte dit quand elles sont cochées mais non consultées', async () => {
    installElectron({ contextLength: 131_072 });
    render(<RAGSettingsPanel />);

    act(() => {
      useRAGQueryStore.getState().setParams({ selectedDocumentIds: ['d1'] });
    });
    // Le manuscrit sort (portée restreinte), les notes restent : le main les
    // restreint aux références choisies au lieu de les écarter. Le mock de
    // react-i18next rend les clés des sous-textes à options.
    expect(screen.getByTestId('manuscript-toggle-hint').textContent).toContain(
      'ragSettings.manuscriptExcludedHint'
    );
    expect(hint()).not.toContain('ragSettings.readingNotesExcludedHint');

    // Notes seules, documents choisis : toujours une sélection consultée.
    act(() => {
      useRAGQueryStore.getState().setParams({
        includeBibliography: false,
        includePrimary: false,
        includeNotes: false,
        includeManuscript: false,
      });
    });
    expect(searchIn()).toContain('Searching in:');
    expect(searchIn()).not.toContain('Select at least one source.');

    // Fournisseur distant sans consentement : cochées, mais non consultées —
    // et plus rien ne l'est.
    act(() => {
      useRAGQueryStore
        .getState()
        .setReadingNotesFlags({ indexEnabled: true, cloudConsent: false, generationIsCloud: true });
    });
    expect(notesToggle().checked).toBe(true);
    expect(hint()).toContain('ragSettings.readingNotesExcludedHint');
    expect(searchIn()).toContain('Select at least one source.');

    // Le consentement donné : consultées de nouveau.
    act(() => {
      useRAGQueryStore
        .getState()
        .setReadingNotesFlags({ indexEnabled: true, cloudConsent: true, generationIsCloud: true });
    });
    expect(hint()).not.toContain('ragSettings.readingNotesExcludedHint');
    expect(searchIn()).not.toContain('Select at least one source.');

    // Index désactivé : même sous-texte, quel que soit le fournisseur.
    act(() => {
      useRAGQueryStore
        .getState()
        .setReadingNotesFlags({ indexEnabled: false, cloudConsent: true, generationIsCloud: false });
    });
    expect(hint()).toContain('ragSettings.readingNotesExcludedHint');
    expect(searchIn()).toContain('Select at least one source.');
    await act(async () => undefined);
  });
});
