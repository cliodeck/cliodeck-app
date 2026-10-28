// @vitest-environment jsdom
/**
 * AssistantChat (ex-BrainstormChat) : settings toggle reveals ModeSelector
 * + RAGSettingsPanel and writes to the shared chatStore.chatSettings via
 * the projection hook.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// Mock heavy inner panels — we only care about mount + store projection.
vi.mock('../ModeSelector', () => ({
  ModeSelector: () => <div data-testid="mode-selector-stub" />,
}));
vi.mock('../RAGSettingsPanel', () => ({
  RAGSettingsPanel: () => <div data-testid="rag-settings-stub" />,
}));
// Avoid stray IPC from useBrainstormChat.
vi.mock('../../Brainstorm/useBrainstormChat', () => ({
  useBrainstormChat: () => ({
    send: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
    isStreaming: false,
    error: null,
  }),
}));

import { AssistantChat } from '../AssistantChat';
import { useChatStore } from '../../../stores/chatStore';
import { useRAGQueryStore } from '../../../stores/ragQueryStore';
import { useWorkspaceModeStore } from '../../../stores/workspaceModeStore';

describe('AssistantChat settings panel', () => {
  beforeEach(() => {
    useChatStore.getState().reset();
    // AssistantChat lit window.electron.config.get('llm') au montage
    // (garde de consentement + modèle actif) — le mock minimal évite le crash.
    (window as unknown as { electron: unknown }).electron = {
      config: { get: vi.fn(async () => null) },
    };
  });
  afterEach(() => {
    cleanup();
  });

  it('toggle reveals ModeSelector + RAGSettingsPanel', () => {
    render(<AssistantChat variant="full" />);
    expect(screen.queryByTestId('rag-settings-stub')).toBeNull();
    const btn = screen.getByTestId('brainstorm-settings-toggle');
    fireEvent.click(btn);
    expect(screen.getByTestId('rag-settings-stub')).toBeTruthy();
    expect(screen.getByTestId('mode-selector-stub')).toBeTruthy();
  });

  it('projection hook syncs ragQueryStore.params into chatStore.chatSettings', () => {
    render(<AssistantChat variant="full" />);
    // Primary-only: bibliography + notes off, primary on — resolver should
    // project `sourceType: 'primary'` with vault disabled.
    act(() => {
      useRAGQueryStore.getState().setParams({
        topK: 17,
        includeBibliography: false,
        includePrimary: true,
        includeNotes: false,
      });
    });
    const settings = useChatStore.getState().chatSettings;
    expect(settings.retrieval?.topK).toBe(17);
    expect(settings.retrieval?.sourceType).toBe('primary');
    expect(settings.retrieval?.includeVault).toBe(false);
  });

  it('projection maps bibliography+notes → secondary + includeVault', () => {
    render(<AssistantChat variant="full" />);
    act(() => {
      useRAGQueryStore.getState().setParams({
        includeBibliography: true,
        includePrimary: false,
        includeNotes: true,
      });
    });
    const settings = useChatStore.getState().chatSettings;
    expect(settings.retrieval?.sourceType).toBe('secondary');
    expect(settings.retrieval?.includeVault).toBe(true);
  });
});

describe('AssistantChat — prompt système personnalisé du panneau', () => {
  beforeEach(() => {
    useChatStore.getState().reset();
    (window as unknown as { electron: unknown }).electron = {
      config: { get: vi.fn(async () => null) },
    };
  });
  afterEach(() => {
    cleanup();
    useRAGQueryStore.getState().setParams({
      useCustomSystemPrompt: false,
      customSystemPrompt: undefined,
    });
  });

  it('projette le prompt du panneau quand sa case est cochée, et le retire sinon', () => {
    render(<AssistantChat variant="full" />);
    act(() => {
      useRAGQueryStore.getState().setParams({
        useCustomSystemPrompt: true,
        customSystemPrompt: '  Réponds en latin.  ',
      });
    });
    expect(useChatStore.getState().chatSettings.customSystemPrompt).toBe('Réponds en latin.');

    act(() => {
      useRAGQueryStore.getState().setParams({ useCustomSystemPrompt: false });
    });
    expect(useChatStore.getState().chatSettings.customSystemPrompt).toBeUndefined();
  });

  it('ignore un prompt vide même quand la case est cochée', () => {
    render(<AssistantChat variant="full" />);
    act(() => {
      useRAGQueryStore.getState().setParams({
        useCustomSystemPrompt: true,
        customSystemPrompt: '   ',
      });
    });
    expect(useChatStore.getState().chatSettings.customSystemPrompt).toBeUndefined();
  });
});

/**
 * « Mon manuscrit » (docs/poids-du-manuscrit.md, palier 2) : un tri-état
 * résolu contre l'espace de travail, projeté en valeur EFFECTIVE vers
 * `retrievalOptions.includeManuscript`, et une ligne de portée visible hors
 * du panneau. Le mock de react-i18next (vitest.setup.ts) rend le repli
 * quand il y en a un, la clé sinon : les libellés des familles se lisent
 * donc par leur clé, « Manuscript not consulted » par son repli.
 */
