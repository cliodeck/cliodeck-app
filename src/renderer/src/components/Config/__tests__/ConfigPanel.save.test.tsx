// @vitest-environment jsdom
/**
 * Les Réglages lisent leurs sections à l'ouverture. Les renvoyer entières à l'enregistrement
 * annulait tout ce que les autres sections de la même fenêtre avaient écrit entre-temps (S17-1-1),
 * et Réinitialiser, par fermeture périmée, réécrivait l'ancienne configuration en annonçant
 * « sauvegardée » (S17-1-2).
 *
 * Vrai panneau, vrais formulaires, vrais magasins. Seul le main est imité, et il garde sa
 * sémantique : `llm` fusionne ce qu'il reçoit, les autres sections sont remplacées, et le disque
 * passe par JSON (une clé `undefined` disparaît, un `NaN` devient `null`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_CONFIG } from '@backend/types/config';

// Un `t` stable, comme le vrai, et qui montre ses paramètres : le motif d'un refus en est un.
vi.mock('react-i18next', () => {
  const t = (key: string, params?: Record<string, unknown>) =>
    params ? `${key} ${JSON.stringify(params)}` : key;
  return {
    useTranslation: () => ({ t, i18n: { language: 'fr', changeLanguage: async () => undefined } }),
    Trans: ({ children }: { children?: unknown }) => children ?? null,
    initReactI18next: { type: '3rdParty', init: () => undefined },
  };
});

// Ces sections écrivent ailleurs ou ne lisent que leur propre état : rien à vérifier ici.
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
vi.mock('../CitationStyleSection', () => ({ CitationStyleSection: () => null }));

import { ConfigPanel } from '../ConfigPanel';
import { ConfirmDialog } from '../../common/ConfirmDialog';
import { useDialogStore } from '../../../stores/dialogStore';
import { useEditorStore } from '../../../stores/editorStore';
import { useRAGQueryStore } from '../../../stores/ragQueryStore';

type Section = Record<string, unknown>;
type Disk = Record<'rag' | 'llm' | 'editor' | 'zotero', Section | undefined>;
interface Answer {
  success: boolean;
  /** Le refus est arrivé après l'écriture : le disque a changé. */
  written?: boolean;
  error?: string;
}

/**
 * Ce que le main sait faire, avec les deux refus qu'il connaît : `refuse`, rien n'est écrit (trousseau
 * ou disque en échec) ; `restartFails`, le fichier est écrit puis la relance des services échoue,
 * le cas courant de `config:set('llm')`.
 */
function installMain(disk: Disk) {
  const writes: Array<{ section: string; value: Section }> = [];
  const refuse: Record<string, string | undefined> = {};
  const restartFails: Record<string, string | undefined> = {};
  const held: Record<string, Promise<void> | undefined> = {};
  const set = vi.fn(async (section: keyof Disk, value: Section): Promise<Answer> => {
    writes.push({ section, value });
    if (held[section]) await held[section];
    if (refuse[section]) return { success: false, error: refuse[section] };
    const merged = section === 'llm' ? { ...disk.llm, ...value } : value;
    disk[section] = JSON.parse(JSON.stringify(merged)) as Section;
    if (restartFails[section]) return { success: false, written: true, error: restartFails[section] };
    return { success: true };
  });
  const setProvider = vi.fn();
  const w = window as unknown as { electron: Record<string, unknown> };
  w.electron = {
    ...w.electron,
    config: {
      get: vi.fn(async (key: string) => {
        const value = disk[key as keyof Disk];
        return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as Section);
      }),
      set,
      getAll: vi.fn(async () => JSON.parse(JSON.stringify(disk)) as Disk),
    },
    ollama: {
      listModels: vi.fn(async () => ({ success: false })),
      showModel: vi.fn(async () => ({ success: false })),
    },
    embeddedEmbedding: { setProvider },
    fusion: {
      security: {
        getMode: vi.fn(async () => ({ success: true, mode: 'warn' })),
        setMode: vi.fn(),
        getEvents: vi.fn(async () => ({
          success: true,
          stats: { total: 0, byKind: {}, bySeverity: { low: 0, medium: 0, high: 0 }, recent: [] },
        })),
        getUnreadableKeys: vi.fn(async () => ({ success: true, keys: [] })),
        getStorageStatus: vi.fn(async () => ({ success: true, encrypted: true, plaintextKeys: [] })),
        revokeAllKeys: vi.fn(async () => {
          // `getLLMConfig` ne réinjecte que les clés lisibles : après révocation, le champ manque.
          const llm = { ...(disk.llm as Section) };
          for (const field of ['claudeAPIKey', 'openaiAPIKey', 'mistralAPIKey', 'geminiAPIKey']) delete llm[field];
          disk.llm = llm;
          if (disk.zotero) {
            const { apiKey: _gone, ...zotero } = disk.zotero;
            disk.zotero = zotero;
          }
          return { success: true, keysDeleted: 1 };
        }),
      },
    },
  };
  return {
    writes,
    refuse,
    restartFails,
    /** Retient l'écriture d'une section jusqu'à l'appel de la fonction rendue. */
    hold(section: string): () => void {
      let release = (): void => undefined;
      held[section] = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        held[section] = undefined;
        release();
      };
    },
    written: (section: string) => writes.filter((w) => w.section === section),
    setProvider,
  };
}

