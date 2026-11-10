// @vitest-environment jsdom
/**
 * Passer d'un projet à l'autre sans quitter le panneau Projet (L03-4, seconde partie) : l'apparence
 * reveal.js et la section « Actions » ne montrent plus rien du projet quitté.
 *
 * S17-1-15 : B sans `reveal-config.json` gardait à l'écran le thème et la transition de A, et le
 * premier réglage touché dans B y écrivait tout l'état de A, que son export prenait ensuite.
 * S17-1-8 : les statistiques de « Actions » n'étaient lues qu'au montage. Le compte, le chemin de
 * la base et l'état des boutons de purge restaient ceux de A, ou d'avant une indexation, et la
 * confirmation de purge citait ces nombres-là.
 *
 * Vrais panneau, apparence, section « Actions » et stores ; vrais handlers `fs:*` sur de vrais
 * dossiers (`real-main`). Les statistiques du main sont simulées, par projet : elles suivent le
 * projet que le main sert, comme les vraies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { installMain, ipc, main } from '../../../services/__tests__/helpers/real-main';
import { ProjectPanel } from '../ProjectPanel';
import { useBibliographyStore } from '../../../stores/bibliographyStore';
import { useDialogStore } from '../../../stores/dialogStore';
import { useProjectStore } from '../../../stores/projectStore';
import { projectLifecycle } from '../../../lifecycle/projectLifecycle';

// Vrai disque et plusieurs allers-retours par test : la CI est plus lente que ce poste.
vi.setConfig({ testTimeout: 30_000 });

// Les paramètres d'un message restent lisibles : c'est ce que la confirmation de purge cite.
vi.mock('react-i18next', () => {
  const t = (key: string, params?: string | Record<string, unknown>) =>
    typeof params === 'string' ? params : params ? `${key} ${JSON.stringify(params)}` : key;
  return {
    useTranslation: () => ({ t, i18n: { language: 'fr', changeLanguage: async () => undefined } }),
    Trans: ({ children }: { children?: unknown }) => children ?? null,
    initReactI18next: { type: '3rdParty', init: () => undefined },
  };
});
// Visible : voisine de « Actions », elle doit rester seule, et celle du projet ouvert.
vi.mock('../ZoteroProjectSettings', () => ({
  ZoteroProjectSettings: ({ projectPath }: { projectPath: string }) => <p>{`zotero ${projectPath}`}</p>,
}));
vi.mock('../CSLSettings', () => ({ CSLSettings: () => null }));
vi.mock('../OnboardingWizard', () => ({ OnboardingWizard: () => null }));

const DEFAULTS = {
  theme: 'black',
  transition: 'slide',
  controls: true,
  progress: true,
  slideNumber: false,
  history: true,
};
const A_CONFIG = `${JSON.stringify({ theme: 'night', transition: 'fade' }, null, 2)}\n`;

interface MainStats {
  pdf: { totalDocuments: number; totalChunks: number };
  tropy: { sourceCount: number; chunkCount: number };
}

let root: string;
let dirA: string;
let dirB: string;
/** Ce que le main répond, pour chaque projet. */
let stats: Map<string, MainStats>;
/** Les lectures de statistiques reçues par le main. */
let statsReads: number;
/** La lecture de `fs:read-file`, que le test peut retenir. */
let readFile: (filePath: string) => Promise<unknown>;
/** Les lectures de `reveal-config.json`. */
let revealReads: number;

const dialogs = () => useDialogStore.getState();
const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const brainDb = (dir: string) => path.join(dir, '.cliodeck', 'brain.db');
const revealConfig = (dir: string) => path.join(dir, 'reveal-config.json');

function served(): MainStats {
  const current = main.projectPath ? stats.get(main.projectPath) : undefined;
  if (!current) throw new Error('aucun projet servi par le main');
  return current;
}

function installElectron(): void {
  installMain();
  const electron = (window as unknown as { electron: Record<string, Record<string, unknown>> }).electron;
  electron.fs = {
    ...electron.fs,
    exists: (filePath: string) => ipc('fs:exists', filePath),
    readFile: (filePath: string) => {
      if (path.basename(filePath) === 'reveal-config.json') revealReads += 1;
      return readFile(filePath);
    },
    writeFile: (filePath: string, content: string) => ipc('fs:write-file', filePath, content),
  };
  electron.pdf = {
    getStatistics: async () => {
      statsReads += 1;
      return { success: true, statistics: { ...served().pdf, databasePath: brainDb(main.projectPath!) } };
    },
    purge: vi.fn(async () => ({ success: true })),
  };
  electron.tropy = {
    getStatistics: async () => {
      statsReads += 1;
      return { success: true, statistics: served().tropy, databasePath: brainDb(main.projectPath!) };
    },
    purge: vi.fn(async () => ({ success: true })),
  };
  electron.shell = { openPath: vi.fn(async () => '') };
}