describe('AssistantChat — « Mon manuscrit » : projection et ligne de portée', () => {
  const allSources = {
    includeBibliography: true,
    includePrimary: true,
    includeNotes: true,
    includeManuscript: undefined,
  };
  const retrieval = () => useChatStore.getState().chatSettings.retrieval;

  beforeEach(() => {
    useChatStore.getState().reset();
    (window as unknown as { electron: unknown }).electron = {
      config: { get: vi.fn(async () => null) },
    };
    useRAGQueryStore.getState().setParams(allSources);
    useWorkspaceModeStore.getState().setActive('write');
  });
  afterEach(() => {
    cleanup();
    useWorkspaceModeStore.getState().setActive('write');
    useRAGQueryStore.getState().setParams(allSources);
  });

  it('espace Écrire → includeManuscript true ; passer en Brainstorm → false, et l’effet se rejoue', () => {
    render(<AssistantChat variant="full" />);
    expect(retrieval()?.includeManuscript).toBe(true);
    expect(retrieval()?.sourceType).toBe('both');

    act(() => {
      useWorkspaceModeStore.getState().setActive('brainstorm');
    });
    expect(retrieval()?.includeManuscript).toBe(false);
    // Les trois autres familles restent ce qu'elles étaient.
    expect(retrieval()?.sourceType).toBe('both');
    expect(retrieval()?.includeVault).toBe(true);
    // Rien n'est épinglé : le défaut de l'espace a parlé seul.
    expect(useRAGQueryStore.getState().params.includeManuscript).toBeUndefined();
  });

  it('case cochée en Brainstorm → true : le choix de l’utilisateur prime sur l’espace', () => {
    useWorkspaceModeStore.getState().setActive('brainstorm');
    render(<AssistantChat variant="full" />);
    expect(retrieval()?.includeManuscript).toBe(false);

    act(() => {
      useRAGQueryStore.getState().setParams({ includeManuscript: true });
    });
    expect(retrieval()?.includeManuscript).toBe(true);

    // Et décochée en Écrire → false, symétriquement.
    act(() => {
      useWorkspaceModeStore.getState().setActive('write');
      useRAGQueryStore.getState().setParams({ includeManuscript: false });
    });
    expect(retrieval()?.includeManuscript).toBe(false);
  });

  it('« Mon manuscrit » seul coché → sourceType manuscript, jamais élargi aux sources', () => {
    render(<AssistantChat variant="full" />);
    act(() => {
      useRAGQueryStore.getState().setParams({
        includeBibliography: false,
        includePrimary: false,
        includeNotes: false,
      });
    });
    expect(retrieval()?.sourceType).toBe('manuscript');
    expect(retrieval()?.includeVault).toBe(false);
    expect(retrieval()?.includeManuscript).toBe(true);

    // Même sélection en Brainstorm sans épingle : plus rien d'effectif →
    // repli permissif sur les sources, manuscrit toujours absent.
    act(() => {
      useWorkspaceModeStore.getState().setActive('brainstorm');
    });
    expect(retrieval()?.sourceType).toBe('both');
    expect(retrieval()?.includeManuscript).toBe(false);
  });

  it('la ligne de portée dit ce qui est consulté, signale le manuscrit absent, et ouvre les réglages', () => {
    useWorkspaceModeStore.getState().setActive('brainstorm');
    render(<AssistantChat variant="full" />);

    const line = screen.getByTestId('chat-scope-line');
    expect(line.textContent).toContain('ragSettings.includeBibliography');
    expect(line.textContent).toContain('ragSettings.includePrimary');
    expect(line.textContent).toContain('ragSettings.includeNotes');
    expect(line.textContent).not.toContain('ragSettings.includeManuscript');
    expect(line.textContent).toContain('Manuscript not consulted');

    act(() => {
      useWorkspaceModeStore.getState().setActive('write');
    });
    expect(screen.getByTestId('chat-scope-line').textContent).toContain('ragSettings.includeManuscript');
    expect(screen.getByTestId('chat-scope-line').textContent).not.toContain('Manuscript not consulted');

    // Manuscrit seul : la ligne ne montre que lui, sans avertissement.
    act(() => {
      useRAGQueryStore.getState().setParams({
        includeBibliography: false,
        includePrimary: false,
        includeNotes: false,
      });
    });
    expect(screen.getByTestId('chat-scope-line').textContent).not.toContain('ragSettings.includeBibliography');
    expect(screen.getByTestId('chat-scope-line').textContent).toContain('ragSettings.includeManuscript');
    expect(screen.getByTestId('chat-scope-line').textContent).not.toContain('Select at least one source.');

    // Plus rien d'effectif (les notes de lecture, consultées par défaut en
    // Écrire, décochées aussi) : l'avertissement, et le manuscrit absent.
    act(() => {
      useRAGQueryStore.getState().setParams({ includeManuscript: false, includeReadingNotes: false });
    });
    expect(screen.getByTestId('chat-scope-line').textContent).toContain('Select at least one source.');
    expect(screen.getByTestId('chat-scope-line').textContent).toContain('Manuscript not consulted');
    act(() => {
      useRAGQueryStore.getState().setParams({ includeReadingNotes: undefined });
    });

    // Cliquer la ligne ouvre le panneau de réglages.
    expect(screen.queryByTestId('rag-settings-stub')).toBeNull();
    fireEvent.click(screen.getByTestId('chat-scope-line'));
    expect(screen.getByTestId('rag-settings-stub')).toBeTruthy();
  });

  it('la ligne de portée dit pourquoi le manuscrit est écarté quand la case est cochée mais la recherche restreinte', () => {
    // Espace Écrire, manuscrit au défaut (oui), mais « Notes » seule cochée :
    // le main l'écarte (portée restreinte) et la ligne doit le dire.
    useWorkspaceModeStore.getState().setActive('write');
    render(<AssistantChat variant="full" />);
    act(() => {
      useRAGQueryStore.getState().setParams({
        includeBibliography: false,
        includePrimary: false,
        includeNotes: true,
      });
    });
    const line = screen.getByTestId('chat-scope-line');
    expect(line.textContent).not.toContain('ragSettings.includeManuscript');
    expect(line.textContent).toContain('Manuscript not consulted');
    expect(line.textContent).toContain('chat.scope.reason.scope');
  });

  it('la ligne de portée existe aussi dans la variante panel', () => {
    useWorkspaceModeStore.getState().setActive('brainstorm');
    render(<AssistantChat variant="panel" />);
    expect(screen.getByTestId('chat-scope-line').textContent).toContain('Manuscript not consulted');
  });

  it('affiche le nom du mode de chat actif à côté du bouton de réglages, et il ouvre les réglages', () => {
    render(<AssistantChat variant="full" />);
    // Sans liste de modes chargée, l'identifiant du mode actif sert de repli.
    const name = screen.getByTestId('chat-mode-name');
    expect(name.textContent).toContain('default-assistant');
    expect(screen.queryByTestId('mode-selector-stub')).toBeNull();
    fireEvent.click(name);
    expect(screen.getByTestId('mode-selector-stub')).toBeTruthy();
  });
});

