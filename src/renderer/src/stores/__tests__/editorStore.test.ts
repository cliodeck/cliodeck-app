/**
 * Tests for editorStore.insertDraftAtCursor (fusion 2.6, migration CM6).
 *
 * L'éditeur réel exige une EditorView ; la façade est stubée avec les
 * seules méthodes que l'action lit. Le texte de l'IA n'a qu'un chemin : une
 * proposition, au curseur s'il est connu, sinon en fin de document. Sans
 * éditeur, ou sur une vue qui refuse, rien n'entre nulle part.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EditorFileError, openErrorKey, useEditorStore } from '../editorStore';
import { insertDraftAtOffset } from '../../components/Brainstorm/messageToDraft';
import i18n from '../../i18n';
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
  options: { accepts?: boolean; cursorKnown?: boolean } = {}
): {
  facade: EditorFacade;
  calls: { setValue: Array<{ text: string; cursor?: number }>; proposals: Array<Partial<Proposal>> };
} {
  const { accepts = true, cursorKnown = true } = options;
  const calls = {
    setValue: [] as Array<{ text: string; cursor?: number }>,
    proposals: [] as Array<Partial<Proposal>>,
  };
  let current = content;
  const facade: EditorFacade = {
    engine: 'cm6',
    getValue: () => current,
    getCursorOffset: () => cursor,
    hasKnownCursor: () => cursorKnown,
    getSelectionText: () => null,
    replaceSelection: () => undefined,
    setValue: (text, cursorOffset) => {
      current = text;
      calls.setValue.push({ text, cursor: cursorOffset });
    },
    appendText: (text) => {
      current += text;
    },
    propose: (p: Partial<Proposal>) => {
      calls.proposals.push(p);
      return accepts;
    },
    revealLine: () => undefined,
    focus: () => undefined,
    onContentChange: () => () => undefined,
  };
  return { facade, calls };
}

describe('insertDraftAtCursor — sans éditeur', () => {
  it('rend unavailable et ne touche pas au miroir', () => {
    useEditorStore.setState({ content: 'existing' });
    const { mode } = useEditorStore.getState().insertDraftAtCursor('NEW');
    expect(mode).toBe('unavailable');
    expect(useEditorStore.getState().content).toBe('existing');
    expect(useEditorStore.getState().isDirty).toBe(false);
  });

  it('document vide : rien n’y entre non plus', () => {
    const { mode } = useEditorStore.getState().insertDraftAtCursor('NEW');
    expect(mode).toBe('unavailable');
    expect(useEditorStore.getState().content).toBe('');
    expect(useEditorStore.getState().isDirty).toBe(false);
  });
});

describe('insertDraftAtCursor — contrat propositionnel (Phase 4)', () => {
  it('soumet une proposition d’insertion au curseur, sans toucher au document', () => {
    const { facade, calls } = fakeFacade('ABCDE', 3);
    useEditorStore.setState({ content: 'ABCDE', editorFacade: facade });

    const outcome = useEditorStore.getState().insertDraftAtCursor('NEW');
    expect(outcome.mode).toBe('cursor');
    expect(calls.proposals).toHaveLength(1);
    const p = calls.proposals[0];
    expect(p.category).toBe('brainstorm-draft');
    expect(p.original).toBe('');
    expect(p.range).toEqual({ from: 3, to: 3 });
    // Le segment proposé contient le draft avec son padding de bloc.
    expect(p.proposed).toBe('\n\nNEW\n\n');
    // Aucune écriture directe : le document ne change qu'à l'acceptation.
    expect(calls.setValue).toHaveLength(0);
    expect(facade.getValue()).toBe('ABCDE');
    expect(useEditorStore.getState().isDirty).toBe(false);
  });

  it('rend l’identifiant de la proposition : c’est par lui qu’on suit la décision', () => {
    const { facade, calls } = fakeFacade('ABCDE', 3);
    useEditorStore.setState({ content: 'ABCDE', editorFacade: facade });

    const outcome = useEditorStore.getState().insertDraftAtCursor('NEW');

    expect(outcome.mode === 'cursor' && outcome.proposalId).toBeTruthy();
    expect(outcome.mode === 'cursor' && outcome.proposalId).toBe(calls.proposals[0].id);
  });

  it('aucun curseur connu : la proposition va en fin de document, pas au-dessus du titre', () => {
    const { facade, calls } = fakeFacade('# Titre\n\nTexte.\n', 0, { cursorKnown: false });
    useEditorStore.setState({ content: '# Titre\n\nTexte.\n', editorFacade: facade });

    useEditorStore.getState().insertDraftAtCursor('NEW');

    expect(calls.proposals[0].range).toEqual({ from: 16, to: 16 });
    expect(calls.proposals[0].proposed).toBe('\nNEW');
  });

  it('un curseur connu à l’offset 0 reste au début', () => {
    const { facade, calls } = fakeFacade('# Titre\n', 0);
    useEditorStore.setState({ content: '# Titre\n', editorFacade: facade });

    useEditorStore.getState().insertDraftAtCursor('NEW');

    expect(calls.proposals[0].range).toEqual({ from: 0, to: 0 });
  });

  it('curseur en fin de ligne : la proposition reste au curseur, pas au début du bloc suivant', () => {
    const doc = 'Un.\n\nDeux.\n';
    const { facade, calls } = fakeFacade(doc, 3);
    useEditorStore.setState({ content: doc, editorFacade: facade });

    useEditorStore.getState().insertDraftAtCursor('NEW');

    expect(calls.proposals[0].range).toEqual({ from: 3, to: 3 });
    expect(calls.proposals[0].proposed).toBe('\n\nNEW');
  });

  it('un brouillon qui commence comme la suite du texte : la proposition reste au curseur', () => {
    const doc = 'Un.\n\nNouveau bloc.\n';
    const { facade, calls } = fakeFacade(doc, 5);
    useEditorStore.setState({ content: doc, editorFacade: facade });

    useEditorStore.getState().insertDraftAtCursor('Nouvelle idée');

    expect(calls.proposals[0].range).toEqual({ from: 5, to: 5 });
    expect(calls.proposals[0].proposed).toBe('Nouvelle idée\n\n');
  });

  it('à tout endroit du texte : l’ancre est le curseur, et accepter donne le même bloc', () => {
    const doc = '# Un\n\nDeux\nTrois.\n\n## Quatre\n';
    for (let offset = 0; offset <= doc.length; offset += 1) {
      const { facade, calls } = fakeFacade(doc, offset);
      useEditorStore.setState({ content: doc, editorFacade: facade });

      useEditorStore.getState().insertDraftAtCursor('# Deux idées');

      const { range, proposed } = calls.proposals[0];
      expect(range).toEqual({ from: offset, to: offset });
      expect(`${doc.slice(0, offset)}${proposed}${doc.slice(offset)}`).toBe(
        insertDraftAtOffset(doc, offset, '# Deux idées')
      );
    }
  });

  it('la vue refuse : unavailable, et aucune écriture de repli', () => {
    const { facade, calls } = fakeFacade('ABCDE', 3, { accepts: false });
    useEditorStore.setState({ content: 'ABCDE', editorFacade: facade });

    const { mode } = useEditorStore.getState().insertDraftAtCursor('NEW');

    expect(mode).toBe('unavailable');
    expect(calls.setValue).toHaveLength(0);
    expect(useEditorStore.getState().content).toBe('ABCDE');
    expect(useEditorStore.getState().isDirty).toBe(false);
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

describe('loadFile — verrou de bascule (renumérotation en cours)', () => {
  const files: Record<string, string> = {
    '/livre/chapters/01.md': '# Un\n',
    '/livre/chapters/02.md': '# Deux\n',
  };
  let saved: string[];

  beforeEach(async () => {
    saved = [];
    const g = globalThis as unknown as { window?: unknown };
    if (!g.window) g.window = g;
    (globalThis as unknown as { electron: unknown }).electron = {
      editor: {
        loadFile: async (path: string) => ({ success: true, content: files[path] }),
        saveFile: async (path: string) => {
          saved.push(path);
          return { success: true };
        },
      },
    } as never;
    await useEditorStore.getState().loadFile('/livre/chapters/01.md');
    useEditorStore.setState({ isDirty: true });
  });

  afterEach(() => {
    useEditorStore.setState({ switchLock: null } as never);
  });

  const lock = () => useEditorStore.setState({ switchLock: 'book.renumberInProgress' } as never);
  const LOCKED = { status: 'locked', lock: 'book.renumberInProgress' };

  it('refuse un autre fichier en rendant le motif du verrou, sans rien écrire ni charger', async () => {
    lock();

    await expect(useEditorStore.getState().loadFile('/livre/chapters/02.md')).resolves.toEqual(LOCKED);

    expect(useEditorStore.getState().filePath).toBe('/livre/chapters/01.md');
    expect(saved).toEqual([]);
  });

  it('laisse relire le fichier ouvert', async () => {
    lock();

    await useEditorStore.getState().loadFile('/livre/chapters/01.md');

    expect(useEditorStore.getState().filePath).toBe('/livre/chapters/01.md');
  });

  /** Remplace une réponse de l'IPC par une attente, relâchée par l'appelant. */
  function holdIpc(channel: 'saveFile' | 'loadFile', response: () => unknown): () => void {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { editor } = (globalThis as unknown as {
      electron: { editor: Record<string, unknown> };
    }).electron;
    editor[channel] = async () => {
      await gate;
      return response();
    };
    return release;
  }

  it('refuse à son arrivée une bascule partie avant lui, le sortant étant déjà écrit', async () => {
    const release = holdIpc('saveFile', () => ({ success: true }));

    const opening = useEditorStore.getState().loadFile('/livre/chapters/02.md');
    lock();
    release();

    await expect(opening).resolves.toEqual(LOCKED);
    expect(useEditorStore.getState().filePath).toBe('/livre/chapters/01.md');
    expect(useEditorStore.getState().content).toBe('# Un\n');
  });

  it('refuse de même une bascule dont la lecture était en cours', async () => {
    useEditorStore.setState({ isDirty: false });
    const version = useEditorStore.getState().documentVersion;
    const release = holdIpc('loadFile', () => ({ success: true, content: '# Deux\n' }));

    const opening = useEditorStore.getState().loadFile('/livre/chapters/02.md');
    await Promise.resolve();
    lock();
    release();

    await expect(opening).resolves.toEqual(LOCKED);
    expect(useEditorStore.getState().filePath).toBe('/livre/chapters/01.md');
    expect(useEditorStore.getState().content).toBe('# Un\n');
    expect(useEditorStore.getState().documentVersion).toBe(version);
  });

  it('repart une fois le verrou levé', async () => {
    useEditorStore.setState({ switchLock: 'book.renumberInProgress' } as never);
    useEditorStore.getState().setSwitchLock(null);

    await useEditorStore.getState().loadFile('/livre/chapters/02.md');

    expect(useEditorStore.getState().filePath).toBe('/livre/chapters/02.md');
  });
});