/** Une configuration d'auteur, qui n'est pas celle du formulaire ni celle de DEFAULT_CONFIG. */
function authorDisk(): Disk {
  return {
    rag: { ...DEFAULT_CONFIG.rag, topK: 7, chunkingConfig: 'standard', systemPromptLanguage: 'fr' },
    llm: {
      backend: 'ollama',
      ollamaURL: 'http://127.0.0.1:11434',
      ollamaEmbeddingModel: 'bge-m3',
      ollamaChatModel: 'qwen3:14b',
      generationProvider: 'auto',
      embeddingProvider: 'auto',
    },
    editor: { fontSize: 15, theme: 'light', wordWrap: true, showMinimap: true, fontFamily: 'serif', engine: 'cm6' },
    zotero: { mode: 'api', userId: '12345', dataDirectory: '' },
  };
}

const saveButton = () =>
  (screen.queryByTitle('settings.saving') ?? screen.getByTitle('settings.tooltipSave')) as HTMLButtonElement;
const resetButton = () => screen.getByTitle('settings.tooltipReset') as HTMLButtonElement;
const fontInput = () => document.querySelector('.config-number') as HTMLInputElement;

/** Ouvre le panneau et attend le chargement : la police affichée devient celle du disque. */
async function openPanel(diskFontSize: number | string = 15): Promise<void> {
  render(
    <>
      <ConfigPanel />
      <ConfirmDialog />
    </>
  );
  fireEvent.click(screen.getByText('editor.title'));
  await waitFor(() => expect(fontInput().value).toBe(String(diskFontSize)));
}

/** Clique et attend que le panneau ait fini : le bouton redevient cliquable. */
async function save(): Promise<void> {
  await act(async () => {
    fireEvent.click(saveButton());
  });
  await waitFor(() => expect(saveButton().disabled).toBe(false));
}

async function confirmReset(): Promise<void> {
  fireEvent.click(resetButton());
  fireEvent.click(await screen.findByText('dialog.confirm'));
  await waitFor(() => expect(document.querySelector('.save-message')).toBeTruthy());
}

beforeEach(() => {
  localStorage.removeItem('cliodeck-settings-mode');
  // Le magasin survit au démontage : un test ne doit pas hériter de la police du précédent.
  useEditorStore.getState().updateSettings({ fontSize: 14, wordWrap: true, showMinimap: true, fontFamily: 'system' });
});

afterEach(() => {
  cleanup();
  while (useDialogStore.getState().confirmOpen) useDialogStore.getState().resolveConfirm(false);
});