/**
 * « Notes de lecture » : cinquième famille, même tri-état que le manuscrit
 * (défaut selon l'espace, Brainstorm : non), projetée en valeur EFFECTIVE
 * vers `retrievalOptions.includeReadingNotes` ; la portée « notes seules »
 * (`sourceType: 'readingNotes'`) et « manuscrit + notes » (`'manuscript'` +
 * `includeReadingNotes`) ne s'élargissent jamais aux sources ; et la ligne de
 * portée nomme les notes absentes — y compris la raison « fournisseur distant
 * sans consentement », celle que le main applique en retirant les notes du
 * prompt. Une sélection de documents ne les retire pas : le main les
 * restreint à ces références.
 */
describe('AssistantChat — « Notes de lecture » : projection et ligne de portée', () => {
  const allSources = {
    includeBibliography: true,
    includePrimary: true,
    includeNotes: true,
    includeManuscript: undefined,
    includeReadingNotes: undefined,
    selectedDocumentIds: [] as string[],
  };
  const localFlags = { indexEnabled: true, cloudConsent: false, generationIsCloud: false };
  const retrieval = () => useChatStore.getState().chatSettings.retrieval;
  const line = () => screen.getByTestId('chat-scope-line').textContent ?? '';

  beforeEach(() => {
    useChatStore.getState().reset();
    (window as unknown as { electron: unknown }).electron = {
      config: { get: vi.fn(async () => null) },
    };
    useRAGQueryStore.getState().setParams(allSources);
    useRAGQueryStore.getState().setReadingNotesFlags(localFlags);
    useWorkspaceModeStore.getState().setActive('write');
  });
  afterEach(() => {
    cleanup();
    useWorkspaceModeStore.getState().setActive('write');
    useRAGQueryStore.getState().setParams(allSources);
    useRAGQueryStore.getState().setReadingNotesFlags(localFlags);
  });

  it('espace Écrire → includeReadingNotes true ; Brainstorm → false ; une épingle prime sur l’espace', () => {
    render(<AssistantChat variant="full" />);
    expect(retrieval()?.includeReadingNotes).toBe(true);
    expect(retrieval()?.sourceType).toBe('both');

    act(() => {
      useWorkspaceModeStore.getState().setActive('brainstorm');
    });
    expect(retrieval()?.includeReadingNotes).toBe(false);
    expect(retrieval()?.includeManuscript).toBe(false);
    // Rien n'est épinglé : le défaut de l'espace a parlé seul.
    expect(useRAGQueryStore.getState().params.includeReadingNotes).toBeUndefined();

    act(() => {
      useRAGQueryStore.getState().setParams({ includeReadingNotes: true });
    });
    expect(retrieval()?.includeReadingNotes).toBe(true);
    // Le manuscrit, lui, suit toujours l'espace : les deux cases sont indépendantes.
    expect(retrieval()?.includeManuscript).toBe(false);
  });

  it('« Notes de lecture » seules cochées → sourceType readingNotes, jamais élargi aux sources', () => {
    render(<AssistantChat variant="full" />);
    act(() => {
      useRAGQueryStore.getState().setParams({
        includeBibliography: false,
        includePrimary: false,
        includeNotes: false,
        includeManuscript: false,
      });
    });
    expect(retrieval()?.sourceType).toBe('readingNotes');
    expect(retrieval()?.includeVault).toBe(false);
    expect(retrieval()?.includeManuscript).toBe(false);
    expect(retrieval()?.includeReadingNotes).toBe(true);

    // Décocher les notes aussi : plus rien d'effectif → repli permissif sur
    // les sources, les deux corpus de l'auteur absents.
    act(() => {
      useRAGQueryStore.getState().setParams({ includeReadingNotes: false });
    });
    expect(retrieval()?.sourceType).toBe('both');
    expect(retrieval()?.includeManuscript).toBe(false);
    expect(retrieval()?.includeReadingNotes).toBe(false);
  });

  it('manuscrit + notes, sans source → sourceType manuscript et includeReadingNotes true', () => {
    render(<AssistantChat variant="full" />);
    act(() => {
      useRAGQueryStore.getState().setParams({
        includeBibliography: false,
        includePrimary: false,
        includeNotes: false,
      });
    });
    expect(retrieval()?.sourceType).toBe('manuscript');
    expect(retrieval()?.includeVault).toBe(false);
    expect(retrieval()?.includeManuscript).toBe(true);
    expect(retrieval()?.includeReadingNotes).toBe(true);
  });

  it('la ligne de portée nomme les notes consultées en Écrire et les signale absentes en Brainstorm', () => {
    useWorkspaceModeStore.getState().setActive('brainstorm');
    render(<AssistantChat variant="full" />);
    expect(line()).not.toContain('ragSettings.includeReadingNotes');
    expect(line()).toContain('Reading notes not consulted');
    // Décochées par l'espace : pas de raison entre parenthèses.
    expect(line()).not.toContain('chat.scope.reason.');

    act(() => {
      useWorkspaceModeStore.getState().setActive('write');
    });
    expect(line()).toContain('ragSettings.includeReadingNotes');
    expect(line()).not.toContain('Reading notes not consulted');
  });

  it('une sélection de documents garde les notes dans la ligne ; un fournisseur distant sans consentement les retire, avec la raison', () => {
    render(<AssistantChat variant="full" />);
    act(() => {
      useRAGQueryStore.getState().setParams({ selectedDocumentIds: ['d1'] });
    });
    // Le manuscrit est écarté par la portée restreinte ; les notes, non :
    // le main les restreint aux références choisies.
    expect(line()).toContain('Manuscript not consulted');
    expect(line()).toContain('ragSettings.includeReadingNotes');
    expect(line()).not.toContain('Reading notes not consulted');

    act(() => {
      useRAGQueryStore
        .getState()
        .setReadingNotesFlags({ indexEnabled: true, cloudConsent: false, generationIsCloud: true });
    });
    expect(line()).not.toContain('ragSettings.includeReadingNotes');
    expect(line()).toContain('Reading notes not consulted');
    expect(line()).toContain('chat.scope.reason.cloud');

    // Le consentement donné : les notes reviennent.
    act(() => {
      useRAGQueryStore
        .getState()
        .setReadingNotesFlags({ indexEnabled: true, cloudConsent: true, generationIsCloud: true });
    });
    expect(line()).toContain('ragSettings.includeReadingNotes');
    expect(line()).not.toContain('Reading notes not consulted');

    // L'index désactivé l'emporte sur tout.
    act(() => {
      useRAGQueryStore
        .getState()
        .setReadingNotesFlags({ indexEnabled: false, cloudConsent: true, generationIsCloud: false });
    });
    expect(line()).toContain('Reading notes not consulted');
    expect(line()).toContain('chat.scope.reason.disabled');
  });
});
