import { describe, expect, it, beforeEach, vi } from 'vitest';
import { useManuscriptStore, currentRelativePath } from '../manuscriptStore';
import { useProjectStore } from '../projectStore';
import { useEditorStore } from '../editorStore';

/**
 * Le store de manuscrit (Phase 3) tient une règle non négociable : le
 * chapitre OUVERT n'est jamais lu sur le disque — son texte vient de
 * l'éditeur vivant, sinon les frappes non sauvegardées seraient ignorées
 * par la renumérotation et les statistiques.
 */

const PROJECT_PATH = '/p/livre';

function installIpc(files: Record<string, string>): { readCalls: string[][] } {
  const readCalls: string[][] = [];
  const g = globalThis as unknown as { window?: unknown; electron?: unknown };
  if (!g.window) g.window = g;
  (globalThis as unknown as { electron: unknown }).electron = {
    project: {
      readChapters: vi.fn(async (data: { projectPath: string; filePaths: string[] }) => {
        readCalls.push(data.filePaths);
        return {
          success: true,
          files: data.filePaths.map((filePath) => ({
            filePath,
            content: files[filePath],
          })),
        };
      }),
    },
  } as never;
  return { readCalls };
}

function setChapters(): void {
  useProjectStore.setState({
    currentProject: {
      name: 'Livre',
      path: PROJECT_PATH,
      type: 'book',
      createdAt: new Date(),
    } as never,
    chapters: [
      { id: 'c1', title: 'Un', filePath: 'chapters/01.md', order: 0, kind: 'chapter' },
      { id: 'c2', title: 'Deux', filePath: 'chapters/02.md', order: 1, kind: 'chapter' },
      { id: 'c3', title: 'Absent', filePath: 'chapters/03.md', order: 2, kind: 'chapter', missing: true },
    ],
  });
}

beforeEach(() => {
  useManuscriptStore.getState().clear();
  setChapters();
  useEditorStore.setState({
    filePath: `${PROJECT_PATH}/chapters/01.md`,
    content: '# Un (live)\n\nFrappe non sauvegardée.\n',
    editorFacade: null,
  });
});

describe('currentRelativePath', () => {
  it('rend le chemin relatif au projet', () => {
    expect(currentRelativePath()).toBe('chapters/01.md');
  });

  it('rend null pour un fichier hors du projet', () => {
    useEditorStore.setState({ filePath: '/ailleurs/note.md' });
    expect(currentRelativePath()).toBeNull();
  });
});

describe('readManuscript', () => {
  it('lit le disque SAUF pour le chapitre ouvert', async () => {
    const { readCalls } = installIpc({
      'chapters/02.md': '# Deux (disque)\n',
    });

    const docs = await useManuscriptStore.getState().readManuscript();

    // Seul le chapitre fermé est lu ; le chapitre manquant est écarté.
    expect(readCalls).toEqual([['chapters/02.md']]);
    expect(docs.map((d) => [d.chapter.filePath, d.live])).toEqual([
      ['chapters/01.md', true],
      ['chapters/02.md', false],
    ]);
    // Le texte du chapitre ouvert est celui de l'éditeur, pas du disque.
    expect(docs[0].content).toContain('Frappe non sauvegardée');
  });

  it('respecte l’ordre du manifeste', async () => {
    installIpc({ 'chapters/02.md': '# Deux\n' });
    useProjectStore.setState({
      chapters: [
        { id: 'c2', title: 'Deux', filePath: 'chapters/02.md', order: 0 },
        { id: 'c1', title: 'Un', filePath: 'chapters/01.md', order: 1 },
      ],
    });
    const docs = await useManuscriptStore.getState().readManuscript();
    expect(docs.map((d) => d.chapter.filePath)).toEqual([
      'chapters/02.md',
      'chapters/01.md',
    ]);
  });
});

describe('refreshAll', () => {
  it('dérive statistiques et plan de chaque chapitre', async () => {
    installIpc({ 'chapters/02.md': '# Deux\n\n## Section\n\nDeux mots.\n' });

    await useManuscriptStore.getState().refreshAll();
    const { info } = useManuscriptStore.getState();

    expect(info['chapters/02.md'].outline.map((h) => h.text)).toEqual([
      'Deux',
      'Section',
    ]);
    // Le chapitre ouvert est dérivé du texte vivant.
    expect(info['chapters/01.md'].outline[0].text).toBe('Un (live)');
    expect(info['chapters/01.md'].stats.words).toBeGreaterThan(0);
    // Le chapitre manquant n'est pas lu.
    expect(info['chapters/03.md']).toBeUndefined();
  });

  it('vide le dérivé sans projet', async () => {
    useProjectStore.setState({ currentProject: null, chapters: [] });
    await useManuscriptStore.getState().refreshAll();
    expect(useManuscriptStore.getState().info).toEqual({});
  });
});