describe('Enregistrer n’écrit que ce qui a changé', () => {
  it('une langue et un fournisseur écrits entre-temps survivent à un changement de police', async () => {
    const disk = authorDisk();
    const main = installMain(disk);
    await openPanel();

    // LanguageConfigSection et EmbeddedEmbeddingSection écrivent sans passer par le formulaire.
    (disk.rag as Section).systemPromptLanguage = 'en';
    (disk.llm as Section).embeddingProvider = 'embedded';
    (disk.llm as Section).embeddedModelPath = '/modeles/qwen.gguf';

    fireEvent.change(fontInput(), { target: { value: '18' } });
    await save();

    expect(disk.rag?.systemPromptLanguage).toBe('en');
    expect(disk.llm?.embeddingProvider).toBe('embedded');
    expect(disk.llm?.embeddedModelPath).toBe('/modeles/qwen.gguf');
    expect(disk.editor?.fontSize).toBe(18);
    // Ces sections n'ont pas bougé dans le formulaire : `config:set('llm')` relancerait les services.
    expect(main.written('rag')).toEqual([]);
    expect(main.written('llm')).toEqual([]);
    expect(main.written('zotero')).toEqual([]);
    expect(screen.getByText('settings.saved')).toBeTruthy();
  });

  it('un modèle supprimé entre-temps ne revient pas, même quand la section llm est écrite', async () => {
    const disk = authorDisk();
    (disk.llm as Section).embeddedModelPath = '/modeles/qwen.gguf';
    (disk.llm as Section).embeddedModelId = 'qwen';
    const main = installMain(disk);
    await openPanel();

    // embedded-llm:delete-model efface ces deux champs côté main.
    delete (disk.llm as Section).embeddedModelPath;
    delete (disk.llm as Section).embeddedModelId;

    fireEvent.click(screen.getByText('llm.title'));
    fireEvent.change(await screen.findByPlaceholderText('gemma2:2b'), { target: { value: 'mistral-nemo' } });
    await save();

    expect(disk.llm?.ollamaChatModel).toBe('mistral-nemo');
    expect(disk.llm).not.toHaveProperty('embeddedModelPath');
    expect(disk.llm).not.toHaveProperty('embeddedModelId');
    expect(main.written('llm')).toHaveLength(1);
  });

  it('ouvrir puis Enregistrer n’écrit rien, même sur une configuration à laquelle il manque des champs', async () => {
    const disk: Disk = {
      rag: { topK: 7 },
      llm: { backend: 'ollama' },
      editor: { fontSize: 15 },
      zotero: undefined,
    };
    const main = installMain(disk);
    await openPanel();

    await save();
    await save();

    expect(main.writes).toEqual([]);
    expect(screen.getByText('settings.saved')).toBeTruthy();
  });

  it('écrire une section garde les champs du disque que le formulaire ne connaît pas', async () => {
    const disk = authorDisk();
    installMain(disk);
    await openPanel();

    fireEvent.change(fontInput(), { target: { value: '18' } });
    await save();

    expect(disk.editor).toEqual({ ...authorDisk().editor, fontSize: 18 });
  });

  it('le magasin de l’éditeur qui se recopie dans le formulaire ne crée pas de faux changement', async () => {
    const disk = authorDisk();
    const main = installMain(disk);
    // Au lancement, App.tsx pose dans le magasin ce que dit le disque.
    const fromDisk = { fontSize: 15, wordWrap: true, showMinimap: true, fontFamily: 'serif' };
    useEditorStore.getState().updateSettings(fromDisk);
    await openPanel();

    // App.tsx peut répondre après le chargement du panneau : l'effet recopie alors ses quatre champs.
    act(() => {
      useEditorStore.getState().updateSettings(fromDisk);
    });
    await save();
    expect(main.writes).toEqual([]);

    // Enregistrer repasse par le magasin, donc par l'effet : la seconde fois, plus rien à écrire,
    // et `engine` est toujours là.
    fireEvent.change(fontInput(), { target: { value: '18' } });
    await save();
    await save();
    expect(main.written('editor')).toHaveLength(1);
    expect(disk.editor?.engine).toBe('cm6');
    expect(disk.editor?.theme).toBe('light');
  });

  it('un disque sans fontFamily ne se réécrit pas à cause du magasin de l’éditeur', async () => {
    const disk = authorDisk();
    delete (disk.editor as Section).fontFamily;
    const main = installMain(disk);
    // App.tsx pose `fontFamily: undefined` dans le magasin quand le disque n'en a pas.
    const fromDisk = { fontSize: 15, wordWrap: true, showMinimap: true, fontFamily: undefined as unknown as string };
    useEditorStore.getState().updateSettings(fromDisk);
    await openPanel();

    act(() => {
      useEditorStore.getState().updateSettings(fromDisk);
    });
    await save();

    expect(main.writes).toEqual([]);
  });

  it('un NaN n’est écrit qu’une fois : il ne passe pas pour un changement à chaque Enregistrer', async () => {
    const disk = authorDisk();
    const main = installMain(disk);
    await openPanel();

    fireEvent.change(fontInput(), { target: { value: '' } });
    await save();
    await save();

    expect(main.written('editor')).toHaveLength(1);
  });
});

