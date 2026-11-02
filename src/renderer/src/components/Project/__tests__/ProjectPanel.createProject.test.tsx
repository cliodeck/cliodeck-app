// @vitest-environment jsdom
/**
 * La modale de création, quand le projet n'est pas créé sans qu'il y ait d'erreur.
 *
 * Un refus du verrou ou de la question du tampon sans titre n'est pas une exception :
 * sans autre signal, le panneau fermait la modale et lançait l'accompagnement d'un
 * projet qui n'existe pas.
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

const PARENT = '/p';
let create: ReturnType<typeof vi.fn>;

const dialogs = () => useDialogStore.getState();

/** Remplit la modale, puis clique sur Créer sans attendre la fin. */
async function submitCreation(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTitle('project.newProject'));
  });
  fireEvent.change(screen.getByPlaceholderText('projectPanel.namePlaceholder'), {
    target: { value: name },
  });
  await act(async () => {
    fireEvent.click(screen.getByText('actions.browse'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    fireEvent.click(screen.getByText('actions.create'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  create = vi.fn(async () => ({
    success: true,
    project: { id: 'x', name: 'Neuf', type: 'article', path: `${PARENT}/Neuf`, createdAt: new Date().toISOString() },
  }));
  (window as unknown as { electron: unknown }).electron = {
    project: { create, getRecent: vi.fn(async () => []) },
    editor: {
      loadFile: vi.fn(async () => ({ success: true, content: '# Neuf' })),
      saveFile: vi.fn(async () => ({ success: true })),
    },
    dialog: { openFile: vi.fn(async () => ({ canceled: false, filePaths: [PARENT] })) },
  };
  useProjectStore.setState({ currentProject: null, loadState: { kind: 'idle' } });
  useEditorStore.setState({
    filePath: null,
    content: '',
    isDirty: false,
    editorFacade: null,
    switchLock: null,
    bufferDetached: false,
  } as never);
});

afterEach(() => {
  cleanup();
  useEditorStore.setState({ switchLock: null, bufferDetached: false, content: '' } as never);
  useProjectStore.setState({ currentProject: null, loadState: { kind: 'idle' } });
  while (dialogs().confirmOpen) dialogs().resolveConfirm(false);
  while (dialogs().alertOpen) dialogs().closeAlert();
});

describe('ProjectPanel : créer un projet', () => {
  it('projet créé : la modale se ferme et l’accompagnement démarre', async () => {
    await act(async () => {
      render(<ProjectPanel />);
    });

    await submitCreation('Neuf');
    await vi.waitFor(() => expect(screen.getByTestId('onboarding')).toBeInTheDocument());

    expect(create).toHaveBeenCalledTimes(1);
    expect(screen.queryByPlaceholderText('projectPanel.namePlaceholder')).not.toBeInTheDocument();
  });

  it('l’auteur garde son tampon sans titre : la modale reste, avec ce qu’il a saisi', async () => {
    useEditorStore.setState({ content: 'Une idée sans titre.' });
    await act(async () => {
      render(<ProjectPanel />);
    });

    await submitCreation('Neuf');
    await vi.waitFor(() => expect(dialogs().confirmOpen).toBe(true));
    await act(async () => {
      dialogs().resolveConfirm(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(create).not.toHaveBeenCalled();
    expect(screen.queryByTestId('onboarding')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('projectPanel.namePlaceholder')).toHaveValue('Neuf');
    expect(screen.getByText('actions.create')).toBeInTheDocument();
  });

  it('verrou de la renumérotation : la raison est dite, et la modale reste', async () => {
    useEditorStore.setState({ switchLock: 'book.renumberInProgress' } as never);
    await act(async () => {
      render(<ProjectPanel />);
    });

    await submitCreation('Neuf');
    await vi.waitFor(() => expect(dialogs().alertOpen).toBe(true));
    await act(async () => {
      dialogs().closeAlert();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(create).not.toHaveBeenCalled();
    expect(screen.queryByTestId('onboarding')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('projectPanel.namePlaceholder')).toHaveValue('Neuf');
  });
});
