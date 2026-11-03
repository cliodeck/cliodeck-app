// @vitest-environment jsdom
/**
 * Créer ou ouvrir un projet coupe l'éditeur du projet qu'on quitte et ouvre le bon
 * document.
 *
 * `createProject` n'ouvrait rien : l'éditeur restait sur le fichier du projet précédent,
 * dont le main refusait désormais l'écriture, ou sur un tampon sans chemin. Une session
 * entière se perdait sans un mot. Et une frappe pendant `project:load` faisait rejeter
 * la bascule, dont le repli réécrivait le document du projet entrant par « # Nom ».
 *
 * Vrais stores, vraie vue CM6, vrai autosave, et le VRAI `authorizeDocumentPath` sur de
 * vrais fichiers : seul le projet courant du main est simulé, posé comme le fait
 * `project-manager.ts`, avant l'initialisation des services.
 */
import { createElement, type FC } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, act } from '@testing-library/react';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { undoDepth } from '@codemirror/commands';
import { EditorSelection, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { DEFAULT_BOOK_SETTINGS } from '@backend/types/book';

import { useProjectStore } from '../projectStore';
import { useEditorStore } from '../editorStore';
import { useDialogStore } from '../dialogStore';
import { CodeMirrorEditor } from '../../components/Editor/CodeMirrorEditor';
import { useAutoSave } from '../../hooks/useAutoSave';

vi.mock('electron', () => ({ app: { getAppPath: () => '/nonexistent-app-path' } }));

const mainCurrent = { path: null as string | null };
vi.mock('../../../../main/services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => mainCurrent.path },
}));

const { authorizeDocumentPath } = await import(
  '../../../../main/ipc/utils/document-path-authorization'
);

const A_TEXT = '# A\n\nTexte de A.\n';
const B_TEXT = '# B\n\nHuit mille mots de B.\n';

let root: string;
let dirA: string;
let dirB: string;
let documentA: string;
let documentB: string;
/** Chaque écriture refusée par le main : celles que l'auteur ne verrait jamais. */
let refused: string[];
/** Après le passage du main sur le projet, avant la réponse : l'initialisation des services. */
let whileMainInitializes: () => Promise<void> | void;
let mainFailsAfterSwitch: boolean;
/** Le main refuse sans avoir basculé, pour une autre raison qu'un project.json illisible. */
let mainRefusesBeforeSwitch: boolean;
let adjudications: Array<{ decision: string }>;
let beforeWrite: () => void;
let recentPaths: string[];

const store = () => useEditorStore.getState();
const project = () => useProjectStore.getState();
const dialogs = () => useDialogStore.getState();
const read = (file: string) => readFileSync(file, 'utf8');