describe('Enregistrer lit la réponse du main', () => {
  it('un chargement raté : on ne sait pas ce qui a changé, rien ne part, et c’est dit', async () => {
    const disk = authorDisk();
    const main = installMain(disk);
    const config = (window as unknown as { electron: { config: { get: ReturnType<typeof vi.fn> } } }).electron.config;
    config.get.mockRejectedValue(new Error('IPC rompu'));
    render(<ConfigPanel />);
    await waitFor(() => expect(config.get).toHaveBeenCalled());

    await save();

    expect(main.writes).toEqual([]);
    expect(screen.getByText('settings.saveError')).toBeTruthy();
  });

  it('une section refusée : le motif s’affiche, pas « sauvegardée »', async () => {
    const disk = authorDisk();
    const main = installMain(disk);
    main.refuse.llm = 'Anthropic backend selected but no claudeAPIKey set in config.';
    await openPanel();

    fireEvent.click(screen.getByText('llm.title'));
    fireEvent.change(await screen.findByPlaceholderText('gemma2:2b'), { target: { value: 'mistral-nemo' } });
    await save();

    const message = document.querySelector('.save-message.error');
    expect(message?.textContent).toContain('Anthropic backend selected');
    expect(screen.queryByText('settings.saved')).toBeNull();
  });

  it('une écriture partielle se réessaie sur ce qui manque, et sur rien d’autre', async () => {
    const disk = authorDisk();
    const main = installMain(disk);
    main.refuse.llm = 'refus';
    await openPanel();

    fireEvent.change(fontInput(), { target: { value: '18' } });
    fireEvent.click(screen.getByText('llm.title'));
    fireEvent.change(await screen.findByPlaceholderText('gemma2:2b'), { target: { value: 'mistral-nemo' } });
    await save();

    expect(disk.editor?.fontSize).toBe(18);
    expect(disk.llm?.ollamaChatModel).toBe('qwen3:14b');
    expect(main.written('llm')).toHaveLength(1);
    expect(main.written('editor')).toHaveLength(1);

    main.refuse.llm = undefined;
    await save();

    expect(disk.llm?.ollamaChatModel).toBe('mistral-nemo');
    expect(main.written('llm')).toHaveLength(2);
    expect(main.written('editor')).toHaveLength(1);
    expect(screen.getByText('settings.saved')).toBeTruthy();
  });

  it('un refus de la section éditeur ne passe pas au magasin : le formulaire garde la saisie', async () => {
    const disk = authorDisk();
    const main = installMain(disk);
    main.refuse.editor = 'refus';
    await openPanel();
    const before = useEditorStore.getState().settings.fontSize;

    fireEvent.change(fontInput(), { target: { value: '18' } });
    await save();

    expect(useEditorStore.getState().settings.fontSize).toBe(before);
    expect(fontInput().value).toBe('18');
  });

  it('une section dont l’appel rejette n’empêche pas les autres d’être écrites', async () => {
    const disk = authorDisk();
    const main = installMain(disk);
    await openPanel();
    const config = (window as unknown as { electron: { config: { set: ReturnType<typeof vi.fn> } } }).electron.config;
    const real = config.set.getMockImplementation() as (s: string, v: Section) => Promise<Answer>;
    config.set.mockImplementation(async (section: string, value: Section) => {
      if (section === 'llm') throw new Error('IPC rompu');
      return real(section, value);
    });

    fireEvent.change(fontInput(), { target: { value: '18' } });
    fireEvent.click(screen.getByText('llm.title'));
    fireEvent.change(await screen.findByPlaceholderText('gemma2:2b'), { target: { value: 'mistral-nemo' } });
    await save();

    expect(main.written('editor')).toHaveLength(1);
    expect(document.querySelector('.save-message.error')?.textContent).toContain('IPC rompu');
  });
});

