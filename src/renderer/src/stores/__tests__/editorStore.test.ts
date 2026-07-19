/**
 * Tests for editorStore.insertDraftAtCursor (fusion 2.6, migration CM6).
 *
 * L'éditeur réel exige une EditorView ; la façade est stubée avec les
 * seules méthodes que l'action lit. Trois chemins : proposition (Phase 4,
 * façade avec propose), insertion directe (façade sans propose), et
 * fallback append (aucun éditeur monté).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from '../editorStore';
import type { EditorFacade } from '@/editor/facade';
import type { Proposal } from '@/editor/proposals';

beforeEach(() => {
  useEditorStore.setState({
    content: '',
    isDirty: false,
    editorFacade: null,
  });
});

function fakeFacade(
  content: string,
  cursor: number,
  withPropose: boolean
): {
  facade: EditorFacade;
  calls: { setValue: Array<{ text: string; cursor?: number }>; proposals: Array<Partial<Proposal>> };
} {
  const calls = {
    setValue: [] as Array<{ text: string; cursor?: number }>,
    proposals: [] as Array<Partial<Proposal>>,
  };
  let current = content;
  const facade: EditorFacade = {
    engine: 'cm6',
    getValue: () => current,
    getCursorOffset: () => cursor,
    getSelectionText: () => null,
    replaceSelection: () => undefined,
    setValue: (text, cursorOffset) => {
      current = text;
      calls.setValue.push({ text, cursor: cursorOffset });
    },
    appendText: (text) => {
      current += text;
    },
    revealLine: () => undefined,
    focus: () => undefined,
    onContentChange: () => () => undefined,
    ...(withPropose
      ? {
          propose: (p: Partial<Proposal>) => {
            calls.proposals.push(p);
            return true;
          },
        }
      : {}),
  };
  return { facade, calls };
}

describe('insertDraftAtCursor — fallback path (no editor)', () => {
  it('appends the draft when no editor is mounted', () => {
    useEditorStore.setState({ content: 'existing' });
    const { mode } = useEditorStore.getState().insertDraftAtCursor('NEW');
    expect(mode).toBe('append');
    expect(useEditorStore.getState().content).toBe('existing\n\nNEW\n');
    expect(useEditorStore.getState().isDirty).toBe(true);
  });

  it('handles an empty document by writing the draft alone', () => {
    const { mode } = useEditorStore.getState().insertDraftAtCursor('NEW');
    expect(mode).toBe('append');
    expect(useEditorStore.getState().content).toBe('NEW');
  });
});

describe('insertDraftAtCursor — contrat propositionnel (Phase 4)', () => {
  it('soumet une proposition d’insertion au curseur, sans toucher au document', () => {
    const { facade, calls } = fakeFacade('ABCDE', 3, true);
    useEditorStore.setState({ content: 'ABCDE', editorFacade: facade });

    const { mode } = useEditorStore.getState().insertDraftAtCursor('NEW');
    expect(mode).toBe('cursor');
    expect(calls.proposals).toHaveLength(1);
    const p = calls.proposals[0];
    expect(p.category).toBe('brainstorm-draft');
    expect(p.original).toBe('');
    expect(p.range?.from).toBe(p.range?.to);
    // Le segment proposé contient le draft avec son padding de bloc.
    expect(p.proposed).toContain('NEW');
    // Aucune écriture directe : le document ne change qu'à l'acceptation.
    expect(calls.setValue).toHaveLength(0);
    expect(facade.getValue()).toBe('ABCDE');
  });
});

describe('insertDraftAtCursor — façade sans propositions (défensif)', () => {
  it('insère directement au curseur et synchronise le store', () => {
    const { facade, calls } = fakeFacade('ABCDE', 3, false);
    useEditorStore.setState({ content: 'ABCDE', editorFacade: facade });

    const { mode } = useEditorStore.getState().insertDraftAtCursor('NEW');
    expect(mode).toBe('cursor');
    expect(calls.setValue).toHaveLength(1);
    // Padding-aware splice: ABC + \n\n + NEW + \n\n + DE
    expect(calls.setValue[0].text).toBe('ABC\n\nNEW\n\nDE');
    expect(useEditorStore.getState().content).toBe('ABC\n\nNEW\n\nDE');
    expect(useEditorStore.getState().isDirty).toBe(true);
  });
});

/**
 * Bascule de fichier — régression de perte de données (2026-07-19).
 *
 * Reproduit dans l'app : taper dans document.md puis cliquer context.md
 * écrasait context.md avec le contenu de document.md, et la frappe de
 * document.md n'était jamais écrite. `loadFile` sauvegarde désormais le
 * fichier sortant avant de charger le suivant.
 */
