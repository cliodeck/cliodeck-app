// @vitest-environment jsdom
/**
 * Changer de projet alors que le document ouvert ne s'écrit pas.
 *
 * Rien n'a été lu du projet demandé : « Ce projet n'a pas pu être ouvert… project.json » ou
 * « Vérifiez que le dossier choisi est accessible en écriture » envoyaient l'auteur vers le
 * mauvais fichier, et rien ne lui disait que son texte n'était pas enregistré.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

import { ProjectPanel } from '../ProjectPanel';
import { useEditorStore } from '../../../stores/editorStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useDialogStore } from '../../../stores/dialogStore';

vi.mock('../../Config/ActionsSection', () => ({ ActionsSection: () => null }));
vi.mock('../ZoteroProjectSettings', () => ({ ZoteroProjectSettings: () => null }));
vi.mock('../CSLSettings', () => ({ CSLSettings: () => null }));
vi.mock('../RevealJsConfig', () => ({ RevealJsConfig: () => null }));
vi.mock('../OnboardingWizard', () => ({
  OnboardingWizard: () => <div data-testid="onboarding" />,
}));

const A = '/p/projet-a';
const B = '/p/projet-b';
const OPEN_DOCUMENT = `${A}/document.md`;

let load: ReturnType<typeof vi.fn>;
let create: ReturnType<typeof vi.fn>;
let getMetadata: ReturnType<typeof vi.fn>;

const dialogs = () => useDialogStore.getState();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Les deux portes d'ouverture : le bouton et la liste des projets récents. */
const OPEN_DOORS: Array<[string, () => Promise<void>]> = [
  [
    'le bouton Ouvrir un projet',
    async () => {
      await act(async () => {
        fireEvent.click(screen.getByTitle('project.openProject'));
        await flush();
      });
    },
  ],
  [
    'la liste des projets récents',
    async () => {
      await act(async () => {
        fireEvent.click(screen.getByText('project.recentProjects'));
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Projet B'));
        await flush();
      });
    },
  ],
];

async function renderPanel(): Promise<void> {
  await act(async () => {
    render(<ProjectPanel />);
    await flush();
  });
}

beforeEach(() => {
  load = vi.fn(async () => ({ success: false, error: 'le projet ne doit pas être demandé au main' }));
  create = vi.fn(async () => ({ success: false, error: 'le projet ne doit pas être demandé au main' }));
  getMetadata = vi.fn(async () => ({
    success: true,
    project: { id: 'b', name: 'Projet B', type: 'article', path: B, createdAt: new Date().toISOString() },
  }));
  (window as unknown as { electron: unknown }).electron = {
    project: { load, create, getMetadata, getRecent: vi.fn(async () => [`${B}/project.json`]) },
    editor: {
      loadFile: vi.fn(async () => ({ success: true, content: '# B' })),
      saveFile: vi.fn(async () => ({ success: false, error: 'EACCES: permission denied' })),
    },
    dialog: { openFile: vi.fn(async () => ({ canceled: false, filePaths: [`${B}/project.json`] })) },
  };
  useProjectStore.setState({
    currentProject: {
      id: 'a',
      name: 'Projet A',
      path: A,
      type: 'article',
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
    loadState: { kind: 'idle' },
  });
  useEditorStore.setState({
    filePath: OPEN_DOCUMENT,
    content: 'Une phrase pas encore écrite.',
    isDirty: true,
    editorFacade: null,
    switchLock: null,
    bufferDetached: false,
  } as never);
});

afterEach(() => {
  cleanup();
  useEditorStore.setState({ filePath: null, content: '', isDirty: false, switchLock: null, bufferDetached: false } as never);
  useProjectStore.setState({ currentProject: null, recentProjects: [], loadState: { kind: 'idle' } });
  while (dialogs().alertOpen) dialogs().closeAlert();
});

describe('ProjectPanel : le document ouvert ne s’écrit pas', () => {
  it.each(OPEN_DOORS)('ouvrir par %s : le message parle de l’enregistrement, et rien ne bouge', async (_door, open) => {
    await renderPanel();

    await open();
    await vi.waitFor(() => expect(dialogs().alertOpen).toBe(true));

    expect(dialogs().alertMessage).toBe('toolbar.saveError');
    expect(load).not.toHaveBeenCalled();
    expect(useProjectStore.getState().currentProject?.path).toBe(A);
    expect(useEditorStore.getState().filePath).toBe(OPEN_DOCUMENT);
    expect(useEditorStore.getState().isDirty).toBe(true);
  });

  it.each(OPEN_DOORS)('témoin, par %s : un project.json illisible garde son message', async (_door, open) => {
    await renderPanel();
    // La liste des récents a son projet, seule l'ouverture qui suit lit un fichier abîmé.
    getMetadata.mockResolvedValue({ success: false, code: 'manifest_unreadable', error: 'invalid_json' });

    await open();
    await vi.waitFor(() => expect(dialogs().alertOpen).toBe(true));

    expect(dialogs().alertMessage).toBe('project.openError');
  });

  it('créer un projet : le message parle de l’enregistrement, et la modale garde ce qui est saisi', async () => {
    await renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByTitle('project.newProject'));
    });
    fireEvent.change(screen.getByPlaceholderText('projectPanel.namePlaceholder'), {
      target: { value: 'Neuf' },
    });
    await act(async () => {
      fireEvent.click(screen.getByText('actions.browse'));
      await flush();
    });
    await act(async () => {
      fireEvent.click(screen.getByText('actions.create'));
      await flush();
    });
    await vi.waitFor(() => expect(dialogs().alertOpen).toBe(true));

    expect(dialogs().alertMessage).toBe('toolbar.saveError');
    expect(create).not.toHaveBeenCalled();
    expect(screen.queryByTestId('onboarding')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('projectPanel.namePlaceholder')).toHaveValue('Neuf');
    expect(useEditorStore.getState().filePath).toBe(OPEN_DOCUMENT);
  });
});
