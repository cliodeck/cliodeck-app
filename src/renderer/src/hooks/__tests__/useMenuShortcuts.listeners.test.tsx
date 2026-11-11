// @vitest-environment jsdom
/**
 * Une commande de menu, une exécution — et dans la langue de l'interface.
 *
 * L'effet de `useMenuShortcuts` dépendait de `t`, que react-i18next renouvelle à chaque
 * `languageChanged` : i18next l'émet au lancement même pour une langue inchangée, puis à chaque
 * changement dans les Réglages. Le nettoyage passait par `removeListener`, qui ne retire rien à
 * travers `contextBridge` : une série d'écouteurs de plus à chaque relance. Les écouteurs restés
 * en place gardaient en outre le `t` de la langue d'avant, et répondaient les premiers : la
 * question de Cmd+N sortait en français sous une interface anglaise (S15-1-22).
 *
 * Vrais preload (derrière un `contextBridge` simulé), react-i18next, hook et stores ; le disque
 * et les dialogues natifs sont simulés derrière l'IPC.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import type { EditorFacade } from '@/editor/facade';
import type { SimulatedElectron } from '../../../../preload/__tests__/helpers/simulated-bridge';
import { useMenuShortcuts } from '../useMenuShortcuts';
import { useEditorStore } from '../../stores/editorStore';
import { useProjectStore } from '../../stores/projectStore';
import { useDialogStore } from '../../stores/dialogStore';
import i18n from '../../i18n';

// Le vrai react-i18next : le simulacre global rend un `t` neuf à chaque rendu, sans jamais
// changer de langue, et ne voit ni l'un ni l'autre défaut.
vi.mock('react-i18next', async () => vi.importActual('react-i18next'));

const sim = vi.hoisted(() => ({ current: null as SimulatedElectron | null }));
vi.mock('electron', async () => {
  const { createSimulatedElectron } = await import('../../../../preload/__tests__/helpers/simulated-bridge');
  sim.current = createSimulatedElectron();
  return sim.current.module;
});
import '../../../../preload/index';

const electron = () => sim.current as SimulatedElectron;

const DOCUMENT = '/p/projet/document.md';
const MENU_CHANNELS = [
  'menu:new-file', 'menu:open-file', 'menu:save-file', 'menu:new-project', 'menu:open-project',
  'menu:export-pdf', 'menu:format-bold', 'menu:format-italic', 'menu:insert-link',
  'menu:insert-citation', 'menu:insert-table', 'menu:insert-footnote', 'menu:insert-blockquote',
  'menu:check-citations', 'menu:toggle-preview', 'menu:switch-panel', 'menu:import-bibtex',
  'menu:connect-zotero', 'menu:open-settings', 'menu:open-usage-journal', 'menu:about',
];

let saveDialog: ReturnType<typeof vi.fn>;
let loadFile: (path: string) => Promise<unknown>;
let saveFile: () => Promise<{ success: boolean; error?: string }>;
let live: string;

const dialogs = () => useDialogStore.getState();
const facade = () => ({ getValue: () => live, setValue: () => undefined }) as unknown as EditorFacade;

/** Une entrée de menu telle que le main l'envoie, et ce qui en découle sans attendre l'auteur. */
async function menu(channel: string): Promise<void> {
  await act(async () => {
    electron().sendFromMain(channel);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function changeLanguage(language: string): Promise<void> {
  await act(async () => {
    await i18n.changeLanguage(language);
  });
}

beforeEach(async () => {
  await i18n.changeLanguage('fr');
  live = '# Article\n';
  saveDialog = vi.fn(async () => ({ canceled: true }));
  loadFile = async () => ({ success: true, content: live });
  saveFile = async () => ({ success: true });
  // Le pont des commandes est celui du preload ; l'éditeur et les dialogues sont simulés.
  (window as unknown as { electron: unknown }).electron = {
    ...(electron().exposed() as object),
    editor: {
      loadFile: (path: string) => loadFile(path),
      saveFile: () => saveFile(),
    },
    dialog: { saveFile: saveDialog, openFile: async () => ({ canceled: false, filePaths: ['/ailleurs/note.md'] }) },
  };
  useProjectStore.setState({
    currentProject: {
      id: 'p1',
      name: 'Projet',
      path: '/p/projet',
      type: 'article',
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
  });
  useEditorStore.setState({
    filePath: DOCUMENT,
    content: live,
    isDirty: false,
    switchLock: null,
    bufferDetached: false,
    editorFacade: facade(),
  });
});

afterEach(async () => {
  cleanup();
  useEditorStore.setState({ filePath: null, editorFacade: null, switchLock: null, bufferDetached: false });
  useProjectStore.setState({ currentProject: null, chapters: [] });
  while (dialogs().confirmOpen) dialogs().resolveConfirm(false);
  while (dialogs().alertOpen) dialogs().closeAlert();
  await i18n.changeLanguage('fr');
});

describe('un écouteur par commande', () => {
  it('au montage, un seul écouteur par canal', () => {
    renderHook(() => useMenuShortcuts());

    for (const channel of MENU_CHANNELS) expect(electron().listenerCount(channel), channel).toBe(1);
  });

  it('au montage, le preload dit au main que chaque commande est écoutée (menu:listening)', () => {
    // Une fenêtre recréée par le menu (macOS, fenêtre fermée) : le main garde la commande jusqu'à
    // ce que son écouteur soit posé. Envoyée à `did-finish-load`, elle partait avant le montage de
    // React, et se perdait.
    const send = vi.spyOn(electron().module.ipcRenderer, 'send');

    renderHook(() => useMenuShortcuts());

    const announced = send.mock.calls.filter(([channel]) => channel === 'menu:listening').map(([, c]) => c);
    expect(new Set(announced)).toEqual(new Set(MENU_CHANNELS));
    send.mockRestore();
  });

  it('après le changeLanguage du lancement, même vers la langue en cours : toujours un seul', async () => {
    renderHook(() => useMenuShortcuts());

    await changeLanguage('fr');

    for (const channel of MENU_CHANNELS) expect(electron().listenerCount(channel), channel).toBe(1);
  });

  it('démonté : plus aucun écouteur', async () => {
    const { unmount } = renderHook(() => useMenuShortcuts());
    await changeLanguage('en');

    unmount();

    for (const channel of MENU_CHANNELS) expect(electron().listenerCount(channel), channel).toBe(0);
  });

  it('après deux changements de langue, un Cmd+S en échec donne une alerte', async () => {
    renderHook(() => useMenuShortcuts());
    await changeLanguage('en');
    await changeLanguage('de');
    live = '# Article\nfrappe\n';
    useEditorStore.setState({ isDirty: true });
    saveFile = async () => ({ success: false, error: 'EACCES: permission denied' });

    await menu('menu:save-file');

    expect(dialogs().queue).toHaveLength(1);
    expect(dialogs().alertMessage).toBe(i18n.t('toolbar.saveError', { lng: 'de' }));
  });

  it('Cmd+S sur un tampon sans titre : un seul « Enregistrer sous »', async () => {
    renderHook(() => useMenuShortcuts());
    await changeLanguage('fr');
    useEditorStore.setState({ filePath: null });

    await menu('menu:save-file');

    expect(saveDialog).toHaveBeenCalledTimes(1);
  });
});

describe.each(['en', 'de'])('dans la langue de l’interface (%s), après un changement en session', (language) => {
  beforeEach(async () => {
    renderHook(() => useMenuShortcuts());
    await changeLanguage(language);
  });

  it('Cmd+N : la question', async () => {
    await menu('menu:new-file');

    expect(dialogs().queue).toHaveLength(1);
    expect(dialogs().confirmMessage).toBe(i18n.t('toolbar.newFileConfirm', { lng: language }));
  });

  it('Cmd+O sur un fichier illisible : une alerte', async () => {
    loadFile = async () => ({ success: false, code: 'unreadable', reason: 'permission', error: 'EACCES' });

    await menu('menu:open-file');

    expect(dialogs().queue).toHaveLength(1);
    expect(dialogs().alertMessage).toBe(i18n.t('toolbar.openError', { lng: language }));
  });

  it('Cmd+O pendant une renumérotation : le verrou', async () => {
    act(() => useEditorStore.getState().setSwitchLock('book.renumberInProgress'));

    await menu('menu:open-file');

    expect(dialogs().queue).toHaveLength(1);
    expect(dialogs().alertMessage).toBe(i18n.t('book.renumberInProgress', { lng: language }));
  });

  it('Vérifier les citations : le bilan', async () => {
    await menu('menu:check-citations');

    expect(dialogs().queue).toHaveLength(1);
    expect(dialogs().alertMessage).toBe(i18n.t('citations.allValid', { count: 0, lng: language }));
  });
});