describe('écrit, mais les services n’ont pas pu repartir', () => {
  const chatModel = () => screen.getByPlaceholderText('gemma2:2b') as HTMLInputElement;
  const failure = () => document.querySelector('.save-message.error')?.textContent ?? '';

  async function typeChatModel(model: string): Promise<void> {
    if (!screen.queryByPlaceholderText('gemma2:2b')) fireEvent.click(screen.getByText('llm.title'));
    fireEvent.change(await screen.findByPlaceholderText('gemma2:2b'), { target: { value: model } });
  }

  it('le message dit que c’est enregistré, avec le motif, et pas « sauvegardée » ni « non appliqué »', async () => {
    const disk = authorDisk();
    const main = installMain(disk);
    main.restartFails.llm = 'Anthropic backend selected but no claudeAPIKey set in config.';
    await openPanel();

    await typeChatModel('mistral-nemo');
    await save();

    expect(disk.llm?.ollamaChatModel).toBe('mistral-nemo');
    expect(failure()).toContain('settings.savedNotApplied');
    expect(failure()).toContain('Anthropic backend selected');
    expect(failure()).not.toContain('settings.saveFailed');
    expect(screen.queryByText('settings.saved')).toBeNull();
  });

  it('revenir à la valeur précédente réécrit et relance : c’est le chemin de réparation', async () => {
    const disk = authorDisk();
    const main = installMain(disk);
    main.restartFails.llm = 'pas de clé';
    await openPanel();

    await typeChatModel('mistral-nemo');
    await save();
    main.restartFails.llm = undefined;

    await typeChatModel('qwen3:14b');
    await save();

    // Le disque avait la valeur refusée : sans cette écriture, il la gardait, et le projet ne s'ouvrait plus.
    expect(main.written('llm')).toHaveLength(2);
    expect(disk.llm?.ollamaChatModel).toBe('qwen3:14b');
    expect(screen.getByText('settings.saved')).toBeTruthy();
  });

  it('une écriture partielle se réessaie sur ce qui n’a pas repris, et sur rien d’autre', async () => {
    const disk = authorDisk();
    const main = installMain(disk);
    main.restartFails.llm = 'refus';
    await openPanel();

    fireEvent.change(fontInput(), { target: { value: '18' } });
    await typeChatModel('mistral-nemo');
    await save();

    expect(disk.editor?.fontSize).toBe(18);
    expect(disk.llm?.ollamaChatModel).toBe('mistral-nemo');
    expect(main.written('llm')).toHaveLength(1);
    expect(main.written('editor')).toHaveLength(1);

    // Rien à écrire, mais les services sont à l'arrêt : « sauvegardée » serait faux. On retente.
    await save();
    expect(main.written('llm')).toHaveLength(2);
    expect(failure()).toContain('settings.savedNotApplied');
    expect(screen.queryByText('settings.saved')).toBeNull();

    main.restartFails.llm = undefined;
    await save();
    expect(main.written('llm')).toHaveLength(3);
    expect(main.written('editor')).toHaveLength(1);
    expect(screen.getByText('settings.saved')).toBeTruthy();

    // Repartis : plus rien à retenter.
    await save();
    expect(main.written('llm')).toHaveLength(3);
  });

  it('un refus sans écriture et une relance échouée se disent chacun, dans le même message', async () => {
    const disk = authorDisk();
    const main = installMain(disk);
    main.refuse.editor = 'disque plein';
    main.restartFails.llm = 'pas de clé';
    await openPanel();

    fireEvent.change(fontInput(), { target: { value: '18' } });
    await typeChatModel('mistral-nemo');
    await save();

    expect(failure()).toContain('settings.saveFailed');
    expect(failure()).toContain('disque plein');
    expect(failure()).toContain('settings.savedNotApplied');
    expect(failure()).toContain('pas de clé');
  });

  it('les répercussions suivent le disque : le chat tient le modèle écrit', async () => {
    const disk = authorDisk();
    const main = installMain(disk);
    main.restartFails.llm = 'pas de clé';
    useRAGQueryStore.getState().setParams({ model: 'qwen3:14b' });
    await openPanel();

    await typeChatModel('mistral-nemo');
    await save();

    expect(useRAGQueryStore.getState().params.model).toBe('mistral-nemo');
  });

  it('Réinitialiser : le disque est réinitialisé, le formulaire le montre, et le message ne le nie pas', async () => {
    const disk = authorDisk();
    const main = installMain(disk);
    main.restartFails.llm = 'trousseau verrouillé';
    await openPanel();

    await confirmReset();

    expect(disk.llm?.ollamaChatModel).toBe(DEFAULT_CONFIG.llm.ollamaChatModel);
    expect(failure()).toContain('settings.savedNotApplied');
    expect(failure()).toContain('trousseau verrouillé');
    expect(failure()).not.toContain('settings.resetFailed');
    fireEvent.click(screen.getByText('llm.title'));
    expect(chatModel().value).toBe(DEFAULT_CONFIG.llm.ollamaChatModel);

    // L'instantané a suivi : revenir à l'ancien modèle est un changement à écrire.
    main.restartFails.llm = undefined;
    fireEvent.change(chatModel(), { target: { value: 'qwen3:14b' } });
    await save();
    expect(disk.llm?.ollamaChatModel).toBe('qwen3:14b');
    expect(screen.getByText('settings.saved')).toBeTruthy();
  });
});