describe('loadFile — sauvegarde du fichier sortant', () => {
  interface FakeIpc {
    saved: Array<{ path: string; content: string }>;
    loaded: string[];
  }

  function installEditorIpc(files: Record<string, string>): FakeIpc {
    const ipc: FakeIpc = { saved: [], loaded: [] };
    // Suite en environnement node : pas de `window` global.
    const g = globalThis as unknown as { window?: unknown };
    if (!g.window) g.window = g;
    (globalThis as unknown as { electron: unknown }).electron = {
      editor: {
        loadFile: async (path: string) => {
          ipc.loaded.push(path);
          return { success: true, content: files[path] ?? '' };
        },
        saveFile: async (path: string, content: string) => {
          ipc.saved.push({ path, content });
          files[path] = content;
          return { success: true };
        },
      },
    } as never;
    return ipc;
  }

  it('écrit le fichier sortant modifié avant d’ouvrir le suivant', async () => {
    const files = { '/p/document.md': 'doc', '/p/context.md': 'ctx' };
    const ipc = installEditorIpc(files);
    useEditorStore.setState({
      filePath: '/p/document.md',
      content: 'doc + frappe',
      isDirty: true,
      editorFacade: null,
    });

    await useEditorStore.getState().loadFile('/p/context.md');

    expect(ipc.saved).toEqual([{ path: '/p/document.md', content: 'doc + frappe' }]);
    expect(files['/p/context.md']).toBe('ctx'); // jamais contaminé
    expect(useEditorStore.getState().content).toBe('ctx');
    expect(useEditorStore.getState().filePath).toBe('/p/context.md');
    expect(useEditorStore.getState().isDirty).toBe(false);
  });

  it('ne sauvegarde rien si le document sortant est intact', async () => {
    const ipc = installEditorIpc({ '/p/a.md': 'a', '/p/b.md': 'b' });
    useEditorStore.setState({ filePath: '/p/a.md', content: 'a', isDirty: false });

    await useEditorStore.getState().loadFile('/p/b.md');

    expect(ipc.saved).toEqual([]);
    expect(useEditorStore.getState().content).toBe('b');
  });

  it('n’ouvre pas le fichier suivant si la sauvegarde du sortant échoue', async () => {
    installEditorIpc({ '/p/a.md': 'a', '/p/b.md': 'b' });
    (globalThis as unknown as {
      electron: { editor: { saveFile: unknown } };
    }).electron.editor.saveFile = async () => ({ success: false, error: 'disque plein' });
    useEditorStore.setState({ filePath: '/p/a.md', content: 'a modifié', isDirty: true });

    await expect(useEditorStore.getState().loadFile('/p/b.md')).rejects.toThrow();
    // Le document sortant reste en place : rien n'est perdu silencieusement.
    expect(useEditorStore.getState().filePath).toBe('/p/a.md');
    expect(useEditorStore.getState().content).toBe('a modifié');
  });
});

/**
 * Bascule entre N chapitres (plan chapitres, Phase 2) — extension du
 * scénario de non-régression de la Phase 0 : chaque chapitre conserve son
 * texte quel que soit l'ordre des allers-retours.
 */
describe('loadFile — bascule entre chapitres d’un livre', () => {
  function installEditorIpc(files: Record<string, string>) {
    const saved: Array<{ path: string; content: string }> = [];
    const g = globalThis as unknown as { window?: unknown };
    if (!g.window) g.window = g;
    (globalThis as unknown as { electron: unknown }).electron = {
      editor: {
        loadFile: async (path: string) => ({
          success: true,
          content: files[path] ?? '',
        }),
        saveFile: async (path: string, content: string) => {
          saved.push({ path, content });
          files[path] = content;
          return { success: true };
        },
      },
    } as never;
    return { files, saved };
  }

  it('n’écrit jamais le texte d’un chapitre dans le fichier d’un autre', async () => {
    const ipc = installEditorIpc({
      '/livre/chapters/01.md': '# Un\n',
      '/livre/chapters/02.md': '# Deux\n',
      '/livre/chapters/03.md': '# Trois\n',
    });
    const store = useEditorStore.getState();

    // Ouvrir le chapitre 1 et y écrire.
    await store.loadFile('/livre/chapters/01.md');
    useEditorStore.setState({ content: '# Un\nrédigé dans le 1.', isDirty: true });

    // Aller au 2, y écrire, puis au 3, puis revenir au 1.
    await store.loadFile('/livre/chapters/02.md');
    expect(useEditorStore.getState().content).toBe('# Deux\n');
    useEditorStore.setState({ content: '# Deux\nrédigé dans le 2.', isDirty: true });

    await store.loadFile('/livre/chapters/03.md');
    await store.loadFile('/livre/chapters/01.md');

    // Chaque fichier a exactement son propre texte.
    expect(ipc.files['/livre/chapters/01.md']).toBe('# Un\nrédigé dans le 1.');
    expect(ipc.files['/livre/chapters/02.md']).toBe('# Deux\nrédigé dans le 2.');
    expect(ipc.files['/livre/chapters/03.md']).toBe('# Trois\n');
    // …et l'éditeur affiche bien celui qu'on vient de rouvrir.
    expect(useEditorStore.getState().content).toBe('# Un\nrédigé dans le 1.');
  });

  it('ne réécrit pas un chapitre ouvert puis quitté sans modification', async () => {
    const ipc = installEditorIpc({
      '/livre/chapters/01.md': '# Un\n',
      '/livre/chapters/02.md': '# Deux\n',
    });
    const store = useEditorStore.getState();

    await store.loadFile('/livre/chapters/01.md');
    await store.loadFile('/livre/chapters/02.md');

    expect(ipc.saved).toEqual([]);
  });
});