/**
 * La réponse d'une écriture peut revenir alors que l'éditeur porte un autre
 * document. La poser dans le store mettait le texte sortant dans le miroir du
 * nouveau document : invisible tant que la vue vit, puis affiché à son prochain
 * montage, et écrit dans le mauvais fichier à la frappe suivante.
 */
describe('saveFile — réponse revenue après un changement de document', () => {
  const A = '/livre/chapters/01.md';
  const B = '/livre/chapters/02.md';
  let releaseFirstWrite: () => void;
  let saved: Array<{ path: string; content: string }>;

  beforeEach(() => {
    saved = [];
    let held = false;
    const gate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const g = globalThis as unknown as { window?: unknown };
    if (!g.window) g.window = g;
    (globalThis as unknown as { electron: unknown }).electron = {
      editor: {
        loadFile: async () => ({ success: true, content: '# Deux\n' }),
        saveFile: async (path: string, content: string) => {
          saved.push({ path, content });
          if (!held) {
            held = true;
            await gate;
          }
          return { success: true };
        },
      },
    } as never;
    useEditorStore.setState({
      filePath: A,
      content: '# Un modifié\n',
      isDirty: true,
      lastSavedAt: null,
      editorFacade: null,
    });
  });

  it('une bascule de fichier : le miroir garde le document entrant', async () => {
    const writing = useEditorStore.getState().saveFile();
    await useEditorStore.getState().loadFile(B);

    releaseFirstWrite();
    await writing;

    const state = useEditorStore.getState();
    expect(state.filePath).toBe(B);
    expect(state.content).toBe('# Deux\n');
    expect(state.isDirty).toBe(false);
    expect(state.lastSavedAt).toBeNull();
    // L'écriture elle-même a eu lieu : c'est sa seule trace dans le store qui disparaît.
    expect(saved[0]).toEqual({ path: A, content: '# Un modifié\n' });
  });

  it('un nouveau tampon : il reste vide', async () => {
    const writing = useEditorStore.getState().saveFile();
    // Le document est déjà écrit : la seconde écriture de la porte n'aurait rien à dire.
    useEditorStore.setState({ isDirty: false });
    await useEditorStore.getState().createNewFile();

    releaseFirstWrite();
    await writing;

    const state = useEditorStore.getState();
    expect(state.filePath).toBeNull();
    expect(state.content).toBe('');
    expect(state.isDirty).toBe(false);
    expect(state.lastSavedAt).toBeNull();
  });

  it('sans changement de document : la réponse se pose comme d’habitude', async () => {
    const writing = useEditorStore.getState().saveFile();

    releaseFirstWrite();
    await writing;

    const state = useEditorStore.getState();
    expect(state.filePath).toBe(A);
    expect(state.content).toBe('# Un modifié\n');
    expect(state.isDirty).toBe(false);
    expect(state.lastSavedAt).not.toBeNull();
  });
});