describe('Réinitialiser écrit vraiment', () => {
  it('les valeurs de DEFAULT_CONFIG partent sur le disque, et Q7 reste en place', async () => {
    const disk = authorDisk();
    const main = installMain(disk);
    await openPanel();

    // Écrit par LanguageConfigSection après l'ouverture : c'est le disque qui fait foi.
    (disk.rag as Section).systemPromptLanguage = 'en';
    await confirmReset();

    expect(disk.rag?.topK).toBe(DEFAULT_CONFIG.rag.topK);
    expect(disk.rag?.similarityThreshold).toBe(0.12);
    expect(disk.rag?.chunkingConfig).toBe(DEFAULT_CONFIG.rag.chunkingConfig);
    expect(disk.rag?.systemPromptLanguage).toBe('en');
    expect(disk.llm?.backend).toBe('ollama');
    expect(disk.llm?.ollamaChatModel).toBe(DEFAULT_CONFIG.llm.ollamaChatModel);
    expect(disk.llm?.ollamaEmbeddingModel).toBe('bge-m3');
    expect(disk.llm?.embeddingProvider).toBe('auto');
    expect(disk.editor?.fontSize).toBe(DEFAULT_CONFIG.editor.fontSize);
    expect(disk.editor?.theme).toBe(DEFAULT_CONFIG.editor.theme);
    expect(disk.editor?.engine).toBe('cm6');
    expect(main.written('zotero')).toEqual([]);
    expect(disk.zotero).toEqual(authorDisk().zotero);
    expect(screen.getByText('settings.saved')).toBeTruthy();
  });

  it('les clés d’API ne sont ni écrites en clair ni retirées : le masque reste côté main', async () => {
    const disk = authorDisk();
    Object.assign(disk.llm as Section, { backend: 'claude', claudeAPIKey: 'sk-a...wXyZ', claudeModel: 'claude-x' });
    installMain(disk);
    await openPanel();

    await confirmReset();

    expect(disk.llm?.backend).toBe('ollama');
    expect(disk.llm).not.toHaveProperty('claudeModel');
    expect(disk.llm?.claudeAPIKey).toBe('sk-a...wXyZ');
  });

  it('le formulaire montre ce qui est écrit, 0,12 et pas le 0,2 qu’il avait en dur', async () => {
    const disk = authorDisk();
    disk.rag = { ...(disk.rag as Section), similarityThreshold: 0.33 };
    localStorage.setItem('cliodeck-settings-mode', 'expert');
    installMain(disk);
    await openPanel();

    await confirmReset();
    fireEvent.click(screen.getByText('ragConfig.title'));

    await waitFor(() => expect(document.querySelector('.config-section-content input[type="range"]')).toBeTruthy());
    const values = Array.from(document.querySelectorAll('input')).map((i) => i.value);
    expect(values).toContain('0.12');
    expect(values).not.toContain('0.2');
    // Et le modèle affiché est celui du disque.
    fireEvent.click(screen.getByText('llm.title'));
    expect((screen.getByPlaceholderText('gemma2:2b') as HTMLInputElement).value).toBe(DEFAULT_CONFIG.llm.ollamaChatModel);
  });

  it('les répercussions lisent les valeurs écrites : modèle, consentement, police', async () => {
    const disk = authorDisk();
    Object.assign(disk.rag as Section, { readingNotesCloudConsent: true, indexManuscript: false, indexReadingNotes: false });
    Object.assign(disk.llm as Section, { backend: 'claude', generationProvider: 'embedded', ollamaNumCtx: 8192 });
    installMain(disk);
    useRAGQueryStore.getState().setParams({ model: 'qwen3:14b', provider: 'embedded', numCtx: 8192 });
    useRAGQueryStore.getState().setManuscriptIndexEnabled(false);
    useRAGQueryStore.getState().setReadingNotesFlags({ indexEnabled: false, cloudConsent: true, generationIsCloud: true });
    await openPanel();

    await confirmReset();

    const query = useRAGQueryStore.getState();
    expect(disk.rag?.readingNotesCloudConsent ?? false).toBe(false);
    expect(query.readingNotesCloudConsent).toBe(false);
    expect(query.readingNotesIndexEnabled).toBe(true);
    expect(query.manuscriptIndexEnabled).toBe(true);
    expect(query.generationIsCloud).toBe(false);
    expect(query.params.model).toBe(DEFAULT_CONFIG.llm.ollamaChatModel);
    expect(query.params.provider).toBe(DEFAULT_CONFIG.llm.generationProvider);
    expect(useEditorStore.getState().settings.fontSize).toBe(DEFAULT_CONFIG.editor.fontSize);
  });

  it('ne réclame aucune réindexation : une seule question, et pas d’appel au fournisseur d’embeddings', async () => {
    const disk = authorDisk();
    (disk.llm as Section).embeddingProvider = 'embedded';
    const main = installMain(disk);
    const showConfirm = vi.spyOn(useDialogStore.getState(), 'showConfirm');
    await openPanel();

    await confirmReset();

    expect(showConfirm).toHaveBeenCalledTimes(1);
    expect(showConfirm.mock.calls[0][0]).toContain('settings.resetConfirm');
    expect(main.setProvider).not.toHaveBeenCalled();
    expect(disk.llm?.embeddingProvider).toBe('embedded');
    showConfirm.mockRestore();
  });

  it('sur une configuration déjà aux valeurs par défaut, rien n’est écrit', async () => {
    const disk: Disk = {
      rag: JSON.parse(JSON.stringify(DEFAULT_CONFIG.rag)) as Section,
      llm: JSON.parse(JSON.stringify(DEFAULT_CONFIG.llm)) as Section,
      editor: JSON.parse(JSON.stringify(DEFAULT_CONFIG.editor)) as Section,
      zotero: undefined,
    };
    const main = installMain(disk);
    await openPanel(14);

    await confirmReset();

    expect(main.writes).toEqual([]);
  });

  it('refuser la question n’écrit rien et laisse le formulaire', async () => {
    const disk = authorDisk();
    const main = installMain(disk);
    await openPanel();
    fireEvent.change(fontInput(), { target: { value: '18' } });

    fireEvent.click(resetButton());
    fireEvent.click(await screen.findByText('dialog.cancel'));
    await waitFor(() => expect(useDialogStore.getState().confirmOpen).toBe(false));

    expect(main.writes).toEqual([]);
    expect(fontInput().value).toBe('18');
  });

  it('un refus : le motif s’affiche et le formulaire de cette section garde ses valeurs', async () => {
    const disk = authorDisk();
    const main = installMain(disk);
    main.refuse.llm = 'trousseau verrouillé';
    await openPanel();

    await confirmReset();

    const message = document.querySelector('.save-message.error');
    expect(message?.textContent).toContain('trousseau verrouillé');
    expect(screen.queryByText('settings.saved')).toBeNull();
    fireEvent.click(screen.getByText('llm.title'));
    expect((screen.getByPlaceholderText('gemma2:2b') as HTMLInputElement).value).toBe('qwen3:14b');
    expect(disk.llm?.ollamaChatModel).toBe('qwen3:14b');
    // Le reste est passé : sections écrites, formulaire et disque d'accord.
    expect(disk.rag?.topK).toBe(DEFAULT_CONFIG.rag.topK);
    expect(fontInput().value).toBe(String(DEFAULT_CONFIG.editor.fontSize));
  });

  it('le backend en ligne qui calcule les embeddings reste, et le chat le sait', async () => {
    const disk = authorDisk();
    Object.assign(disk.llm as Section, {
      backend: 'gemini',
      useCloudEmbeddings: true,
      geminiAPIKey: 'AIza...wXyZ',
      geminiModel: 'gemini-x',
    });
    installMain(disk);
    await openPanel();

    await confirmReset();

    expect(disk.llm).toMatchObject({ backend: 'gemini', useCloudEmbeddings: true, geminiAPIKey: 'AIza...wXyZ' });
    expect(disk.llm).not.toHaveProperty('geminiModel');
    expect(useRAGQueryStore.getState().generationIsCloud).toBe(true);
  });

  it('le disque illisible au moment de réinitialiser : rien ne part, et c’est dit', async () => {
    const disk = authorDisk();
    const main = installMain(disk);
    await openPanel();
    const config = (window as unknown as { electron: { config: { get: ReturnType<typeof vi.fn> } } }).electron.config;
    config.get.mockRejectedValue(new Error('IPC rompu'));

    await confirmReset();

    expect(main.writes).toEqual([]);
    expect(screen.getByText('settings.saveError')).toBeTruthy();
    expect(fontInput().value).toBe('15');
  });

  it('Enregistrer après un Réinitialiser réussi n’écrit plus rien', async () => {
    const disk = authorDisk();
    const main = installMain(disk);
    await openPanel();

    await confirmReset();
    const count = main.writes.length;
    await save();

    expect(main.writes).toHaveLength(count);
  });
});

