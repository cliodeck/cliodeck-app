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
import { AlertDialog } from '../../common/AlertDialog';
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

describe('ProjectPanel : fermer la modale de création', () => {
  const nameField = () => screen.queryByPlaceholderText('projectPanel.namePlaceholder');
  const overlay = () => document.querySelector('.create-project-modal') as HTMLElement;
  const pressEscape = () =>
    act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const openModal = () =>
    act(async () => {
      fireEvent.click(screen.getByTitle('project.newProject'));
    });

  /** Remplit la modale, sans cliquer sur Créer. */
  async function fillModal(name: string): Promise<void> {
    await openModal();
    fireEvent.change(nameField() as HTMLElement, { target: { value: name } });
    await act(async () => {
      fireEvent.click(screen.getByText('actions.browse'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('Échap ferme sans rien perdre : rouverte, elle a gardé le nom et le dossier', async () => {
    await act(async () => {
      render(<ProjectPanel />);
    });
    await fillModal('Neuf');

    await pressEscape();
    expect(nameField()).not.toBeInTheDocument();
    expect(dialogs().confirmOpen).toBe(false);

    await openModal();
    expect(nameField()).toHaveValue('Neuf');
    expect(screen.getByPlaceholderText('projectPanel.pathPlaceholder')).toHaveValue(PARENT);
  });

  it('Échap rend le focus au bouton « Nouveau projet », pas au corps de la page', async () => {
    await act(async () => {
      render(<ProjectPanel />);
    });
    const button = screen.getByTitle('project.newProject');
    button.focus();
    await openModal();
    expect(document.activeElement).toBe(nameField());

    await pressEscape();

    expect(document.activeElement).toBe(button);
  });

  it('un message par-dessus : Échap ne ferme que lui, et la saisie reste à l’écran', async () => {
    useEditorStore.setState({ switchLock: 'book.renumberInProgress' } as never);
    await act(async () => {
      render(
        <>
          <ProjectPanel />
          <AlertDialog />
        </>
      );
    });
    await submitCreation('Neuf');
    await vi.waitFor(() => expect(dialogs().alertOpen).toBe(true));

    await pressEscape();

    expect(dialogs().alertOpen).toBe(false);
    expect(nameField()).toHaveValue('Neuf');
  });

  it('pendant la création, ni Échap ni le fond ne ferment : Annuler est désactivé pour la même raison', async () => {
    let finish: (value: unknown) => void = () => undefined;
    create.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await act(async () => {
      render(<ProjectPanel />);
    });
    await submitCreation('Neuf');
    expect(create).toHaveBeenCalledTimes(1);
    expect(screen.getByText('actions.cancel')).toBeDisabled();

    await pressEscape();
    expect(nameField()).toBeInTheDocument();

    await act(async () => {
      fireEvent.mouseDown(overlay());
      fireEvent.click(overlay());
    });
    expect(nameField()).toBeInTheDocument();

    await act(async () => {
      finish({ success: false, error: 'non' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  it('Tab ne sort pas de la modale', async () => {
    await act(async () => {
      render(<ProjectPanel />);
    });
    await openModal();
    const cancel = screen.getByText('actions.cancel');
    const submit = screen.getByText('actions.create');
    // « Créer » est désactivé tant que les champs sont vides : Annuler est le dernier focalisable.
    expect(submit).toBeDisabled();
    cancel.focus();

    fireEvent.keyDown(document, { key: 'Tab' });

    expect(overlay().contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(cancel);
  });
});