/**
 * L'écriture part d'un instantané du texte, et l'auteur continue de taper. Sa réponse
 * effaçait `isDirty` et remettait le miroir à l'instantané : la frappe de pendant
 * l'écriture n'était plus annoncée nulle part, et l'autosave ne l'écrivait jamais.
 */
describe('saveFile — frappe pendant l’écriture', () => {
  const A = '/livre/chapters/01.md';
  const B = '/livre/chapters/02.md';
  let release: () => void;
  let saved: Array<{ path: string; content: string }>;
  let live: string;

  const typingFacade = () => ({ getValue: () => live }) as unknown as EditorFacade;

  beforeEach(() => {
    saved = [];
    let held = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const g = globalThis as unknown as { window?: unknown };
    if (!g.window) g.window = g;
    (globalThis as unknown as { electron: unknown }).electron = {
      editor: {
        loadFile: async () => ({ success: true, content: '# Deux\n' }),
        saveFile: async (path: string, content: string) => {
          saved.push({ path, content });
          if (!held) {
            held = true;
            await gate;
          }
          return { success: true };
        },
      },
    };
    live = 'a v1';
    useEditorStore.setState({
      filePath: A,
      content: 'a v0',
      isDirty: true,
      lastSavedAt: null,
      editorFacade: typingFacade(),
    });
  });

  afterEach(() => {
    useEditorStore.setState({ filePath: null, content: '', isDirty: false, editorFacade: null });
  });

  it('la synchro de la vue a poussé le texte : isDirty reste vrai, et le miroir garde le texte vivant', async () => {
    const writing = useEditorStore.getState().saveFile();
    live = 'a v1 v2';
    useEditorStore.setState({ content: live, isDirty: true });

    release();
    await writing;

    const state = useEditorStore.getState();
    expect(saved).toEqual([{ path: A, content: 'a v1' }]);
    expect(state.isDirty).toBe(true);
    expect(state.content).toBe('a v1 v2');
    // Ce qui est parti est bien sur le disque : la date le dit.
    expect(state.lastSavedAt).not.toBeNull();
  });

  it('la synchro de la vue n’est pas encore passée : même chose', async () => {
    const writing = useEditorStore.getState().saveFile();
    live = 'a v1 v2';

    release();
    await writing;

    expect(useEditorStore.getState().isDirty).toBe(true);
    expect(useEditorStore.getState().content).toBe('a v1 v2');
  });

  it('le fichier suivant : la porte écrit ces frappes dans leur fichier', async () => {
    const writing = useEditorStore.getState().saveFile();
    live = 'a v1 v2';
    useEditorStore.setState({ content: live, isDirty: true });
    release();
    await writing;

    await useEditorStore.getState().loadFile(B);

    expect(saved).toEqual([
      { path: A, content: 'a v1' },
      { path: A, content: 'a v1 v2' },
    ]);
    expect(useEditorStore.getState().filePath).toBe(B);
    expect(useEditorStore.getState().isDirty).toBe(false);
  });

  it('aucune vue montée : le miroir porte la frappe, et l’écriture ne la lui reprend pas', async () => {
    useEditorStore.setState({ content: 'a v1', editorFacade: null });
    const writing = useEditorStore.getState().saveFile();
    useEditorStore.setState({ content: 'a v1 v2', isDirty: true });

    release();
    await writing;

    expect(useEditorStore.getState().isDirty).toBe(true);
    expect(useEditorStore.getState().content).toBe('a v1 v2');
  });

  it('frappe annulée pendant l’écriture : le texte vivant est celui écrit, plus rien à faire', async () => {
    const writing = useEditorStore.getState().saveFile();
    live = 'a v1 v2';
    useEditorStore.setState({ content: live, isDirty: true });
    live = 'a v1';

    release();
    await writing;

    expect(useEditorStore.getState().isDirty).toBe(false);
    expect(useEditorStore.getState().content).toBe('a v1');
  });

  it('saveFileAs, aucune vue montée : la frappe de pendant l’écriture reste dans le miroir', async () => {
    useEditorStore.setState({ content: 'a v1', editorFacade: null });
    const writing = useEditorStore.getState().saveFileAs(B);
    useEditorStore.setState({ content: 'a v1 v2', isDirty: true });

    release();
    await writing;

    expect(useEditorStore.getState().filePath).toBe(B);
    expect(useEditorStore.getState().isDirty).toBe(true);
    expect(useEditorStore.getState().content).toBe('a v1 v2');
  });

  it('un échec d’écriture ne touche à rien : le texte reste à écrire', async () => {
    const failing = async () => ({ success: false, error: 'ENOSPC' });
    (globalThis as unknown as { electron: { editor: { saveFile: unknown } } }).electron.editor.saveFile = failing;

    await expect(useEditorStore.getState().saveFile()).rejects.toThrow('ENOSPC');

    expect(useEditorStore.getState().isDirty).toBe(true);
    expect(useEditorStore.getState().content).toBe('a v0');
    expect(useEditorStore.getState().lastSavedAt).toBeNull();
  });
});

