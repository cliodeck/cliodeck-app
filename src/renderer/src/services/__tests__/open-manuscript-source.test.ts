/**
 * Tests de l'ouverture d'un extrait de manuscrit.
 *
 * Trois choses valent d'être verrouillées ici :
 *
 * 1. la **garde anti-évasion**, seule défense côté renderer contre un chemin
 *    qui sortirait du dossier projet ;
 * 2. le fait que le chemin absolu soit composé à partir du projet courant et
 *    non du vault — c'était le bug que ce module existe pour éviter ;
 * 3. le **non-rechargement** d'un chapitre déjà ouvert : repasser par
 *    `loadFile` recréerait la vue et détruirait l'historique d'annulation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { ResolvedChapter } from '@backend/types/book';
import type { EditorFacade } from '@/editor/facade';
import { useEditorStore } from '../../stores/editorStore';
import { useProjectStore } from '../../stores/projectStore';
import { useWorkspaceModeStore } from '../../stores/workspaceModeStore';
import {
  canOpenManuscriptSource,
  isSafeProjectRelativePath,
  manuscriptRelativePath,
  openManuscriptSource,
} from '../open-manuscript-source';

const PROJECT_PATH = '/home/claire/Documents/Danzig';

function chapter(id: string, filePath: string): ResolvedChapter {
  return { id, title: id, filePath, order: 0, kind: 'chapter' };
}

interface Harness {
  loaded: string[];
  revealed: number[];
}

function setup(options: { openFilePath?: string } = {}): Harness {
  const harness: Harness = { loaded: [], revealed: [] };

  /**
   * Chaque bascule de fichier produit une façade NEUVE, comme dans l'app :
   * `CodeMirrorEditor` détruit sa vue et en recrée une. Le stub d'origine
   * laissait `editorFacade` intact — il rendait donc vert un code qui
   * s'adressait à la façade du chapitre SORTANT, exactement le défaut que
   * l'audit a trouvé. Un test ne doit pas mocker le mécanisme suspect.
   */
  const makeFacade = () =>
    ({
      revealLine: (line: number) => harness.revealed.push(line),
    }) as unknown as EditorFacade;

  useProjectStore.setState({
    // Seuls `path` et `chapters` sont lus par le service.
    currentProject: { path: PROJECT_PATH } as never,
    chapters: [chapter('c1', 'chapters/01-intro.md'), chapter('c2', 'chapters/02-corps.md')],
  });

  useEditorStore.setState({
    filePath: options.openFilePath ?? null,
    editorFacade: makeFacade(),
    loadFile: async (filePath: string) => {
      harness.loaded.push(filePath);
      // Cycle réel : la vue est démontée (façade retirée), le contenu
      // installé, puis la vue remontée au commit React SUIVANT — d'où le
      // délai. Entre les deux, `editorFacade` est nul.
      useEditorStore.setState({ filePath, editorFacade: null });
      setTimeout(() => {
        useEditorStore.setState({ editorFacade: makeFacade() });
      }, 0);
    },
  });

  useWorkspaceModeStore.setState({ active: 'brainstorm' });

  return harness;
}

describe('isSafeProjectRelativePath', () => {
  it('accepte un chemin relatif ordinaire', () => {
    expect(isSafeProjectRelativePath('chapters/01-intro.md')).toBe(true);
    expect(isSafeProjectRelativePath('document.md')).toBe(true);
    expect(isSafeProjectRelativePath('./chapters/01.md')).toBe(true);
  });

  it('refuse le vide et les chemins absolus', () => {
    expect(isSafeProjectRelativePath('')).toBe(false);
    expect(isSafeProjectRelativePath('/etc/passwd')).toBe(false);
    expect(isSafeProjectRelativePath('\\\\serveur\\partage\\x.md')).toBe(false);
    expect(isSafeProjectRelativePath('C:/Users/claire/x.md')).toBe(false);
    expect(isSafeProjectRelativePath('c:\\Users\\claire\\x.md')).toBe(false);
  });

  it('refuse toute remontée, y compris enfouie et en séparateurs Windows', () => {
    expect(isSafeProjectRelativePath('../secrets.md')).toBe(false);
    expect(isSafeProjectRelativePath('chapters/../../../etc/passwd')).toBe(false);
    expect(isSafeProjectRelativePath('chapters\\..\\..\\x.md')).toBe(false);
  });

  it("ne se laisse pas piéger par un nom de fichier contenant '..'", () => {
    // `..` doit être un SEGMENT, pas une sous-chaîne : ce fichier est légitime.
    expect(isSafeProjectRelativePath('chapters/notes..anciennes.md')).toBe(true);
  });
});