/**
 * Le projet `dir` à l'écran, comme `openProjectContents` le pose : le main le sert déjà, les stores
 * du projet d'avant se vident, puis `currentProject` est remplacé d'un seul coup, sans passer par null.
 */
function show(dir: string, type: 'presentation' | 'article' = 'presentation'): void {
  main.projectPath = dir;
  projectLifecycle.enter(dir);
  useProjectStore.setState({
    currentProject: {
      id: path.basename(dir),
      name: path.basename(dir),
      path: dir,
      type,
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
  });
}

async function renderPanel(): Promise<void> {
  await act(async () => {
    render(<ProjectPanel />);
  });
}

function select(label: string): HTMLSelectElement {
  const found = screen.getByText(label).parentElement?.querySelector('select');
  if (!found) throw new Error(`pas de liste sous « ${label} »`);
  return found;
}

/** « Actions » se déplie, si elle ne l'est pas déjà. */
async function openActions(): Promise<void> {
  if (document.querySelector('.database-path-display')) return;
  await act(async () => {
    fireEvent.click(screen.getByText('actions.title'));
  });
}

/** Ce que la section « Actions » affiche, tel que l'auteur le lit. */
function actionsShown(): { documents: number; sources: number; paths: string[] } {
  const text = document.querySelector('.config-section')?.textContent ?? '';
  const count = (label: string) => Number(new RegExp(`${label}:\\s*(\\d+)`).exec(text)?.[1]);
  return {
    documents: count('actions.databaseInfo.documentsIndexed'),
    sources: count('Sources indexed'),
    paths: [...document.querySelectorAll('.database-path-display')].map((el) => el.textContent ?? ''),
  };
}

/** Clique un bouton de purge et rend le message de la première confirmation, refusée. */
async function purgeMessage(button: string): Promise<string> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: button }));
  });
  await waitFor(() => expect(dialogs().confirmOpen).toBe(true));
  const message = dialogs().confirmMessage;
  await act(async () => {
    dialogs().resolveConfirm(false);
  });
  return message;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-panel-switch-')));
  dirA = path.join(root, 'A');
  dirB = path.join(root, 'B');
  fs.mkdirSync(dirA);
  fs.mkdirSync(dirB);
  fs.writeFileSync(revealConfig(dirA), A_CONFIG);
  stats = new Map([
    [dirA, { pdf: { totalDocuments: 120, totalChunks: 5000 }, tropy: { sourceCount: 40, chunkCount: 300 } }],
    [dirB, { pdf: { totalDocuments: 3, totalChunks: 45 }, tropy: { sourceCount: 2, chunkCount: 6 } }],
  ]);
  statsReads = 0;
  revealReads = 0;
  readFile = (filePath) => ipc('fs:read-file', filePath);
  installElectron();
  useProjectStore.setState({ loadRecentProjects: async () => undefined } as never);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  while (dialogs().confirmOpen) dialogs().resolveConfirm(false);
  while (dialogs().alertOpen) dialogs().closeAlert();
  useProjectStore.setState({ currentProject: null });
  useBibliographyStore.setState({ indexedFilePaths: new Set() });
  main.projectPath = null;
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('apparence reveal.js : de la présentation A à la présentation B (S17-1-15)', () => {
  it('B sans réglages affiche les valeurs par défaut, et son premier réglage n’écrit rien de A', async () => {
    show(dirA);
    await renderPanel();
    await waitFor(() => expect(select('revealjs.theme').value).toBe('night'));
    expect(select('revealjs.transition').value).toBe('fade');

    await act(async () => show(dirB));
    await settle();

    expect(select('revealjs.theme').value).toBe('black');
    expect(select('revealjs.transition').value).toBe('slide');

    await act(async () => {
      fireEvent.click(screen.getByLabelText('revealjs.slideNumber'));
    });
    await waitFor(() => expect(fs.existsSync(revealConfig(dirB))).toBe(true));
    expect(JSON.parse(fs.readFileSync(revealConfig(dirB), 'utf8'))).toEqual({ ...DEFAULTS, slideNumber: true });
    expect(fs.readFileSync(revealConfig(dirA), 'utf8')).toBe(A_CONFIG);
  });

  it('une lecture de A qui finit après le passage à B ne s’affiche pas dans B, et n’y est pas écrite', async () => {
    let releaseA!: () => void;
    const heldA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    readFile = async (filePath) => {
      const content = await ipc('fs:read-file', filePath);
      if (filePath.startsWith(dirA)) await heldA;
      return content;
    };
    show(dirA);
    await renderPanel();
    await settle();

    await act(async () => show(dirB));
    await settle();
    await act(async () => releaseA());
    await settle();

    expect(select('revealjs.theme').value).toBe('black');
    expect(select('revealjs.transition').value).toBe('slide');

    await act(async () => {
      fireEvent.click(screen.getByLabelText('revealjs.slideNumber'));
    });
    await waitFor(() => expect(fs.existsSync(revealConfig(dirB))).toBe(true));
    expect(JSON.parse(fs.readFileSync(revealConfig(dirB), 'utf8'))).toEqual({ ...DEFAULTS, slideNumber: true });
  });
});

