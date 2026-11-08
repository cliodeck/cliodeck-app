// @vitest-environment jsdom
/**
 * Le refus d'un fichier qui n'est pas un projet, tel que l'auteur le lit.
 *
 * « Ce projet n'a pas pu être ouvert. Son fichier project.json est peut-être illisible ou
 * endommagé » ne convient pas à un CSL-JSON choisi par erreur : le message nomme le fichier choisi,
 * dit qu'il n'a pas été modifié, et dit quoi choisir. Jamais un code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

import { ProjectPanel } from '../ProjectPanel';
import { useEditorStore } from '../../../stores/editorStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useDialogStore } from '../../../stores/dialogStore';

// Le mock commun rend la clé seule : ici, ce qui part avec elle compte.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | Record<string, unknown>) =>
      typeof options === 'object' ? `${key} ${JSON.stringify(options)}` : key,
    i18n: { language: 'fr', changeLanguage: async () => undefined },
  }),
  Trans: ({ children }: { children?: unknown }) => children ?? null,
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));
vi.mock('../../Config/ActionsSection', () => ({ ActionsSection: () => null }));
vi.mock('../ZoteroProjectSettings', () => ({ ZoteroProjectSettings: () => null }));
vi.mock('../CSLSettings', () => ({ CSLSettings: () => null }));
vi.mock('../RevealJsConfig', () => ({ RevealJsConfig: () => null }));
vi.mock('../OnboardingWizard', () => ({ OnboardingWizard: () => null }));

const A = '/p/projet-a';
const B = '/p/projet-b';
const OPEN_DOCUMENT = `${A}/document.md`;

let load: ReturnType<typeof vi.fn>;
let getMetadata: ReturnType<typeof vi.fn>;

const dialogs = () => useDialogStore.getState();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Les deux portes d'ouverture : le bouton et la liste des projets récents. */
const OPEN_DOORS: Array<[string, () => Promise<void>]> = [
  [
    'le bouton Ouvrir un projet',
    async () => {
      await act(async () => {
        fireEvent.click(screen.getByTitle('project.openProject'));
        await flush();
      });
    },
  ],
  [
    'la liste des projets récents',
    async () => {
      await act(async () => {
        fireEvent.click(screen.getByText('project.recentProjects'));
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Projet B'));
        await flush();
      });
    },
  ],
];

async function renderPanel(): Promise<void> {
  await act(async () => {
    render(<ProjectPanel />);
    await flush();
  });
}

