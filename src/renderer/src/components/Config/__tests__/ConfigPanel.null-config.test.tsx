// @vitest-environment jsdom
/**
 * Dernier filet du formulaire : quoi que réponde `config:get`, la section RAG se rend. Un `null` y
 * faisait lever `.toFixed`, et l'unique ErrorBoundary de l'app remplaçait toute l'interface, à chaque
 * ouverture (S17-1-4). Le main répare aujourd'hui à la lecture (`repair-numbers.ts`) : la preuve sur
 * le fichier est dans `journey-numeric-fields`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

vi.mock('../VaultConfigSection', () => ({ VaultConfigSection: () => null }));
vi.mock('../UIConfigSection', () => ({ UIConfigSection: () => null }));
vi.mock('../ManuscriptCorpusSection', () => ({ ManuscriptCorpusSection: () => null }));
vi.mock('../ReadingNotesCorpusSection', () => ({ ReadingNotesCorpusSection: () => null }));
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
import { useEditorStore } from '../../../stores/editorStore';

type Section = Record<string, unknown>;

function installMain(disk: Record<string, Section | undefined>): void {
  const w = window as unknown as { electron: Record<string, unknown> };
  w.electron = {
    ...w.electron,
    config: {
      get: vi.fn(async (key: string) => disk[key]),
      set: vi.fn(async () => ({ success: true })),
      getAll: vi.fn(async () => disk),
    },
    ollama: {
      listModels: vi.fn(async () => ({ success: false })),
      showModel: vi.fn(async () => ({ success: false })),
    },
  };
}

const LLM = { backend: 'ollama', ollamaURL: 'http://127.0.0.1:9', ollamaEmbeddingModel: 'x', ollamaChatModel: 'y' };
const number = (attributes: string) => document.querySelector(`input[type="number"]${attributes}`) as HTMLInputElement;

async function openRag(): Promise<void> {
  render(<ConfigPanel />);
  fireEvent.click(screen.getByText('ragConfig.title'));
  await waitFor(() => expect(number('[min="1"][max="20"]')).toBeTruthy());
}

beforeEach(() => {
  localStorage.setItem('cliodeck-settings-mode', 'expert');
  useEditorStore.getState().updateSettings({ fontSize: 14, wordWrap: true, showMinimap: true, fontFamily: 'system' });
});

afterEach(() => {
  cleanup();
  localStorage.removeItem('cliodeck-settings-mode');
});

describe('la section RAG sur une section abîmée', () => {
  it('deux seuils à null : elle se rend, sans TypeError, et montre le défaut', async () => {
    installMain({
      rag: { ...DEFAULT_CONFIG.rag, similarityThreshold: null, explorationSimilarityThreshold: null },
      llm: LLM,
      editor: { fontSize: 15 },
    });

    await openRag();

    await waitFor(() => expect(number('[min="0"][max="1"]').value).toBe(String(DEFAULT_CONFIG.rag.similarityThreshold)));
    expect(number('[min="0.5"][max="0.95"]').value).toBe(String(DEFAULT_CONFIG.rag.explorationSimilarityThreshold));
    expect(screen.getAllByText(/ragRetrieval\.currentValue/).map((n) => n.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('"value":"0.12"'), expect.stringContaining('"value":"0.70"')])
    );
  });

  it.each([[null], ['0.5'], ['abc'], [true], [[1]]])(
    'la valeur %j dans chaque champ affiché en `toFixed` ou compté : aucun ne plante',
    async (bad) => {
      installMain({
        rag: {
          ...DEFAULT_CONFIG.rag,
          useGraphContext: true,
          topK: bad,
          similarityThreshold: bad,
          explorationSimilarityThreshold: bad,
          graphSimilarityThreshold: bad,
          additionalGraphDocs: bad,
          summaryMaxLength: bad,
        },
        llm: LLM,
        editor: { fontSize: 15 },
      });

      await openRag();

      await waitFor(() => expect(number('[min="1"][max="20"]').value).toBe(String(DEFAULT_CONFIG.rag.topK)));
      expect(number('[min="0.5"][max="1"]').value).toBe('0.7');
      expect(number('[min="1"][max="10"]').value).toBe('3');
      expect(number('[min="100"][max="1000"]').value).toBe('750');
    }
  );

  it('la section éditeur aussi : la police à null montre le défaut', async () => {
    installMain({ rag: DEFAULT_CONFIG.rag as unknown as Section, llm: LLM, editor: { fontSize: null, theme: 'dark' } });

    render(<ConfigPanel />);
    fireEvent.click(screen.getByText('editor.title'));

    await waitFor(() => expect(number('[max="24"]')).toBeTruthy());
    expect(number('[max="24"]').value).toBe(String(DEFAULT_CONFIG.editor.fontSize));
  });

  it('une fenêtre de contexte illisible s’affiche vide, comme « automatique »', async () => {
    installMain({
      rag: DEFAULT_CONFIG.rag as unknown as Section,
      llm: { ...LLM, ollamaNumCtx: 'abc', ollamaEmbeddingNumCtx: null },
      editor: { fontSize: 15 },
    });

    render(<ConfigPanel />);
    fireEvent.click(screen.getByText('llm.title'));

    await waitFor(() => expect(screen.getByPlaceholderText('llm.chatNumCtxPlaceholder')).toBeTruthy());
    expect((screen.getByPlaceholderText('llm.chatNumCtxPlaceholder') as HTMLInputElement).value).toBe('');
    expect((screen.getByPlaceholderText('llm.embeddingNumCtxPlaceholder') as HTMLInputElement).value).toBe('');
  });
});
