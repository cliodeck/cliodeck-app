// @vitest-environment jsdom
/**
 * « Brouillons d'autres projets » : les brouillons d'un projet déplacé, renommé ou supprimé (J12).
 *
 * Un brouillon porte le chemin de son projet (Q12) et ne se montre que dans lui. Dossier déplacé ou
 * renommé : ses brouillons n'apparaissaient plus nulle part, ni dans l'ancien projet (introuvable),
 * ni dans le projet rouvert sous son nouveau nom. Ils restaient dans le stockage, sans moyen de les
 * revoir. Le panneau demande au main où sont les projets (`project:locate`, testé à part sur le
 * disque) : ceux dont le projet n'est plus à son chemin vont dans une section repliée, d'où on les
 * rattache au projet ouvert ou les jette. Ceux d'un autre projet bien présent restent à ce projet.
 *
 * Vrais EditorPanel, DraftsPanel et stores ; la vue CM6 est réduite à sa façade, et le main à sa
 * réponse.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';
import { DEFAULT_BOOK_SETTINGS } from '@backend/types/book';

import { EditorPanel } from '../EditorPanel';
import { useDraftsStore, type BrainstormDraft } from '../../../stores/draftsStore';
import { useEditorStore } from '../../../stores/editorStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useDialogStore } from '../../../stores/dialogStore';

vi.mock('../CodeMirrorEditor', async () => {
  const React = await import('react');
  const { useEditorStore: store } = await import('../../../stores/editorStore');
  const CodeMirrorEditor = () => {
    React.useEffect(() => {
      store.getState().setEditorFacade({
        getValue: () => store.getState().content,
        setValue: () => undefined,
        onContentChange: () => () => undefined,
        onSelectionChange: () => () => undefined,
        getCursorOffset: () => 0,
      } as never);
      return () => store.getState().setEditorFacade(null);
    }, []);
    return null;
  };
  return { CodeMirrorEditor };
});

const OPEN = '/projets/These-2026';
/** L'ancien nom du dossier ouvert : plus rien à ce chemin. */
const GONE = '/projets/These';
/** Un autre projet, bien présent. */
const OTHER = '/projets/Article';
/** Un disque externe qui ne répond pas. */
const SILENT = '/Volumes/Disque/Livre';

type Place = { path: string; state: 'present'; key: string } | { path: string; state: 'absent' | 'unknown' };

let places: Record<string, Place>;
let locate: ReturnType<typeof vi.fn>;

const draft = (id: string, content: string, projectPath?: string): BrainstormDraft => ({
  id,
  content,
  createdAt: '2026-11-09T10:00:00.000Z',
  source: { model: 'qwen3:8b', task: 'brainstorm' },
  ...(projectPath ? { projectPath } : {}),
});

const counter = () => screen.getByTitle('drafts.title').querySelector('.toolbar-btn__count')?.textContent ?? '0';
/** Les brouillons du projet ouvert, dans la liste du panneau. */
const cards = () =>
  Array.from(document.querySelectorAll('.drafts-panel__list .drafts-panel__card-title')).map((title) => title.textContent);
const section = () => document.querySelector<HTMLDetailsElement>('details.drafts-panel__others');
/** Les brouillons de la section, par leur titre. */
const others = () =>
  Array.from(section()?.querySelectorAll('.drafts-panel__card-title') ?? []).map((title) => title.textContent);
const otherCard = (title: string): HTMLElement => {
  const card = within(section() as HTMLElement)
    .getByText(title, { selector: '.drafts-panel__card-title' })
    .closest('.drafts-panel__card');
  if (!(card instanceof HTMLElement)) throw new Error(`pas de carte « ${title} »`);
  return card;
};

async function show(projectPath: string, drafts: BrainstormDraft[]): Promise<void> {
  useDraftsStore.setState({ drafts, isPanelOpen: true, proposedIds: [] });
  act(() => {
    useProjectStore.setState({
      currentProject: {
        id: projectPath,
        name: projectPath,
        path: projectPath,
        type: 'article',
        createdAt: new Date(),
        lastOpenedAt: new Date(),
      },
      chapters: [],
      bookSettings: { ...DEFAULT_BOOK_SETTINGS },
      loadState: { kind: 'ready', loadedAt: 'avant', path: projectPath },
    });
    useEditorStore.setState({ filePath: `${projectPath}/document.md`, content: '# Texte\n', isDirty: false });
  });
  await act(async () => {
    render(<EditorPanel />);
  });
  // La réponse du main, s'il a été interrogé, est arrivée et a été rendue.
  await act(async () => {
    await Promise.allSettled(locate.mock.results.map((r) => r.value));
  });
}

beforeEach(() => {
  places = {
    [OPEN]: { path: OPEN, state: 'present', key: OPEN },
    [GONE]: { path: GONE, state: 'absent' },
    [OTHER]: { path: OTHER, state: 'present', key: OTHER },
    [SILENT]: { path: SILENT, state: 'unknown' },
  };
  locate = vi.fn(async (paths: string[]) => ({
    success: true,
    places: paths.map((p): Place => places[p] ?? { path: p, state: 'unknown' }),
  }));
  (window as unknown as { electron: unknown }).electron = {
    project: {
      readChapters: vi.fn(async () => ({ success: true, files: [] })),
      getChapters: vi.fn(async () => ({ success: true, chapters: [], unattached: [] })),
      locate,
    },
    editor: {
      loadFile: vi.fn(async () => ({ success: true, content: '# Texte\n' })),
      saveFile: vi.fn(async () => ({ success: true })),
    },
    ipcRenderer: { on: () => () => undefined },
  };
});

