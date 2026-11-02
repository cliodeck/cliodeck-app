// @vitest-environment jsdom
/**
 * Ouvrir un fichier du projet pendant que l'éditeur est verrouillé.
 *
 * Le refus du verrou s'affichait comme « fichier introuvable ou illisible » :
 * l'auteur cherchait un problème de fichier là où il suffisait d'attendre.
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
vi.mock('../OnboardingWizard', () => ({ OnboardingWizard: () => null }));

const PROJECT = '/p/article';

beforeEach(() => {
  (window as unknown as { electron: unknown }).electron = {
    project: { getRecent: vi.fn(async () => []) },
    editor: {
      loadFile: vi.fn(async () => {
        throw new Error('fichier illisible');
      }),
    },
  };
  useProjectStore.setState({
    currentProject: {
      id: 'p1',
      name: 'Article',
      path: PROJECT,
      type: 'article',
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
    loadRecentProjects: async () => undefined,
  } as never);
  useEditorStore.setState({
    filePath: `${PROJECT}/context.md`,
    content: '',
    isDirty: false,
    editorFacade: null,
  });
});

afterEach(() => {
  cleanup();
  useEditorStore.setState({ switchLock: null } as never);
  useProjectStore.setState({ currentProject: null });
  while (useDialogStore.getState().alertOpen) useDialogStore.getState().closeAlert();
});

describe('ProjectPanel : clic sur un fichier du projet', () => {
  it('verrou posé : la vraie raison du refus', async () => {
    useEditorStore.setState({ switchLock: 'book.renumberInProgress' } as never);
    await act(async () => {
      render(<ProjectPanel />);
    });

    await act(async () => {
      fireEvent.click(screen.getByText('document.md'));
    });

    expect(useDialogStore.getState().alertMessage).toBe('book.renumberInProgress');
    expect(useEditorStore.getState().filePath).toBe(`${PROJECT}/context.md`);
  });

  it('témoin : un fichier réellement illisible garde son message', async () => {
    await act(async () => {
      render(<ProjectPanel />);
    });

    await act(async () => {
      fireEvent.click(screen.getByText('document.md'));
    });

    expect(useDialogStore.getState().alertMessage).toBe('toolbar.openError');
  });
});