/** Le contrat de l'erreur : `absent` est le seul cas où le document peut être créé. */
describe('loadFile — un document qui ne s’ouvre pas', () => {
  const A = '/p/a.md';
  const B = '/p/b.md';

  function respondWith(response: Record<string, unknown>): void {
    const g = globalThis as unknown as { window?: unknown };
    if (!g.window) g.window = g;
    (globalThis as unknown as { electron: unknown }).electron = {
      editor: { loadFile: async () => response, saveFile: async () => ({ success: true }) },
    };
  }

  beforeEach(() => {
    useEditorStore.setState({ filePath: A, content: '# A\n', isDirty: false, editorFacade: null });
  });

  afterEach(() => {
    useEditorStore.setState({ filePath: null, content: '', isDirty: false, editorFacade: null });
  });

  it.each([
    [{ success: false, code: 'absent', error: 'ENOENT' }, 'absent', undefined],
    [{ success: false, code: 'unreadable', reason: 'permission', error: 'EACCES' }, 'unreadable', 'permission'],
    [{ success: false, code: 'unreadable', reason: 'encoding', error: 'pas UTF-8' }, 'unreadable', 'encoding'],
  ])('%j : l’erreur le porte, et rien n’a changé', async (response, code, reason) => {
    respondWith(response);

    const error = await useEditorStore
      .getState()
      .loadFile(B)
      .then(
        () => null,
        (e: unknown) => e
      );

    expect(error).toBeInstanceOf(EditorFileError);
    expect(error).toMatchObject({ code, reason });
    expect(useEditorStore.getState().filePath).toBe(A);
    expect(useEditorStore.getState().content).toBe('# A\n');
  });

  it('une réponse qui ne dit pas ce qui se passe n’est jamais lue comme « absent »', async () => {
    respondWith({ success: false, error: 'tout autre échec' });

    await expect(useEditorStore.getState().loadFile(B)).rejects.toMatchObject({ code: 'unreadable' });
  });

  it('un fichier qui n’est pas en UTF-8 : le message dit quoi faire, et non « introuvable »', async () => {
    respondWith({ success: false, code: 'unreadable', reason: 'encoding', error: '/p/b.md n’est pas encodé en UTF-8' });

    const error = await useEditorStore
      .getState()
      .loadFile(B)
      .catch((e: unknown) => e);

    expect((error as Error).message).toBe(i18n.t('editor.notUtf8'));
    expect(openErrorKey(error, 'toolbar.openError')).toBe('editor.notUtf8');
  });

  // Rien n'a été lu : « ce fichier n'a pas pu être ouvert » enverrait l'auteur vers le mauvais.
  it('le document sortant qui ne s’écrit pas : le message dit l’enregistrement, et la cause reste', async () => {
    respondWith({ success: true, content: '# B\n' });
    window.electron.editor.saveFile = (async () => ({
      success: false,
      error: 'EACCES: permission denied',
    })) as never;
    useEditorStore.setState({ isDirty: true });

    const error = await useEditorStore
      .getState()
      .loadFile(B)
      .catch((e: unknown) => e);

    expect((error as Error).message).toBe('EACCES: permission denied');
    expect(openErrorKey(error, 'toolbar.openError')).toBe('toolbar.saveError');
    expect(useEditorStore.getState().filePath).toBe(A);
  });

  it('toute autre erreur garde le message de l’appelant', () => {
    expect(openErrorKey(new Error('EACCES'), 'toolbar.openError')).toBe('toolbar.openError');
    expect(openErrorKey(new EditorFileError('absent', undefined, 'x'), 'toolbar.openError')).toBe('toolbar.openError');
    expect(openErrorKey(new EditorFileError('unreadable', 'permission', 'x'), 'toolbar.openError')).toBe(
      'toolbar.openError'
    );
  });
});