async function installMain(): Promise<void> {
  (window as unknown as { electron: unknown }).electron = {
    project: {
      create: vi.fn(async ({ name, type, path: parent }: { name: string; type: string; path: string }) => {
        const dir = path.join(parent, name);
        if (existsSync(path.join(dir, 'project.json'))) {
          return { success: false, error: 'project_exists' };
        }
        await mkdir(dir, { recursive: true });
        const manifest: Record<string, unknown> = {
          id: name,
          name,
          type,
          createdAt: new Date().toISOString(),
        };
        if (type === 'book') {
          await mkdir(path.join(dir, 'chapters'));
          await writeFile(path.join(dir, 'chapters', '01-introduction.md'), '# Introduction\n\n');
          manifest.chapters = [
            { id: 'c1', title: 'Introduction', filePath: 'chapters/01-introduction.md', order: 0, kind: 'chapter' },
          ];
          manifest.book = { ...DEFAULT_BOOK_SETTINGS, numberChapters: true };
        } else {
          await writeFile(path.join(dir, 'document.md'), `# ${name}`);
        }
        if (type === 'presentation') await writeFile(path.join(dir, 'slides.md'), `# Diapos de ${name}\n`);
        await writeFile(path.join(dir, 'project.json'), JSON.stringify(manifest));
        recentPaths.unshift(path.join(dir, 'project.json'));
        mainCurrent.path = dir;
        await whileMainInitializes();
        if (mainFailsAfterSwitch) return { success: false, error: 'services' };
        return { success: true, project: { ...manifest, path: dir } };
      }),
      load: vi.fn(async (projectJson: string) => {
        let manifest: Record<string, unknown>;
        try {
          manifest = JSON.parse(await readFile(projectJson, 'utf8'));
        } catch (error) {
          return { success: false, error: String(error) };
        }
        if (mainRefusesBeforeSwitch) return { success: false, error: 'refus du main' };
        const dir = path.dirname(projectJson);
        mainCurrent.path = dir;
        await whileMainInitializes();
        if (mainFailsAfterSwitch) return { success: false, error: 'services' };
        return { success: true, project: { ...manifest, path: dir } };
      }),
      getChapters: vi.fn(async (dir: string) => {
        const manifest = JSON.parse(await readFile(path.join(dir, 'project.json'), 'utf8'));
        return { success: true, chapters: manifest.chapters ?? [], unattached: manifest.unattached ?? [] };
      }),
      getRecent: vi.fn(async () => recentPaths),
      getMetadata: vi.fn(async (projectJson: string) => {
        try {
          return {
            success: true,
            project: { ...JSON.parse(await readFile(projectJson, 'utf8')), path: path.dirname(projectJson) },
          };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      }),
    },
    editor: {
      loadFile: async (filePath: string) => {
        try {
          const authorized = await authorizeDocumentPath(filePath, 'read');
          return { success: true, content: await readFile(authorized, 'utf8') };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
      saveFile: async (filePath: string, content: string) => {
        beforeWrite();
        try {
          await writeFile(await authorizeDocumentPath(filePath, 'write'), content);
          return { success: true };
        } catch (error) {
          refused.push(filePath);
          return { success: false, error: String(error) };
        }
      },
      onInsertText: () => () => undefined,
    },
    fs: {
      writeFile: async (filePath: string, content: string) => {
        await writeFile(await authorizeDocumentPath(filePath, 'write'), content);
      },
    },
    proposals: {
      recordAdjudication: (event: { decision: string }) => {
        adjudications.push(event);
      },
    },
    ipcRenderer: { on: () => undefined, removeListener: () => undefined },
  };
}

const Workbench: FC = () => {
  useAutoSave();
  return createElement(CodeMirrorEditor);
};

async function mountWorkbench(): Promise<void> {
  await act(async () => {
    render(createElement(Workbench));
  });
}

function currentView(): EditorView {
  const dom = document.querySelector<HTMLElement>('.cm-editor');
  const view = dom && EditorView.findFromDOM(dom);
  if (!view) throw new Error('Pas de vue CM6 montée');
  return view;
}

/** Une frappe pour CM6, à la fin du texte. */
const typeAtEnd = (text: string) =>
  act(async () => {
    const view = currentView();
    const end = view.state.doc.length;
    view.dispatch({
      changes: { from: end, insert: text },
      selection: EditorSelection.cursor(end + text.length),
      annotations: Transaction.userEvent.of('input.type'),
    });
  });

/**
 * Pour les tests dont `beforeWrite` vise l'écriture du sortant : l'autosave à 30 ms peut
 * partir avant le détachement sur une machine lente, consommer le crochet, et le test
 * éprouve alors un autre ordre que celui qu'il annonce.
 */
const onlyTheDoorWrites = () =>
  useEditorStore.setState((s) => ({ settings: { ...s.settings, autoSave: false } }));

const settle = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

const eventually = (assertion: () => void) => vi.waitFor(assertion, { timeout: 3000, interval: 20 });

/** Une attente qu'on libère à la main : le temps de taper pendant le chargement. */
function hold(): { wait: () => Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait: () => held, release };
}

async function writeProject(dir: string, manifest: Record<string, unknown>): Promise<string> {
  await mkdir(dir, { recursive: true });
  const projectJson = path.join(dir, 'project.json');
  await writeFile(projectJson, JSON.stringify({ createdAt: new Date().toISOString(), ...manifest }));
  return projectJson;
}

/** Le projet A, ouvert par le vrai chemin d'ouverture, éditeur monté. */
async function openProjectA(): Promise<void> {
  await mountWorkbench();
  await act(async () => {
    await project().loadProject(path.join(dirA, 'project.json'));
  });
  expect(store().filePath).toBe(documentA);
}

beforeEach(async () => {
  // Minuteurs réels ici : CM6 mesure à chaque trame, ce que jsdom ne sait pas faire.
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  root = await mkdtemp(path.join(os.tmpdir(), 'cliodeck-projet-'));
  dirA = path.join(root, 'A');
  dirB = path.join(root, 'B');
  documentA = path.join(dirA, 'document.md');
  documentB = path.join(dirB, 'document.md');
  await writeProject(dirA, { id: 'a', name: 'A', type: 'article' });
  await writeProject(dirB, { id: 'b', name: 'B', type: 'article' });
  await writeFile(documentA, A_TEXT);
  await writeFile(documentB, B_TEXT);
  refused = [];
  whileMainInitializes = () => undefined;
  mainFailsAfterSwitch = false;
  mainRefusesBeforeSwitch = false;
  adjudications = [];
  beforeWrite = () => undefined;
  recentPaths = [];
  mainCurrent.path = null;
  await installMain();
  useEditorStore.setState((s) => ({
    filePath: null,
    content: '',
    isDirty: false,
    editorFacade: null,
    switchLock: null,
    bufferDetached: false,
    documentVersion: s.documentVersion + 1,
    settings: { ...s.settings, autoSave: true, autoSaveDelay: 30 },
  }));
  useProjectStore.setState({
    currentProject: null,
    chapters: [],
    unattachedFiles: [],
    currentChapterId: null,
    bookSettings: { ...DEFAULT_BOOK_SETTINGS },
    loadState: { kind: 'idle' },
  });
});

afterEach(async () => {
  cleanup();
  while (dialogs().confirmOpen) dialogs().resolveConfirm(false);
  while (dialogs().alertOpen) dialogs().closeAlert();
  await rm(root, { recursive: true, force: true });
});

describe('createProject ouvre le document du projet créé', () => {
  it('projet A ouvert : l’éditeur passe sur B, et la frappe suivante s’écrit dans B', async () => {
    await openProjectA();

    await act(async () => {
      await project().createProject('Neuf', 'article', root);
    });

    const created = path.join(root, 'Neuf', 'document.md');
    expect(store().filePath).toBe(created);
    expect(store().content).toBe('# Neuf');
    expect(currentView().state.doc.toString()).toBe('# Neuf');
    expect(project().loadState.kind).toBe('ready');

    await typeAtEnd('\n\nUne session entière.');
    await eventually(() => expect(read(created)).toBe('# Neuf\n\nUne session entière.'));
    expect(refused).toEqual([]);
    expect(read(documentA)).toBe(A_TEXT);
  });

  it('aucun projet ouvert, le cas de chaque démarrage : la frappe s’écrit dans le projet créé', async () => {
    await mountWorkbench();

    await act(async () => {
      await project().createProject('These', 'article', root);
    });

    const created = path.join(root, 'These', 'document.md');
    expect(store().filePath).toBe(created);

    await typeAtEnd('\n\nPremière page.');
    await eventually(() => expect(read(created)).toBe('# These\n\nPremière page.'));
    await typeAtEnd(' Deuxième page.');
    await eventually(() => expect(read(created)).toBe('# These\n\nPremière page. Deuxième page.'));
    expect(refused).toEqual([]);
  });

  it('présentation : c’est slides.md qui s’ouvre', async () => {
    await mountWorkbench();

    await act(async () => {
      await project().createProject('Cours', 'presentation', root);
    });

    expect(store().filePath).toBe(path.join(root, 'Cours', 'slides.md'));
    expect(store().content).toBe('# Diapos de Cours\n');
  });

  it('livre : le manifeste du main est lu, et le premier chapitre ouvert', async () => {
    await mountWorkbench();

    await act(async () => {
      await project().createProject('Ouvrage', 'book', root);
    });

    expect(project().chapters.map((c) => c.id)).toEqual(['c1']);
    expect(project().currentChapterId).toBe('c1');
    expect(project().bookSettings.numberChapters).toBe(true);
    expect(store().filePath).toBe(path.join(root, 'Ouvrage', 'chapters', '01-introduction.md'));
    expect(store().content).toBe('# Introduction\n\n');
  });

  it('le projet créé rejoint aussitôt les récents', async () => {
    await mountWorkbench();

    await act(async () => {
      await project().createProject('Neuf', 'article', root);
    });

    expect(project().recentProjects.map((p) => p.path)).toEqual([path.join(root, 'Neuf')]);
  });

  it('frappe pendant project.create : rien de refusé, le projet créé s’ouvre, A reste intact', async () => {
    await openProjectA();
    const gate = hold();
    whileMainInitializes = gate.wait;

    const creating = project().createProject('Neuf', 'article', root);
    await eventually(() => expect(mainCurrent.path).toBe(path.join(root, 'Neuf')));
    await typeAtEnd('frappe sans destination');
    await settle(100);
    expect(refused).toEqual([]);

    await act(async () => {
      gate.release();
      await creating;
    });

    const created = path.join(root, 'Neuf', 'document.md');
    expect(refused).toEqual([]);
    expect(store().filePath).toBe(created);
    expect(store().bufferDetached).toBe(false);
    expect(currentView().state.readOnly).toBe(false);
    expect(read(created)).toBe('# Neuf');
    expect(read(documentA)).toBe(A_TEXT);
  });

  it('création refusée par le main : A revient, texte et chemin', async () => {
    await openProjectA();
    await typeAtEnd('Dernière phrase.');
    await writeProject(path.join(root, 'Pris'), { id: 'pris', name: 'Pris', type: 'article' });

    await act(async () => {
      await expect(project().createProject('Pris', 'article', root)).rejects.toThrow('project_exists');
    });

    expect(store().filePath).toBe(documentA);
    expect(store().bufferDetached).toBe(false);
    expect(store().content).toBe(`${A_TEXT}Dernière phrase.`);
    expect(currentView().state.readOnly).toBe(false);
    expect(project().loadState.kind).toBe('failed');
    expect(project().currentProject?.path).toBe(dirA);
    expect(read(documentA)).toBe(`${A_TEXT}Dernière phrase.`);
  });

  it('l’auteur garde son tampon sans titre : rien n’est créé, et l’appelant le sait', async () => {
    await mountWorkbench();
    await typeAtEnd('Une idée sans titre.');

    let created: boolean | undefined;
    const creating = project()
      .createProject('Neuf', 'article', root)
      .then((value) => {
        created = value;
      });
    await eventually(() => expect(dialogs().confirmOpen).toBe(true));
    await act(async () => {
      dialogs().resolveConfirm(false);
      await creating;
    });

    expect(created).toBe(false);
    expect(window.electron.project.create).not.toHaveBeenCalled();
    expect(project().loadState).toEqual({ kind: 'idle' });
    expect(currentView().state.doc.toString()).toBe('Une idée sans titre.');
    expect(existsSync(path.join(root, 'Neuf'))).toBe(false);
  });

  it('accord sur le tampon sans titre, puis création refusée : le texte revient, et la question reste due', async () => {
    await mountWorkbench();
    await typeAtEnd('Une idée sans titre.');
    await writeProject(path.join(root, 'Pris'), { id: 'pris', name: 'Pris', type: 'article' });

    const refused = project().createProject('Pris', 'article', root);
    await eventually(() => expect(dialogs().confirmOpen).toBe(true));
    await act(async () => {
      dialogs().resolveConfirm(true);
      await expect(refused).rejects.toThrow('project_exists');
    });

    // L'alerte affirme « Rien n'a été modifié » : le tampon est tel que l'auteur l'a laissé.
    expect(currentView().state.doc.toString()).toBe('Une idée sans titre.');
    expect(currentView().state.readOnly).toBe(false);
    expect(store().filePath).toBeNull();
    expect(store().content).toBe('Une idée sans titre.');
    expect(store().isDirty).toBe(true);
    expect(store().bufferDetached).toBe(false);

    // Cet accord ne valait que pour ce changement-là.
    const created = project().createProject('Libre', 'article', root);
    await eventually(() => expect(dialogs().confirmOpen).toBe(true));
    await act(async () => {
      dialogs().resolveConfirm(true);
      await created;
    });
    expect(store().filePath).toBe(path.join(root, 'Libre', 'document.md'));
    expect(currentView().state.doc.toString()).toBe('# Libre');
  });

  it('écriture du sortant impossible : rejet, et l’éditeur reste sur son document', async () => {
    await openProjectA();
    await typeAtEnd('Une phrase.');
    await writeFile(documentA, A_TEXT);
    mainCurrent.path = dirB;

    await act(async () => {
      await expect(project().createProject('Neuf', 'article', root)).rejects.toThrow();
    });

    expect(window.electron.project.create).not.toHaveBeenCalled();
    expect(store().filePath).toBe(documentA);
    expect(store().bufferDetached).toBe(false);
    expect(currentView().state.doc.toString()).toBe(`${A_TEXT}Une phrase.`);
    expect(currentView().state.readOnly).toBe(false);
  });
});

describe('loadProject : l’éditeur est coupé avant que le main ne passe', () => {
  const projectJsonB = () => path.join(dirB, 'project.json');

  it('frappe pendant project.load : le document de B n’est pas réécrit', async () => {
    await openProjectA();
    const gate = hold();
    whileMainInitializes = gate.wait;

    const loading = project().loadProject(projectJsonB());
    await eventually(() => expect(mainCurrent.path).toBe(dirB));
    await typeAtEnd('x');
    await settle(100);

    await act(async () => {
      gate.release();
      await loading;
    });

    expect(read(documentB)).toBe(B_TEXT);
    expect(read(documentA)).toBe(A_TEXT);
    expect(refused).toEqual([]);
    expect(store().filePath).toBe(documentB);
    expect(store().content).toBe(B_TEXT);
  });

  it('la frappe d’avant le clic part dans A, écrite avant le passage du main', async () => {
    await openProjectA();
    await typeAtEnd('Dernier mot.');

    await act(async () => {
      await project().loadProject(projectJsonB());
    });

    expect(read(documentA)).toBe(`${A_TEXT}Dernier mot.`);
    expect(read(documentB)).toBe(B_TEXT);
    expect(refused).toEqual([]);
  });

  it('project.json illisible : l’éditeur ne bouge pas, et le main n’est pas sollicité', async () => {
    await openProjectA();
    await typeAtEnd('Dernier mot.');
    const view = currentView();
    const versionBefore = store().documentVersion;
    const proposal = (
      window as unknown as {
        __cliodeckProposals: { inject: (p: Record<string, unknown>) => { id: string } };
      }
    ).__cliodeckProposals.inject({
      range: { from: 0, to: 0 },
      original: '',
      proposed: 'Proposition.',
      category: 'ai-insert',
      source: { model: 'm', task: 't' },
    });
    expect(proposal.id).toBeTruthy();
    await writeFile(projectJsonB(), '{ pas du JSON');
    const load = window.electron.project.load as unknown as ReturnType<typeof vi.fn>;
    load.mockClear();

    await act(async () => {
      await expect(project().loadProject(projectJsonB())).rejects.toThrow();
    });

    expect(load).not.toHaveBeenCalled();
    // Rien n'a été remplacé : la vue, et avec elle l'annulation et la proposition en attente.
    expect(currentView()).toBe(view);
    expect(store().documentVersion).toBe(versionBefore);
    expect(undoDepth(view.state)).toBeGreaterThan(0);
    expect(adjudications.filter((e) => e.decision === 'expired')).toEqual([]);
    expect(store().filePath).toBe(documentA);
    expect(project().currentProject?.path).toBe(dirA);
    expect(project().loadState.kind).toBe('failed');

    await typeAtEnd(' Encore.');
    await eventually(() => expect(read(documentA)).toBe(`${A_TEXT}Dernier mot. Encore.`));
  });

  it('project.load échoue sans que le main ait bougé : le document de A revient, texte, chemin et annulation', async () => {
    await openProjectA();
    await typeAtEnd('Dernier mot.');
    mainRefusesBeforeSwitch = true;

    await act(async () => {
      await expect(project().loadProject(projectJsonB())).rejects.toThrow('refus du main');
    });

    expect(store().filePath).toBe(documentA);
    expect(store().content).toBe(`${A_TEXT}Dernier mot.`);
    expect(store().bufferDetached).toBe(false);
    expect(currentView().state.readOnly).toBe(false);
    expect(undoDepth(currentView().state)).toBeGreaterThan(0);
    expect(project().loadState.kind).toBe('failed');
    expect(project().currentProject?.path).toBe(dirA);

    await typeAtEnd(' Encore.');
    await eventually(() => expect(read(documentA)).toBe(`${A_TEXT}Dernier mot. Encore.`));
  });

  it('project.load échoue après le passage du main : tampon vide, rien de figé, le sortant déjà écrit', async () => {
    await openProjectA();
    await typeAtEnd('Dernier mot.');
    mainFailsAfterSwitch = true;

    await act(async () => {
      await expect(project().loadProject(projectJsonB())).rejects.toThrow('services');
    });

    expect(store().filePath).toBeNull();
    expect(store().bufferDetached).toBe(false);
    expect(currentView().state.readOnly).toBe(false);
    expect(read(documentA)).toBe(`${A_TEXT}Dernier mot.`);
    expect(read(documentB)).toBe(B_TEXT);
  });

  describe('livre ouvert, le changement échoue', () => {
    const chapters = [
      { id: 'c1', title: 'Un', filePath: 'chapters/01.md', order: 0, kind: 'chapter' },
    ];

    async function openBookA(): Promise<void> {
      await writeProject(dirA, { id: 'a', name: 'A', type: 'book', chapters });
      await mkdir(path.join(dirA, 'chapters'));
      await writeFile(path.join(dirA, 'chapters', '01.md'), '# Un\n');
      await mountWorkbench();
      await act(async () => {
        await project().loadProject(path.join(dirA, 'project.json'));
      });
      expect(project().currentChapterId).toBe('c1');
    }

    // Renommer un « chapitre courant » réécrirait son titre dans le tampon sans titre.
    it('ouverture, après le passage du main : aucun chapitre annoncé sur le tampon', async () => {
      await openBookA();
      mainFailsAfterSwitch = true;

      await act(async () => {
        await expect(project().loadProject(projectJsonB())).rejects.toThrow('services');
      });

      expect(store().filePath).toBeNull();
      expect(project().currentChapterId).toBeNull();
    });

    it('création, après le passage du main : aucun chapitre annoncé sur le tampon', async () => {
      await openBookA();
      mainFailsAfterSwitch = true;

      await act(async () => {
        await expect(project().createProject('C', 'article', root)).rejects.toThrow('services');
      });

      expect(store().filePath).toBeNull();
      expect(project().currentChapterId).toBeNull();
    });

    it('le chapitre revient : il reste le chapitre courant', async () => {
      await openBookA();
      mainRefusesBeforeSwitch = true;

      await act(async () => {
        await expect(project().loadProject(projectJsonB())).rejects.toThrow('refus du main');
      });

      expect(store().filePath).toBe(path.join(dirA, 'chapters', '01.md'));
      expect(project().currentChapterId).toBe('c1');
    });
  });

  it('livre au manifeste vide : plus rien de A, et l’éditeur reste éditable', async () => {
    await writeProject(dirB, { id: 'b', name: 'B', type: 'book', chapters: [] });
    await openProjectA();
    await typeAtEnd('Dernier mot.');

    await act(async () => {
      await project().loadProject(projectJsonB());
    });

    expect(store().filePath).toBeNull();
    expect(store().content).toBe('');
    expect(store().bufferDetached).toBe(false);
    expect(currentView().state.doc.toString()).toBe('');
    expect(currentView().state.readOnly).toBe(false);
    expect(project().loadState.kind).toBe('ready');
    expect(read(documentA)).toBe(`${A_TEXT}Dernier mot.`);
  });

  it('du livre vers un article : les chapitres du livre ne survivent pas à la bascule', async () => {
    const chapters = [{ id: 'c9', title: 'Neuf', filePath: 'chapters/09.md', order: 0, kind: 'chapter' }];
    const book = { ...DEFAULT_BOOK_SETTINGS, numberChapters: !DEFAULT_BOOK_SETTINGS.numberChapters };
    const unattached = [{ filePath: 'chapters/brouillon.md' }];
    await writeProject(dirA, { id: 'a', name: 'A', type: 'book', chapters, book, unattached });
    await mkdir(path.join(dirA, 'chapters'));
    await writeFile(path.join(dirA, 'chapters', '09.md'), '# Neuf\n');
    await mountWorkbench();
    await act(async () => {
      await project().loadProject(path.join(dirA, 'project.json'));
    });
    expect(project().currentChapterId).toBe('c9');
    expect(project().bookSettings).toEqual(book);
    expect(project().unattachedFiles).toEqual(unattached);

    await act(async () => {
      await project().loadProject(projectJsonB());
    });

    expect(project().chapters).toEqual([]);
    expect(project().currentChapterId).toBeNull();
    expect(project().bookSettings).toEqual(DEFAULT_BOOK_SETTINGS);
    expect(project().unattachedFiles).toEqual([]);
  });

  it('document illisible : tampon vide plutôt qu’un éditeur figé', async () => {
    await rm(documentB);
    await mkdir(documentB);
    await openProjectA();

    await act(async () => {
      await project().loadProject(projectJsonB());
    });

    expect(store().filePath).toBeNull();
    expect(store().bufferDetached).toBe(false);
    expect(currentView().state.readOnly).toBe(false);
    expect(project().loadState.kind).toBe('ready');
  });

  it('livre au premier chapitre illisible : aucun chapitre annoncé sur le tampon vide', async () => {
    const chapters = [{ id: 'c1', title: 'Un', filePath: 'chapters/01.md', order: 0, kind: 'chapter' }];
    await writeProject(dirB, { id: 'b', name: 'B', type: 'book', chapters });
    await mkdir(path.join(dirB, 'chapters', '01.md'), { recursive: true });
    await openProjectA();

    await act(async () => {
      await project().loadProject(projectJsonB());
    });

    expect(store().filePath).toBeNull();
    expect(project().chapters.map((c) => c.id)).toEqual(['c1']);
    // Renommer un « chapitre courant » réécrirait son titre dans le tampon sans titre.
    expect(project().currentChapterId).toBeNull();
    expect(project().loadState.kind).toBe('ready');
  });

  describe('l’auteur a accepté d’abandonner son tampon sans titre', () => {
    const IDEA = 'Une idée sans titre.';

    async function typeIdeaAndAccept(switchProject: () => Promise<void>): Promise<void> {
      await mountWorkbench();
      await typeAtEnd(IDEA);
      const switching = switchProject();
      await eventually(() => expect(dialogs().confirmOpen).toBe(true));
      await act(async () => {
        dialogs().resolveConfirm(true);
        await switching;
      });
    }

    const expectIdeaBack = () => {
      expect(currentView().state.doc.toString()).toBe(IDEA);
      expect(currentView().state.readOnly).toBe(false);
      expect(store().filePath).toBeNull();
      expect(store().content).toBe(IDEA);
      expect(store().isDirty).toBe(true);
      expect(store().bufferDetached).toBe(false);
    };

    it('le main refuse sans avoir basculé : le texte revient', async () => {
      mainRefusesBeforeSwitch = true;

      await typeIdeaAndAccept(() =>
        expect(project().loadProject(projectJsonB())).rejects.toThrow('refus du main')
      );

      expectIdeaBack();
      expect(project().currentProject).toBeNull();
      expect(project().loadState.kind).toBe('failed');
    });

    it('project.json illisible : aucune question pour une ouverture vouée à l’échec, le texte reste', async () => {
      await mountWorkbench();
      await typeAtEnd(IDEA);
      const view = currentView();
      await writeFile(projectJsonB(), '{ pas du JSON');

      await act(async () => {
        await expect(project().loadProject(projectJsonB())).rejects.toThrow();
      });

      expect(dialogs().confirmOpen).toBe(false);
      expect(currentView()).toBe(view);
      expect(undoDepth(view.state)).toBeGreaterThan(0);
      expect(project().loadState.kind).toBe('failed');
      // Le miroir du store suit la vue, qui n'a pas bougé, avec son délai habituel.
      await eventually(expectIdeaBack);
    });

    it('échec après le passage du main : le texte revient quand même', async () => {
      mainFailsAfterSwitch = true;

      await typeIdeaAndAccept(() => expect(project().loadProject(projectJsonB())).rejects.toThrow('services'));

      expectIdeaBack();
    });

    it('le projet s’ouvre mais n’a rien à montrer : rien n’a remplacé le texte, il reste', async () => {
      await writeProject(dirB, { id: 'b', name: 'B', type: 'book', chapters: [] });

      await typeIdeaAndAccept(() => project().loadProject(projectJsonB()));

      expectIdeaBack();
      expect(project().currentProject?.path).toBe(dirB);
      expect(project().loadState.kind).toBe('ready');
    });

    it('le document du projet s’ouvre : le texte est abandonné, comme accepté', async () => {
      await typeIdeaAndAccept(() => project().loadProject(projectJsonB()));

      expect(store().filePath).toBe(documentB);
      expect(currentView().state.doc.toString()).toBe(B_TEXT);
      expect(store().isDirty).toBe(false);
      expect(read(documentB)).toBe(B_TEXT);
    });
  });

  describe('un seul changement de projet à la fois', () => {
    // Le main n'en supporte pas deux : services initialisés en parallèle, et le perdant
    // voit sa lecture refusée. Son repli vidait l'éditeur du gagnant.
    const second: Array<[string, () => string]> = [
      ['le même projet', projectJsonB],
      ['un autre projet', () => path.join(dirA, 'project.json')],
    ];

    it.each(second)('une ouverture de %s pendant la première est refusée, et la première aboutit', async (_label, other) => {
      await openProjectA();
      const gate = hold();
      whileMainInitializes = gate.wait;
      const first = project().loadProject(projectJsonB());
      await eventually(() => expect(mainCurrent.path).toBe(dirB));

      await act(async () => {
        await project().loadProject(other());
      });
      expect(window.electron.project.load).toHaveBeenCalledTimes(2);
      expect(project().loadState).toEqual({ kind: 'loading', path: projectJsonB() });

      await act(async () => {
        gate.release();
        await first;
      });

      expect(store().filePath).toBe(documentB);
      expect(store().bufferDetached).toBe(false);
      expect(project().currentProject?.path).toBe(dirB);
      expect(project().loadState.kind).toBe('ready');
      await typeAtEnd('Une session entière.');
      await eventually(() => expect(read(documentB)).toBe(`${B_TEXT}Une session entière.`));
    });

    it('une création pendant une ouverture est refusée : rien de créé, et l’appelant le sait', async () => {
      await openProjectA();
      const gate = hold();
      whileMainInitializes = gate.wait;
      const first = project().loadProject(projectJsonB());
      await eventually(() => expect(mainCurrent.path).toBe(dirB));

      let created: boolean | undefined;
      await act(async () => {
        created = await project().createProject('Neuf', 'article', root);
      });

      expect(created).toBe(false);
      expect(window.electron.project.create).not.toHaveBeenCalled();
      expect(existsSync(path.join(root, 'Neuf'))).toBe(false);

      await act(async () => {
        gate.release();
        await first;
      });
      expect(store().filePath).toBe(documentB);
    });

    it('une ouverture pendant une création est refusée', async () => {
      await openProjectA();
      const gate = hold();
      whileMainInitializes = gate.wait;
      const creating = project().createProject('Neuf', 'article', root);
      await eventually(() => expect(mainCurrent.path).toBe(path.join(root, 'Neuf')));

      await act(async () => {
        await project().loadProject(projectJsonB());
      });
      expect(window.electron.project.load).toHaveBeenCalledTimes(1);

      await act(async () => {
        gate.release();
        await creating;
      });
      expect(store().filePath).toBe(path.join(root, 'Neuf', 'document.md'));
    });

    it('une fois la première finie, la suivante repart', async () => {
      await openProjectA();
      await act(async () => {
        await project().loadProject(projectJsonB());
      });
      await act(async () => {
        await project().loadProject(path.join(dirA, 'project.json'));
      });
      expect(store().filePath).toBe(documentA);
    });
  });

  it('verrou posé pendant la lecture du document entrant : l’éditeur ne reste pas figé', async () => {
    // La lecture revient `superseded`, et personne d'autre ne sortira du détachement.
    await openProjectA();
    const readFromMain = window.electron.editor.loadFile;
    window.electron.editor.loadFile = async (filePath: string) => {
      store().setSwitchLock('book.renumberInProgress');
      return readFromMain(filePath);
    };

    await act(async () => {
      await project().loadProject(projectJsonB());
    });

    expect(store().bufferDetached).toBe(false);
    expect(currentView().state.readOnly).toBe(false);
  });

  it('l’auteur garde son tampon sans titre : le main n’est pas sollicité, et l’état d’avant revient', async () => {
    await openProjectA();
    await act(async () => {
      await store().replaceBuffer({ kind: 'untitled' }, 'new-document');
    });
    await typeAtEnd('Une idée sans titre.');
    const before = project().loadState;

    const loading = project().loadProject(projectJsonB());
    await eventually(() => expect(dialogs().confirmOpen).toBe(true));
    await act(async () => {
      dialogs().resolveConfirm(false);
      await loading;
    });

    expect(window.electron.project.load).toHaveBeenCalledTimes(1);
    expect(project().loadState).toBe(before);
    expect(project().currentProject?.path).toBe(dirA);
    expect(currentView().state.doc.toString()).toBe('Une idée sans titre.');
    expect(store().bufferDetached).toBe(false);
  });

  it('verrou posé pendant l’écriture du sortant : dit à l’auteur, et le projet ne change pas', async () => {
    await openProjectA();
    onlyTheDoorWrites();
    await typeAtEnd('Dernier mot.');
    beforeWrite = () => store().setSwitchLock('book.renumberInProgress');
    const before = project().loadState;

    const loading = project().loadProject(projectJsonB());
    await eventually(() => expect(dialogs().alertOpen).toBe(true));
    await act(async () => {
      dialogs().closeAlert();
      await loading;
    });

    expect(window.electron.project.load).toHaveBeenCalledTimes(1);
    expect(project().loadState).toBe(before);
    expect(project().currentProject?.path).toBe(dirA);
    expect(store().filePath).toBe(documentA);
  });

  it('une autre demande pendant l’écriture du sortant : elle a pris le pas, le projet ne change pas', async () => {
    const other = path.join(dirA, 'context.md');
    await writeFile(other, 'Contexte.\n');
    await openProjectA();
    onlyTheDoorWrites();
    await typeAtEnd('Dernier mot.');
    beforeWrite = () => {
      beforeWrite = () => undefined;
      void store().loadFile(other);
    };
    const before = project().loadState;

    await act(async () => {
      await project().loadProject(projectJsonB());
      await settle(50);
    });

    expect(window.electron.project.load).toHaveBeenCalledTimes(1);
    expect(project().loadState).toBe(before);
    expect(project().currentProject?.path).toBe(dirA);
    expect(store().filePath).toBe(other);
    expect(store().bufferDetached).toBe(false);
  });
});
