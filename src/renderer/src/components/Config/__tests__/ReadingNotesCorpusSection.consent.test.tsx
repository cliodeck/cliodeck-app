// @vitest-environment jsdom
/**
 * « Réindexer » les notes de lecture suivait le consentement enregistré, pas celui affiché
 * (S17-1-23) : la case ne s'écrivait qu'à « Enregistrer », alors que le main relit
 * `rag.readingNotesCloudConsent` sur le disque au moment de l'indexation. Décocher puis réindexer
 * envoyait toutes les notes au fournisseur distant.
 *
 * Vrai panneau, vraie section, vrais magasins. Seul le main est imité : `config:set('rag')`
 * remplace la section, et `reindexAll` note le consentement qu'il lit sur le disque.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_CONFIG } from '@backend/types/config';

vi.mock('react-i18next', () => {
  const t = (key: string, params?: Record<string, unknown>) =>
    params ? `${key} ${JSON.stringify(params)}` : key;
  return {
    useTranslation: () => ({ t, i18n: { language: 'fr', changeLanguage: async () => undefined } }),
    Trans: ({ children }: { children?: unknown }) => children ?? null,
    initReactI18next: { type: '3rdParty', init: () => undefined },
  };
});

// Le mode Expert monte toutes les sections : seule celle des notes de lecture compte ici.
vi.mock('../VaultConfigSection', () => ({ VaultConfigSection: () => null }));
vi.mock('../UIConfigSection', () => ({ UIConfigSection: () => null }));
vi.mock('../RAGConfigSection', () => ({ RAGConfigSection: () => null }));
vi.mock('../ManuscriptCorpusSection', () => ({ ManuscriptCorpusSection: () => null }));
vi.mock('../EmbeddedLLMSection', () => ({ EmbeddedLLMSection: () => null }));
vi.mock('../EmbeddedEmbeddingSection', () => ({ EmbeddedEmbeddingSection: () => null }));
vi.mock('../ModeManagerSection', () => ({ ModeManagerSection: () => null }));
vi.mock('../TopicModelingSection', () => ({ TopicModelingSection: () => null }));
vi.mock('../WorkspaceHintsSection', () => ({ WorkspaceHintsSection: () => null }));
vi.mock('../RecipesSection', () => ({ RecipesSection: () => null }));
vi.mock('../MCPClientsSection', () => ({ MCPClientsSection: () => null }));
vi.mock('../MCPServerSection', () => ({ MCPServerSection: () => null }));
vi.mock('../ArchivesConfigSection', () => ({ ArchivesConfigSection: () => null }));
vi.mock('../SecurityConfigSection', () => ({ SecurityConfigSection: () => null }));
vi.mock('../CitationStyleSection', () => ({ CitationStyleSection: () => null }));

import { ConfigPanel } from '../ConfigPanel';
import { useProjectStore } from '../../../stores/projectStore';
import { useRAGQueryStore } from '../../../stores/ragQueryStore';
import { notApplied } from '../settings-persist';

type Section = Record<string, unknown>;
type Disk = Record<'rag' | 'llm' | 'editor' | 'zotero', Section | undefined>;

function authorDisk(): Disk {
  return {
    rag: { ...DEFAULT_CONFIG.rag, topK: 7, indexReadingNotes: true, readingNotesCloudConsent: true },
    llm: {
      backend: 'openai',
      openaiAPIKey: '••••',
      ollamaURL: 'http://127.0.0.1:11434',
      ollamaEmbeddingModel: 'nomic-embed-text',
      ollamaChatModel: 'llama3.2',
      useCloudEmbeddings: true,
    },
    editor: { fontSize: 15, wordWrap: true, showMinimap: true, fontFamily: 'serif' },
    zotero: { mode: 'api', userId: '12345', dataDirectory: '' },
  };
}

function installMain(disk: Disk) {
  const writes: Array<{ section: string; value: Section }> = [];
  const refuse: Record<string, string | undefined> = {};
  let held: Promise<void> | undefined;
  /** Le consentement que le main lisait sur le disque à chaque réindexation. */
  const reindexedWithConsent: unknown[] = [];
  const w = window as unknown as { electron: Record<string, unknown> };
  w.electron = {
    ...w.electron,
    config: {
      get: vi.fn(async (key: string) => {
        const value = disk[key as keyof Disk];
        return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as Section);
      }),
      set: vi.fn(async (section: keyof Disk, value: Section) => {
        writes.push({ section, value });
        if (held) await held;
        if (refuse[section]) return { success: false, error: refuse[section] };
        const merged = section === 'llm' ? { ...disk.llm, ...value } : value;
        disk[section] = JSON.parse(JSON.stringify(merged)) as Section;
        return { success: true };
      }),
    },
    ollama: {
      listModels: vi.fn(async () => ({ success: false })),
      showModel: vi.fn(async () => ({ success: false })),
    },
    readingNotesCorpus: {
      index: vi.fn(),
      stats: vi.fn(async () => ({ success: true, stats: { noteCount: 3, chunkCount: 9, lastIndexedAt: null } })),
      reindexAll: vi.fn(async () => {
        reindexedWithConsent.push(disk.rag?.readingNotesCloudConsent);
        return {
          success: true,
          report: { indexed: 3, unchanged: 0, removed: 0, chunks: 9, failures: [], durationMs: 1 },
        };
      }),
    },
  };
  return {
    writes,
    refuse,
    reindexedWithConsent,
    /** Retient les écritures jusqu'à l'appel de la fonction rendue. */
    hold(): () => void {
      let release = (): void => undefined;
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        held = undefined;
        release();
      };
    },
  };
}