describe('pas deux écritures croisées', () => {
  it('Réinitialiser est désactivé pendant un Enregistrer', async () => {
    const disk = authorDisk();
    const main = installMain(disk);
    const release = main.hold('editor');
    await openPanel();

    fireEvent.change(fontInput(), { target: { value: '18' } });
    await act(async () => {
      fireEvent.click(saveButton());
    });
    await waitFor(() => expect(saveButton().disabled).toBe(true));

    expect(resetButton().disabled).toBe(true);
    fireEvent.click(resetButton());
    expect(useDialogStore.getState().confirmOpen).toBe(false);

    release();
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    expect(resetButton().disabled).toBe(false);
  });

  it('une question ouverte, puis un Enregistrer : Réinitialiser confirmé après coup n’écrit pas en même temps', async () => {
    const disk = authorDisk();
    const main = installMain(disk);
    const release = main.hold('editor');
    await openPanel();

    fireEvent.change(fontInput(), { target: { value: '18' } });
    fireEvent.click(resetButton());
    await screen.findByText('dialog.confirm');
    await act(async () => {
      fireEvent.click(saveButton());
    });
    await waitFor(() => expect(saveButton().disabled).toBe(true));
    await act(async () => {
      fireEvent.click(screen.getByText('dialog.confirm'));
    });

    // L'Enregistrer tourne encore : le main ne voit qu'une écriture, celle de l'éditeur.
    expect(main.writes.map((w) => w.section)).toEqual(['editor']);
    release();
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    expect(main.writes.map((w) => w.section)).toEqual(['editor']);
  });
});

