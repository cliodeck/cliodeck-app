// @vitest-environment jsdom
/**
 * Choisir un style CSL ne recharge plus le projet.
 *
 * Le panneau relançait tout `loadProject` pour relire un seul champ : l'auteur revenait
 * au premier chapitre et perdait son annulation, une indexation pouvait s'interrompre,
 * et le rechargement était une promesse sans `catch`.
 *
 * Vrais ProjectPanel, CSLSettings et stores ; l'IPC est simulé.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

import { ProjectPanel } from '../ProjectPanel';
import { useEditorStore } from '../../../stores/editorStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useDialogStore } from '../../../stores/dialogStore';
import { DEFAULT_BOOK_SETTINGS } from '@backend/types/book';

vi.mock('../../Config/ActionsSection', () => ({ ActionsSection: () => null }));
vi.mock('../ZoteroProjectSettings', () => ({ ZoteroProjectSettings: () => null }));
vi.mock('../RevealJsConfig', () => ({ RevealJsConfig: () => null }));
vi.mock('../OnboardingWizard', () => ({ OnboardingWizard: () => null }));

const PROJECT = '/p/livre';
const CHAPTER_FIVE = `${PROJECT}/chapters/05-cinq.md`;
const FINAL_PATH = `${PROJECT}/chicago.csl`;

let load: ReturnType<typeof vi.fn>;
let loadFile: ReturnType<typeof vi.fn>;
let setCSLPath: ReturnType<typeof vi.fn>;
let openFile: ReturnType<typeof vi.fn>;

async function mountPanel(cslPath?: string): Promise<void> {
  useProjectStore.setState({
    currentProject: {
      id: 'p1',
      name: 'Livre',
      path: PROJECT,
      type: 'book',
      createdAt: new Date(),
      lastOpenedAt: new Date(),
      cslPath,
    },
    chapters: [
      { id: 'c1', title: 'Un', filePath: 'chapters/01-un.md', order: 0, kind: 'chapter' },
      { id: 'c5', title: 'Cinq', filePath: 'chapters/05-cinq.md', order: 4, kind: 'chapter' },
    ],
    currentChapterId: 'c5',
    bookSettings: { ...DEFAULT_BOOK_SETTINGS },
    loadState: { kind: 'ready', loadedAt: 'avant', path: PROJECT },
    loadRecentProjects: async () => undefined,
  } as never);
  useEditorStore.setState({
    filePath: CHAPTER_FIVE,
    content: '# Cinq\n',
    isDirty: false,
    editorFacade: null,
  });
  await act(async () => {
    render(<ProjectPanel />);
  });
  await act(async () => {
    fireEvent.click(screen.getByText('project.settings'));
  });
}

const click = (element: Element) =>
  act(async () => {
    fireEvent.click(element);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

function expectNothingReloaded(): void {
  expect(load).not.toHaveBeenCalled();
  expect(loadFile).not.toHaveBeenCalled();
  expect(useEditorStore.getState().filePath).toBe(CHAPTER_FIVE);
  expect(useProjectStore.getState().currentChapterId).toBe('c5');
  expect(useProjectStore.getState().loadState.kind).toBe('ready');
}

beforeEach(() => {
  load = vi.fn(async () => ({ success: false, error: 'ne doit pas être appelé' }));
  loadFile = vi.fn(async () => ({ success: true, content: 'autre' }));
  setCSLPath = vi.fn(async () => ({ success: true, cslPath: FINAL_PATH }));
  openFile = vi.fn(async () => ({ canceled: false, filePaths: ['/ailleurs/chicago.csl'] }));
  (window as unknown as { electron: unknown }).electron = {
    project: { load, setCSLPath, getRecent: vi.fn(async () => []) },
    editor: { loadFile },
    dialog: { openFile },
  };
});

afterEach(() => {
  cleanup();
  useProjectStore.setState({ currentProject: null, chapters: [], currentChapterId: null });
  while (useDialogStore.getState().alertOpen) useDialogStore.getState().closeAlert();
});

describe('style CSL du projet', () => {
  it('choisir un style : seul currentProject.cslPath change, au chemin rendu par le main', async () => {
    await mountPanel();

    await click(screen.getByText('project.selectCSL'));

    expect(setCSLPath).toHaveBeenCalledWith({
      projectPath: `${PROJECT}/project.json`,
      cslPath: '/ailleurs/chicago.csl',
    });
    expectNothingReloaded();
    expect(useProjectStore.getState().currentProject?.cslPath).toBe(FINAL_PATH);
    expect(screen.getByText('chicago.csl')).toBeInTheDocument();
  });

  it('retirer le style : currentProject.cslPath revient à undefined', async () => {
    await mountPanel(FINAL_PATH);
    setCSLPath.mockResolvedValue({ success: true });

    await click(screen.getByTitle('csl.remove'));

    expect(setCSLPath).toHaveBeenCalledWith({ projectPath: `${PROJECT}/project.json`, cslPath: undefined });
    expectNothingReloaded();
    expect(useProjectStore.getState().currentProject?.cslPath).toBeUndefined();
    expect(screen.queryByText('chicago.csl')).not.toBeInTheDocument();
  });

  it('retrait refusé par le main : le style reste affiché, et l’auteur est prévenu', async () => {
    await mountPanel(FINAL_PATH);
    setCSLPath.mockResolvedValue({ success: false, error: 'disque plein' });

    await click(screen.getByTitle('csl.remove'));

    expect(useProjectStore.getState().currentProject?.cslPath).toBe(FINAL_PATH);
    expect(screen.getByText('chicago.csl')).toBeInTheDocument();
    expect(useDialogStore.getState().alertOpen).toBe(true);
    expectNothingReloaded();
  });

  it('enregistrement refusé par le main : rien ne change, et l’auteur est prévenu', async () => {
    await mountPanel();
    setCSLPath.mockResolvedValue({ success: false, error: 'disque plein' });

    await click(screen.getByText('project.selectCSL'));

    expect(useProjectStore.getState().currentProject?.cslPath).toBeUndefined();
    expect(useDialogStore.getState().alertOpen).toBe(true);
    expectNothingReloaded();
  });
});