describe('section « Actions » : les statistiques du projet ouvert (S17-1-8)', () => {
  it('de A à B : compte et chemin de la base sont ceux de B, et la purge cite les nombres de B', async () => {
    show(dirA, 'article');
    await renderPanel();
    await openActions();
    await waitFor(() => expect(actionsShown().documents).toBe(120));
    expect(actionsShown().paths).toEqual([brainDb(dirA), brainDb(dirA)]);

    await act(async () => show(dirB, 'article'));
    await openActions();

    await waitFor(() => expect(actionsShown().documents).toBe(3));
    expect(actionsShown().sources).toBe(2);
    expect(actionsShown().paths).toEqual([brainDb(dirB), brainDb(dirB)]);
    // Une section par panneau : deux voisines de même clé laissaient l'ancienne montée à chaque passage.
    expect(screen.getAllByText('actions.title')).toHaveLength(1);
    expect(screen.getAllByText(/^zotero /).map((el) => el.textContent)).toEqual([`zotero ${dirB}`]);
    expect(await purgeMessage('actions.purgeDatabase.button')).toBe(
      'actions.purgeDatabase.confirmMessage {"totalDocuments":3,"totalChunks":45}'
    );
    expect(await purgeMessage('Purge Primary Sources')).toBe(
      'actions.purgePrimaryDatabase.confirmMessage {"sourceCount":2,"chunkCount":6}'
    );
  });

  it('juste avant la confirmation, les statistiques sont relues : le message cite ce que la base contient', async () => {
    show(dirB, 'article');
    await renderPanel();
    await openActions();
    await waitFor(() => expect(actionsShown().documents).toBe(3));
    expect(actionsShown().sources).toBe(2);

    // La base a changé sans que rien ne le dise à la section (une synchronisation Tropy, un autre panneau).
    stats.set(dirB, { pdf: { totalDocuments: 7, totalChunks: 90 }, tropy: { sourceCount: 5, chunkCount: 15 } });

    expect(await purgeMessage('actions.purgeDatabase.button')).toBe(
      'actions.purgeDatabase.confirmMessage {"totalDocuments":7,"totalChunks":90}'
    );
    expect(await purgeMessage('Purge Primary Sources')).toBe(
      'actions.purgePrimaryDatabase.confirmMessage {"sourceCount":5,"chunkCount":15}'
    );
    expect(actionsShown().documents).toBe(7);
    expect(actionsShown().sources).toBe(5);
  });

  it('des PDF indexés dans le projet ouvert : le compte suit, et la purge devient possible', async () => {
    stats.set(dirB, { pdf: { totalDocuments: 0, totalChunks: 0 }, tropy: { sourceCount: 0, chunkCount: 0 } });
    show(dirB, 'article');
    await renderPanel();
    await openActions();
    await waitFor(() => expect(actionsShown().paths).toEqual([brainDb(dirB), brainDb(dirB)]));
    expect(actionsShown().documents).toBe(0);
    expect(screen.getByRole('button', { name: 'actions.purgeDatabase.button' })).toBeDisabled();

    // Le lot d'indexation inscrit chaque PDF indexé dans la bibliographie ; le main les a déjà.
    stats.set(dirB, { pdf: { totalDocuments: 2, totalChunks: 30 }, tropy: { sourceCount: 0, chunkCount: 0 } });
    await act(async () => {
      useBibliographyStore.setState({
        indexedFilePaths: new Set([path.join(dirB, 'PDFs', 'dupont.pdf'), path.join(dirB, 'PDFs', 'martin.pdf')]),
      });
    });

    await waitFor(() => expect(actionsShown().documents).toBe(2));
    expect(screen.getByRole('button', { name: 'actions.purgeDatabase.button' })).not.toBeDisabled();
  });
});

describe('le même projet rouvert ne remonte rien', () => {
  it('style CSL choisi, ou même dossier rouvert : apparence et « Actions » gardent leur état, sans relecture', async () => {
    show(dirA);
    await renderPanel();
    await waitFor(() => expect(select('revealjs.theme').value).toBe('night'));
    await openActions();
    await waitFor(() => expect(actionsShown().documents).toBe(120));
    const readsBefore = statsReads;
    expect(revealReads).toBe(1);

    await act(async () => useProjectStore.getState().patchCurrentProject({ cslPath: path.join(dirA, 'chicago.csl') }));
    await act(async () => show(dirA));
    await settle();

    // Remontée, la section se replierait et relirait ses statistiques ; l'apparence relirait son fichier.
    expect(document.querySelector('.database-path-display')).not.toBeNull();
    expect(statsReads).toBe(readsBefore);
    expect(revealReads).toBe(1);
    expect(select('revealjs.theme').value).toBe('night');
  });
});