const consentBox = () => screen.getByTestId('reading-notes-cloud-consent') as HTMLInputElement;
const reindexButton = () => screen.getByTitle('readingNotesCorpus.reindexTitle') as HTMLButtonElement;

/** Ouvre le panneau en mode Expert, déplie la section et attend le chargement du disque. */
async function openPanel(): Promise<void> {
  render(<ConfigPanel />);
  fireEvent.click(screen.getByText('readingNotesCorpus.title'));
  await waitFor(() => expect(consentBox().checked).toBe(true));
}

beforeEach(() => {
  localStorage.setItem('cliodeck-settings-mode', 'expert');
  notApplied.clear();
  useProjectStore.setState({
    currentProject: {
      id: 'p',
      name: 'Danzig',
      path: '/tmp/danzig',
      type: 'article',
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
  });
  useRAGQueryStore.getState().setReadingNotesFlags({
    indexEnabled: true,
    cloudConsent: true,
    generationIsCloud: true,
  });
});

afterEach(() => {
  cleanup();
  localStorage.removeItem('cliodeck-settings-mode');
  useProjectStore.setState({ currentProject: null });
});

describe('Notes de lecture : le consentement affiché est celui qu’applique Réindexer', () => {
  it('décocher écrit tout de suite ce seul champ, sans Enregistrer', async () => {
    const disk = authorDisk();
    const main = installMain(disk);
    await openPanel();

    fireEvent.click(consentBox());

    await waitFor(() => expect(disk.rag?.readingNotesCloudConsent).toBe(false));
    // Relue sur le disque : le reste de la section ne bouge pas.
    expect(main.writes).toEqual([
      { section: 'rag', value: { ...authorDisk().rag, readingNotesCloudConsent: false } },
    ]);
    expect(useRAGQueryStore.getState().readingNotesCloudConsent).toBe(false);
  });

  it('Réindexer attend l’écriture du consentement, puis part sans les envoyer', async () => {
    const disk = authorDisk();
    const main = installMain(disk);
    await openPanel();
    await waitFor(() => expect(reindexButton().disabled).toBe(false));

    const release = main.hold();
    fireEvent.click(consentBox());
    await waitFor(() => expect(main.writes.length).toBe(1));

    // Le consentement n'est pas encore sur le disque : réindexer maintenant enverrait les notes.
    expect(reindexButton().disabled).toBe(true);
    fireEvent.click(reindexButton());
    expect(main.reindexedWithConsent).toEqual([]);

    await act(async () => release());
    await waitFor(() => expect(reindexButton().disabled).toBe(false));
    fireEvent.click(reindexButton());

    await waitFor(() => expect(main.reindexedWithConsent).toEqual([false]));
  });

  it('fermer sans Enregistrer, puis rouvrir : la case reste décochée', async () => {
    const disk = authorDisk();
    installMain(disk);
    await openPanel();

    fireEvent.click(consentBox());
    await waitFor(() => expect(disk.rag?.readingNotesCloudConsent).toBe(false));
    cleanup();

    // La case est décochée aussi avant chargement (valeur du formulaire) : on attend la relecture
    // des quatre sections, puis son rendu.
    const get = (window as unknown as { electron: { config: { get: ReturnType<typeof vi.fn> } } })
      .electron.config.get;
    get.mockClear();
    render(<ConfigPanel />);
    fireEvent.click(screen.getByText('readingNotesCorpus.title'));
    await waitFor(() => expect(get.mock.calls.map(([key]) => key)).toContain('zotero'));
    await act(async () => undefined);
    expect(consentBox().checked).toBe(false);
    expect(disk.rag?.readingNotesCloudConsent).toBe(false);
  });

  it('écriture refusée : la case revient à l’état du disque, et le dit', async () => {
    const disk = authorDisk();
    const main = installMain(disk);
    main.refuse.rag = 'disque plein';
    await openPanel();

    fireEvent.click(consentBox());

    await waitFor(() => expect(screen.getByText('settings.saveError')).toBeTruthy());
    expect(consentBox().checked).toBe(true);
    expect(disk.rag?.readingNotesCloudConsent).toBe(true);
    expect(useRAGQueryStore.getState().readingNotesCloudConsent).toBe(true);
  });
});