describe('manuscriptRelativePath / canOpenManuscriptSource', () => {
  it('lit relativePath en priorité, notePath en repli', () => {
    expect(manuscriptRelativePath({ relativePath: 'a.md', notePath: 'b.md' })).toBe('a.md');
    expect(manuscriptRelativePath({ notePath: 'b.md' })).toBe('b.md');
    expect(manuscriptRelativePath({})).toBeNull();
  });

  it("n'autorise l'ouverture que d'un chemin sûr et présent", () => {
    expect(canOpenManuscriptSource({ relativePath: 'chapters/01.md' })).toBe(true);
    expect(canOpenManuscriptSource({})).toBe(false);
    expect(canOpenManuscriptSource({ relativePath: '../x.md' })).toBe(false);
  });
});

describe('openManuscriptSource', () => {
  beforeEach(() => {
    useEditorStore.setState({ filePath: null, editorFacade: null });
  });

  it('bascule en mode Écriture, charge le chapitre et pose le curseur', async () => {
    const h = setup();

    const res = await openManuscriptSource({
      relativePath: 'chapters/02-corps.md',
      lineNumber: 42,
      chapterId: 'c2',
    });

    expect(res.success).toBe(true);
    expect(useWorkspaceModeStore.getState().active).toBe('write');
    // Composé sur le projet — jamais sur le vault Obsidian.
    expect(h.loaded).toEqual([`${PROJECT_PATH}/chapters/02-corps.md`]);
    expect(h.revealed).toEqual([42]);
    expect(useProjectStore.getState().currentChapterId).toBe('c2');
  });

  it('ne recharge pas un chapitre déjà ouvert mais y pose le curseur', async () => {
    const h = setup({ openFilePath: `${PROJECT_PATH}/chapters/01-intro.md` });

    const res = await openManuscriptSource({
      relativePath: 'chapters/01-intro.md',
      lineNumber: 7,
    });

    expect(res.success).toBe(true);
    expect(h.loaded).toEqual([]); // l'historique d'annulation survit
    expect(h.revealed).toEqual([7]);
  });

  it('ignore un chapterId inconnu du manifeste', async () => {
    setup();
    useProjectStore.setState({ currentChapterId: 'c1' });

    await openManuscriptSource({ relativePath: 'chapters/02-corps.md', chapterId: 'fantome' });

    expect(useProjectStore.getState().currentChapterId).toBe('c1');
  });

  it('refuse un chemin qui sort du projet sans rien charger', async () => {
    const h = setup();

    const res = await openManuscriptSource({ relativePath: '../../.ssh/id_rsa' });

    expect(res.success).toBe(false);
    expect(res.errorKey).toBe('chat.sources.manuscriptOutsideProject');
    expect(h.loaded).toEqual([]);
  });

  it('refuse un extrait sans chemin', async () => {
    setup();
    const res = await openManuscriptSource({});
    expect(res.success).toBe(false);
    expect(res.errorKey).toBe('chat.sources.untrackableManuscript');
  });

  it('remonte une clé d’erreur si aucun projet n’est ouvert', async () => {
    setup();
    useProjectStore.setState({ currentProject: null });

    const res = await openManuscriptSource({ relativePath: 'chapters/01-intro.md' });

    expect(res.success).toBe(false);
    expect(res.errorKey).toBe('chat.sources.manuscriptNoProject');
  });

  it('remonte openFailed quand la sauvegarde du fichier sortant échoue', async () => {
    const h = setup();
    // `loadFile` refuse de charger si le fichier sortant n'a pas pu être
    // sauvegardé (verrou phase 0) : l'échec doit rester visible.
    useEditorStore.setState({
      loadFile: async () => {
        throw new Error('sauvegarde du fichier sortant impossible');
      },
    });

    const res = await openManuscriptSource({ relativePath: 'chapters/02-corps.md', lineNumber: 3 });

    expect(res.success).toBe(false);
    expect(res.errorKey).toBe('chat.sources.openFailed');
    expect(h.revealed).toEqual([]); // pas de curseur posé sur un chargement raté
  });
});