afterEach(() => {
  cleanup();
  while (useDialogStore.getState().confirmOpen) useDialogStore.getState().resolveConfirm(false);
  useEditorStore.setState({ editorFacade: null, filePath: null, content: '', isDirty: false });
  useProjectStore.setState({ currentProject: null, chapters: [], loadState: { kind: 'idle' } });
  useDraftsStore.setState({ drafts: [], isPanelOpen: false, proposedIds: [], projectPlaces: {} });
});

const MINE = draft('mien', 'Réponse du projet ouvert', OPEN);
const ORPHAN = draft('orphelin', 'Réponse d’avant le renommage', GONE);
const ELSEWHERE = draft('ailleurs', 'Réponse de l’article', OTHER);
const UNREACHABLE = draft('injoignable', 'Réponse du livre sur le disque externe', SILENT);

describe('la section « Brouillons d’autres projets »', () => {
  it('montre, repliée, le brouillon dont le projet n’est plus à son chemin ; pas ceux d’un projet présent ou injoignable', async () => {
    await show(OPEN, [MINE, ORPHAN, ELSEWHERE, UNREACHABLE]);

    expect(section()).not.toBeNull();
    expect(section()?.open).toBe(false);
    expect(section()?.querySelector('summary')?.textContent).toBe('drafts.otherProjects (1)');
    expect(others()).toEqual(['Réponse d’avant le renommage']);
    // Son ancien chemin est dit, pour que l'historien reconnaisse le projet.
    expect(within(otherCard('Réponse d’avant le renommage')).getByText(GONE)).toBeTruthy();
    // Les autres restent à leur projet (Q12) : ni dans la liste, ni dans la section.
    expect(cards()).toEqual(['Réponse du projet ouvert']);
    expect(counter()).toBe('1');
    expect(screen.queryByText('Réponse de l’article')).toBeNull();
    expect(screen.queryByText('Réponse du livre sur le disque externe')).toBeNull();
  });

  it('absente quand aucun brouillon n’a perdu son projet', async () => {
    await show(OPEN, [MINE, ELSEWHERE]);

    expect(section()).toBeNull();
  });

  it('« Rattacher à ce projet » : le brouillon passe dans ceux du projet ouvert', async () => {
    await show(OPEN, [MINE, ORPHAN]);

    fireEvent.click(within(otherCard('Réponse d’avant le renommage')).getByText(/drafts\.attach$/));
    await act(async () => {
      await Promise.allSettled(locate.mock.results.map((r) => r.value));
    });

    expect(cards()).toEqual(['Réponse du projet ouvert', 'Réponse d’avant le renommage']);
    expect(counter()).toBe('2');
    expect(section()).toBeNull();
    expect(useDraftsStore.getState().drafts.find((d) => d.id === 'orphelin')?.projectPath).toBe(OPEN);
  });

  it('« Jeter » demande confirmation, en rouge ; refusé, le brouillon reste ; accepté, il disparaît', async () => {
    await show(OPEN, [MINE, ORPHAN]);

    fireEvent.click(within(otherCard('Réponse d’avant le renommage')).getByText(/drafts\.discard$/));
    expect(useDialogStore.getState().confirmMessage).toBe('drafts.discardOtherConfirm');
    expect(useDialogStore.getState().confirmDanger).toBe(true);
    await act(async () => {
      useDialogStore.getState().resolveConfirm(false);
    });
    expect(others()).toEqual(['Réponse d’avant le renommage']);

    fireEvent.click(within(otherCard('Réponse d’avant le renommage')).getByText(/drafts\.discard$/));
    await act(async () => {
      useDialogStore.getState().resolveConfirm(true);
    });

    expect(useDraftsStore.getState().drafts.map((d) => d.id)).toEqual(['mien']);
    expect(section()).toBeNull();
    expect(cards()).toEqual(['Réponse du projet ouvert']);
  });
});

describe('le même dossier sous un autre chemin', () => {
  it('renommé par la seule casse (macOS) : ses brouillons sont ceux du projet rouvert, pas d’ailleurs', async () => {
    // `project.json` répond encore à l'ancien chemin : le dossier n'est pas absent, et la
    // comparaison des chaînes le cachait aussi dans le projet rouvert. La clé du disque tranche.
    const before = '/projets/Thèse';
    const after = '/projets/thèse';
    places[before] = { path: before, state: 'present', key: after };
    places[after] = { path: after, state: 'present', key: after };

    await show(after, [draft('casse', 'Réponse d’avant le renommage par la casse', before)]);

    expect(cards()).toEqual(['Réponse d’avant le renommage par la casse']);
    expect(counter()).toBe('1');
    expect(section()).toBeNull();
  });
});

describe('ce que le panneau demande au main', () => {
  it('le projet ouvert et les chemins des autres brouillons, une fois chacun ; rien pour ceux sans projet', async () => {
    await show(OPEN, [MINE, ORPHAN, draft('orphelin-2', 'Seconde réponse', GONE), draft('ancien', 'Sans projet')]);

    expect(locate.mock.calls.at(-1)?.[0]).toEqual([OPEN, GONE]);
  });

  it('le main ne répond pas : la comparaison des chemins seule, ni section ni réponse d’avant', async () => {
    // Une réponse d'avant disait l'ancien chemin absent ; le disque a pu changer depuis.
    useDraftsStore.setState({ projectPlaces: { [GONE]: { state: 'absent' } } });
    locate.mockImplementation(async () => {
      throw new Error('project:locate indisponible');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await show(OPEN, [MINE, ORPHAN]);

    expect(cards()).toEqual(['Réponse du projet ouvert']);
    expect(section()).toBeNull();
    vi.mocked(console.warn).mockRestore();
  });
});