beforeEach(() => {
  load = vi.fn(async () => ({ success: false, error: 'le projet ne doit pas être demandé au main' }));
  getMetadata = vi.fn(async () => ({
    success: true,
    project: { id: 'b', name: 'Projet B', type: 'article', path: B, createdAt: new Date().toISOString() },
  }));
  (window as unknown as { electron: unknown }).electron = {
    project: { load, getMetadata, getRecent: vi.fn(async () => [`${B}/project.json`]) },
    editor: {
      saveFile: vi.fn(async () => ({ success: true })),
      loadFile: vi.fn(async () => ({ success: true, content: 'Une phrase pas encore écrite.' })),
    },
    dialog: { openFile: vi.fn(async () => ({ canceled: false, filePaths: [`${B}/references.json`] })) },
  };
  useProjectStore.setState({
    currentProject: {
      id: 'a',
      name: 'Projet A',
      path: A,
      type: 'article',
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
    loadState: { kind: 'idle' },
  });
  useEditorStore.setState({
    filePath: OPEN_DOCUMENT,
    content: 'Une phrase pas encore écrite.',
    isDirty: true,
    editorFacade: null,
    switchLock: null,
    bufferDetached: false,
  } as never);
});

afterEach(() => {
  cleanup();
  useEditorStore.setState({ filePath: null, content: '', isDirty: false, switchLock: null, bufferDetached: false } as never);
  useProjectStore.setState({ currentProject: null, recentProjects: [], loadState: { kind: 'idle' } });
  while (dialogs().alertOpen) dialogs().closeAlert();
});

describe('ProjectPanel : ce fichier n’est pas un projet', () => {
  describe.each<[string, string, string]>([
    ['not_a_project', 'not_a_project', 'references.json'],
    ['manifest_invalid', 'manifest_invalid', 'project.json'],
  ])('%s', (_label, code, fileName) => {
    it.each(OPEN_DOORS)('par %s : le fichier nommé, sans code, et A reste ouvert', async (_door, open) => {
      await renderPanel();
      getMetadata.mockResolvedValue({ success: false, code, fileName, error: `${code}: /p/projet-b/${fileName}` });

      await open();
      await vi.waitFor(() => expect(dialogs().alertOpen).toBe(true));

      expect(dialogs().alertMessage).toBe(`project.notAProject ${JSON.stringify({ file: fileName })}`);
      expect(dialogs().alertMessage).not.toContain(code);
      expect(load).not.toHaveBeenCalled();
      expect(useProjectStore.getState().currentProject?.path).toBe(A);
      expect(useProjectStore.getState().loadState.kind).not.toBe('loading');
      expect(document.querySelector('.project-loading-overlay')).toBeNull();
      expect(useEditorStore.getState().filePath).toBe(OPEN_DOCUMENT);
      expect(useEditorStore.getState().isDirty).toBe(true);
      expect(useEditorStore.getState().bufferDetached).toBe(false);
    });
  });

  it.each(OPEN_DOORS)('le main refuse seul, par %s (un project:load qui passe le contrôle) : le même message', async (_door, open) => {
    await renderPanel();
    load.mockResolvedValue({ success: false, code: 'not_a_project', fileName: 'references.json', error: 'x' });

    await open();
    await vi.waitFor(() => expect(dialogs().alertOpen).toBe(true));

    expect(dialogs().alertMessage).toBe(`project.notAProject ${JSON.stringify({ file: 'references.json' })}`);
  });

  it.each(OPEN_DOORS)('témoin, par %s : un project.json abîmé garde son message', async (_door, open) => {
    await renderPanel();
    getMetadata.mockResolvedValue({ success: false, code: 'manifest_unreadable', error: 'Unexpected end of JSON input' });

    await open();
    await vi.waitFor(() => expect(dialogs().alertOpen).toBe(true));

    expect(dialogs().alertMessage).toBe('project.openError');
  });
});

/**
 * BT1-5 : tout refus autre que « ce n'est pas un projet » affichait « project.json est peut-être
 * illisible ou endommagé ». Un service qui ne démarre pas, un disque débranché, un dossier en
 * lecture seule : l'auteur cherchait à réparer un fichier intact. Chaque code a son message.
 */
describe('ProjectPanel : les autres refus disent leur cause, jamais « project.json endommagé » à tort', () => {
  it.each(OPEN_DOORS)('un service du projet ne démarre pas, par %s : son message, sans la cause technique', async (_door, open) => {
    await renderPanel();
    load.mockResolvedValue({ success: false, code: 'services_failed', error: 'registre de fournisseurs invalide' });

    await open();
    await vi.waitFor(() => expect(dialogs().alertOpen).toBe(true));

    expect(dialogs().alertMessage).not.toBe('project.openError');
    expect(dialogs().alertMessage).toBe('project.servicesFailed');
    expect(dialogs().alertMessage).not.toContain('registre');
  });

  it.each<[string, 'getMetadata' | 'load', Record<string, unknown>, string]>([
    ['dossier introuvable ou inaccessible', 'getMetadata', { code: 'project_unavailable', error: 'ENOENT' }, 'project.openUnavailable'],
    ['project.json absent', 'getMetadata', { code: 'project_file_missing', error: 'ENOENT' }, 'project.openUnavailable'],
    ['project.json qui ne s’écrit pas', 'load', { code: 'manifest_unwritable', error: 'EACCES' }, 'project.openNotWritable'],
    ['project.json abîmé, vu par project:load', 'load', { code: 'manifest_unreadable', error: 'Unexpected token' }, 'project.openError'],
    ['un refus sans code', 'load', { error: 'canal coupé' }, 'project.openFailed'],
  ])('%s : son propre message', async (_label, door, refusal, key) => {
    await renderPanel();
    (door === 'getMetadata' ? getMetadata : load).mockResolvedValue({ success: false, ...refusal });

    await OPEN_DOORS[0][1]();
    await vi.waitFor(() => expect(dialogs().alertOpen).toBe(true));

    expect(dialogs().alertMessage).toBe(key);
  });
});

describe('les messages d’échec d’ouverture, dans les trois langues', () => {
  const OTHER_CAUSES = ['servicesFailed', 'createServicesFailed', 'openUnavailable', 'openNotWritable', 'openFailed'];
  const projectTexts = (language: string): Record<string, string> => {
    const file = path.join(process.cwd(), 'public', 'locales', language, 'common.json');
    return (JSON.parse(readFileSync(file, 'utf8')) as { project: Record<string, string> }).project;
  };

  it.each<[string, RegExp]>([
    ['fr', /endommag/],
    ['en', /damaged/],
    ['de', /beschädigt/],
  ])('%s : seul openError parle d’un fichier endommagé, et aucun ne montre un code', (language, damaged) => {
    const texts = projectTexts(language);
    expect(texts.openError).toMatch(damaged);
    for (const key of OTHER_CAUSES) {
      expect(texts[key], key).toBeTruthy();
      expect(texts[key], key).not.toMatch(damaged);
      expect(texts[key], key).not.toMatch(/services_failed|project_unavailable|project_file_missing|manifest_/);
    }
  });

  it.each(['fr', 'en', 'de'])('%s : un service en panne dit que project.json n’y est pour rien', (language) => {
    expect(projectTexts(language).servicesFailed).toContain('project.json');
  });

  // Revue de BT1-5 : huit services passent par startService, la parenthèse en nomme trois. Donnée
  // comme une liste close, elle désignait des services qui avaient démarré quand le mode ou le
  // journal d'usage échouait. La cause exacte reste dans la ligne « ❌ project:load error: ».
  it.each<[string, string]>([
    ['fr', '(par exemple '],
    ['en', '(for example '],
    ['de', '(zum Beispiel '],
  ])('%s : les services nommés sont des exemples, pas la liste de ceux qui ont échoué', (language, marker) => {
    const texts = projectTexts(language);
    expect(texts.servicesFailed).toContain(marker);
    expect(texts.createServicesFailed).toContain(marker);
  });

  // La création a eu lieu : le message le dit, nomme le projet et son dossier, et dit comment l'ouvrir.
  it.each<[string, string, string]>([
    ['fr', 'a été créé', '« Ouvrir un projet »'],
    ['en', 'was created', '“Open a project”'],
    ['de', 'wurde in {{folder}} erstellt', '„Projekt öffnen“'],
  ])('%s : un service en panne après la création dit que le projet existe', (language, created, openLabel) => {
    const text = projectTexts(language).createServicesFailed;
    expect(text).toContain('{{name}}');
    expect(text).toContain('{{folder}}');
    expect(text).toContain(created);
    expect(text).toContain(openLabel);
  });
});

describe('le message, dans les trois langues', () => {
  const message = (language: string): string => {
    const file = path.join(process.cwd(), 'public', 'locales', language, 'common.json');
    return (JSON.parse(readFileSync(file, 'utf8')) as { project: { notAProject: string } }).project.notAProject;
  };

  it.each(['fr', 'en', 'de'])('%s : le fichier choisi, et celui qu’il faut choisir', (language) => {
    expect(message(language)).toContain('{{file}}');
    expect(message(language)).toContain('project.json');
    expect(message(language)).not.toMatch(/not_a_project|manifest_invalid/);
  });

  it('fr : dit que le fichier n’a pas été modifié, et que rien de ce qui est ouvert ne se ferme', () => {
    expect(message('fr')).toContain("n'a pas été modifié");
    expect(message('fr')).toContain('reste ouvert');
  });

  // Le refus d'un `project.json` d'un autre outil se lit aussi : « choisissez project.json », seul, le contredirait.
  it.each<[string, string]>([
    ['fr', 'project.json que ClioDeck a créé'],
    ['en', 'project.json file that ClioDeck created'],
    ['de', 'project.json, die ClioDeck'],
  ])('%s : le fichier à choisir est celui que ClioDeck a créé', (language, expected) => {
    expect(message(language)).toContain(expected);
  });
});