describe('révocation des clés', () => {
  async function revoke(): Promise<void> {
    fireEvent.click(await screen.findByText('security.revokeButton'));
    fireEvent.click(await screen.findByText('dialog.confirm'));
    await screen.findByText(/security\.revokeSuccess/);
  }

  it('les champs de clés se vident, et rien ne repart au prochain Enregistrer', async () => {
    const disk = authorDisk();
    Object.assign(disk.llm as Section, { backend: 'openai', openaiAPIKey: 'sk-a...wXyZ' });
    (disk.zotero as Section).apiKey = 'abcd...wxyz';
    localStorage.setItem('cliodeck-settings-mode', 'expert');
    const main = installMain(disk);
    await openPanel();

    await revoke();
    fireEvent.click(screen.getByText('llm.title'));
    await waitFor(() =>
      expect((document.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('')
    );
    await save();

    expect(main.written('llm')).toEqual([]);
    expect(main.written('zotero')).toEqual([]);
    expect(disk.llm).not.toHaveProperty('openaiAPIKey');
    expect(disk.zotero).not.toHaveProperty('apiKey');
  });

  it('les autres modifications du formulaire survivent à la révocation et s’écrivent ensuite', async () => {
    const disk = authorDisk();
    Object.assign(disk.llm as Section, { backend: 'openai', openaiAPIKey: 'sk-a...wXyZ' });
    localStorage.setItem('cliodeck-settings-mode', 'expert');
    const main = installMain(disk);
    await openPanel();

    fireEvent.change(fontInput(), { target: { value: '18' } });
    await revoke();
    await waitFor(() => {
      expect(fontInput().value).toBe('18');
    });
    await save();

    expect(disk.editor?.fontSize).toBe(18);
    expect(main.written('llm')).toEqual([]);
  });

  it('une clé retapée après la révocation part bien', async () => {
    const disk = authorDisk();
    Object.assign(disk.llm as Section, { backend: 'openai', openaiAPIKey: 'sk-a...wXyZ' });
    localStorage.setItem('cliodeck-settings-mode', 'expert');
    const main = installMain(disk);
    await openPanel();

    await revoke();
    fireEvent.click(screen.getByText('llm.title'));
    const field = document.querySelector('input[type="password"]') as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe(''));
    fireEvent.change(field, { target: { value: 'sk-nouvelle-cle-saisie' } });
    await save();

    expect(main.written('llm')).toHaveLength(1);
    expect(disk.llm?.openaiAPIKey).toBe('sk-nouvelle-cle-saisie');
  });
});

describe('une clé illisible n’est pas écrasée', () => {
  it('un champ de clé saisi puis vidé ne part pas en effacement', async () => {
    // `getLLMConfig` omet une clé indéchiffrable : le champ est vide alors qu'elle existe encore.
    const disk = authorDisk();
    (disk.llm as Section).backend = 'openai';
    const main = installMain(disk);
    await openPanel();

    fireEvent.click(screen.getByText('llm.title'));
    const field = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'x' } });
    fireEvent.change(field, { target: { value: '' } });
    await save();

    expect(main.written('llm')).toEqual([]);
  });

  it('vider une clé présente garde son sens : effacer', async () => {
    const disk = authorDisk();
    Object.assign(disk.llm as Section, { backend: 'openai', openaiAPIKey: 'sk-a...wXyZ' });
    const main = installMain(disk);
    await openPanel();

    fireEvent.click(screen.getByText('llm.title'));
    fireEvent.change(document.querySelector('input[type="password"]') as HTMLInputElement, { target: { value: '' } });
    await save();

    expect(main.written('llm')).toHaveLength(1);
    expect(main.written('llm')[0].value.openaiAPIKey).toBe('');
  });
});
