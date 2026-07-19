/**
 * projectStore — manifeste des chapitres (Phase 1).
 *
 * Les actions de chapitres étaient in-memory et sans appelant : elles
 * persistent désormais via l'IPC. Ces tests vérifient le contrat côté
 * renderer — ce que le store envoie au main, et ce qu'il fait de la
 * réponse. Le vrai comportement disque est couvert par
 * `project-manager-book.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useProjectStore } from '../projectStore';
import { DEFAULT_BOOK_SETTINGS, type Chapter } from '@backend/types/book';

interface ProjectIpcCalls {
  saveChapters: Array<{ projectPath: string; chapters: Chapter[] }>;
  createChapter: Array<{ projectPath: string; title: string; kind?: string }>;
  saveBookSettings: Array<{ projectPath: string; settings: Record<string, unknown> }>;
  getChapters: string[];
}

function installProjectIpc(options: {
  chapters?: Chapter[];
  unattached?: Array<{ filePath: string }>;
  failSave?: boolean;
}) {
  const calls: ProjectIpcCalls = {
    saveChapters: [],
    createChapter: [],
    saveBookSettings: [],
    getChapters: [],
  };
  let chapters = options.chapters ?? [];

  // Suite en environnement node : pas de `window` global.
  const g = globalThis as unknown as { window?: unknown };
  if (!g.window) g.window = g;
  (globalThis as unknown as { electron: unknown }).electron = {
    project: {
      getChapters: async (projectPath: string) => {
        calls.getChapters.push(projectPath);
        return {
          success: true,
          chapters,
          unattached: options.unattached ?? [],
        };
      },
      saveChapters: async (data: { projectPath: string; chapters: Chapter[] }) => {
        calls.saveChapters.push(data);
        if (options.failSave) return { success: false, error: 'disque plein' };
        chapters = data.chapters.map((c, i) => ({ ...c, order: i }));
        return { success: true, chapters };
      },
      createChapter: async (data: { projectPath: string; title: string }) => {
        calls.createChapter.push(data);
        const created: Chapter = {
          id: `new-${data.title}`,
          title: data.title,
          filePath: `chapters/0${chapters.length + 1}-${data.title.toLowerCase()}.md`,
          order: chapters.length,
          kind: 'chapter',
        };
        chapters = [...chapters, created];
        return { success: true, chapter: created };
      },
      saveBookSettings: async (data: {
        projectPath: string;
        settings: Record<string, unknown>;
      }) => {
        calls.saveBookSettings.push(data);
        if (options.failSave) return { success: false, error: 'refusé' };
        return { success: true, settings: { ...DEFAULT_BOOK_SETTINGS, ...data.settings } };
      },
    },
  } as never;

  return calls;
}

const CHAPTER_A: Chapter = {
  id: 'a',
  title: 'A',
  filePath: 'chapters/01-a.md',
  order: 0,
  kind: 'chapter',
};
const CHAPTER_B: Chapter = {
  id: 'b',
  title: 'B',
  filePath: 'chapters/02-b.md',
  order: 1,
  kind: 'chapter',
};

beforeEach(() => {
  useProjectStore.setState({
    currentProject: {
      id: 'p1',
      name: 'Livre',
      path: '/p/Livre',
      type: 'book',
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
    chapters: [],
    unattachedFiles: [],
    currentChapterId: null,
    bookSettings: { ...DEFAULT_BOOK_SETTINGS },
  });
  vi.restoreAllMocks();
});

describe('refreshChapters', () => {
  it('interroge le main par CHEMIN de projet (pas par id)', async () => {
    const calls = installProjectIpc({ chapters: [CHAPTER_A] });
    await useProjectStore.getState().refreshChapters();
    expect(calls.getChapters).toEqual(['/p/Livre']);
    expect(useProjectStore.getState().chapters).toEqual([CHAPTER_A]);
  });

  it('expose les fichiers non rattachés', async () => {
    installProjectIpc({
      chapters: [CHAPTER_A],
      unattached: [{ filePath: 'chapters/orphelin.md' }],
    });
    await useProjectStore.getState().refreshChapters();
    expect(useProjectStore.getState().unattachedFiles).toEqual([
      { filePath: 'chapters/orphelin.md' },
    ]);
  });

  it('ne fait rien pour un projet qui n’est pas un livre', async () => {
    const calls = installProjectIpc({ chapters: [CHAPTER_A] });
    useProjectStore.setState({
      currentProject: { ...useProjectStore.getState().currentProject!, type: 'article' },
    });
    await useProjectStore.getState().refreshChapters();
    expect(calls.getChapters).toEqual([]);
  });
});

describe('addChapter', () => {
  it('délègue la création au main puis rafraîchit le manifeste', async () => {
    const calls = installProjectIpc({ chapters: [CHAPTER_A] });
    await useProjectStore.getState().addChapter('Danzig');

    expect(calls.createChapter).toEqual([
      { projectPath: '/p/Livre', title: 'Danzig', kind: undefined },
    ]);
    const titles = useProjectStore.getState().chapters.map((c) => c.title);
    expect(titles).toEqual(['A', 'Danzig']);
  });
});

describe('deleteChapter', () => {
  it('retire l’entrée du manifeste sans demander d’effacer le fichier', async () => {
    const calls = installProjectIpc({ chapters: [CHAPTER_A, CHAPTER_B] });
    useProjectStore.setState({ chapters: [CHAPTER_A, CHAPTER_B], currentChapterId: 'a' });

    await useProjectStore.getState().deleteChapter('a');

    // Un seul appel, et c'est une écriture de manifeste — aucune API de
    // suppression de fichier n'existe côté renderer.
    expect(calls.saveChapters).toHaveLength(1);
    expect(calls.saveChapters[0].chapters.map((c) => c.id)).toEqual(['b']);
    expect(useProjectStore.getState().currentChapterId).toBeNull();
  });

  it('n’envoie pas le drapeau `missing` au main', async () => {
    const calls = installProjectIpc({ chapters: [CHAPTER_A] });
    useProjectStore.setState({
      chapters: [CHAPTER_A, { ...CHAPTER_B, missing: true }],
    });

    await useProjectStore.getState().deleteChapter('a');

    expect(calls.saveChapters[0].chapters[0]).not.toHaveProperty('missing');
  });
});

describe('reorderChapters', () => {
  it('applique l’ordre localement puis persiste', async () => {
    const calls = installProjectIpc({ chapters: [CHAPTER_A, CHAPTER_B] });
    useProjectStore.setState({ chapters: [CHAPTER_A, CHAPTER_B] });

    await useProjectStore.getState().reorderChapters([CHAPTER_B, CHAPTER_A]);

    expect(useProjectStore.getState().chapters.map((c) => c.id)).toEqual(['b', 'a']);
    expect(useProjectStore.getState().chapters.map((c) => c.order)).toEqual([0, 1]);
    expect(calls.saveChapters[0].chapters.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('revient à la vérité disque si l’écriture échoue', async () => {
    installProjectIpc({ chapters: [CHAPTER_A, CHAPTER_B], failSave: true });
    useProjectStore.setState({ chapters: [CHAPTER_A, CHAPTER_B] });

    await expect(
      useProjectStore.getState().reorderChapters([CHAPTER_B, CHAPTER_A])
    ).rejects.toThrow();

    expect(useProjectStore.getState().chapters.map((c) => c.id)).toEqual(['a', 'b']);
  });
});

describe('updateBookSettings', () => {
  it('persiste et adopte les réglages normalisés du main', async () => {
    const calls = installProjectIpc({});
    await useProjectStore.getState().updateBookSettings({ noteStyle: 'endnote-book' });

    expect(calls.saveBookSettings[0].settings).toEqual({ noteStyle: 'endnote-book' });
    expect(useProjectStore.getState().bookSettings).toEqual({
      ...DEFAULT_BOOK_SETTINGS,
      noteStyle: 'endnote-book',
    });
  });

  it('restaure les réglages précédents si l’écriture échoue', async () => {
    installProjectIpc({ failSave: true });

    await expect(
      useProjectStore.getState().updateBookSettings({ bibliography: 'per-chapter' })
    ).rejects.toThrow();

    expect(useProjectStore.getState().bookSettings).toEqual(DEFAULT_BOOK_SETTINGS);
  });
});
