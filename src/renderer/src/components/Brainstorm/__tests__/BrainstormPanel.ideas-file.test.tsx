// @vitest-environment jsdom
/**
 * La bannière du fichier des idées, et ce qu'elle remplace. Vrai panneau, vrai store, VRAIS
 * handlers `fs:*` sur un vrai disque. Le chat et le graphe de forces, qui ne sont pas ce qu'on
 * regarde et réclament un canvas, sont simulés.
 */
import { useLayoutEffect, type FC } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { BrainstormPanel } from '../BrainstormPanel';
import { hasUnwrittenIdeas, useIdeaStore, type Idea } from '../../../stores/ideaStore';
import { useProjectStore } from '../../../stores/projectStore';

// Vrai disque et plusieurs allers-retours par test : à 24 `yes` sur 14 cœurs, l'un d'eux dépassait les 5 s par défaut.
vi.setConfig({ testTimeout: 30_000 });

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  mainCurrent: null as string | null,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
  dialog: {},
  shell: {},
  BrowserWindow: { fromWebContents: () => null },
  app: { isPackaged: false, getPath: () => '/tmp', getAppPath: () => '/nonexistent-app-path' },
}));
vi.mock('../../../../../main/services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => h.mainCurrent },
}));
vi.mock('../../../../../main/services/config-manager.js', () => ({
  configManager: { get: () => undefined, set: () => undefined },
}));
vi.mock('../../Chat/AssistantChat', () => ({ AssistantChat: () => <div data-testid="chat" /> }));
vi.mock('react-force-graph-2d', () => ({ default: () => <div data-testid="graphe" /> }));

const { setupFilesystemHandlers } = await import('../../../../../main/ipc/handlers/filesystem-handlers');

const IS_ROOT = process.getuid?.() === 0;
const QUARANTINED = 'ideas.unreadable.quarantined';
const BLOCKED = 'ideas.unreadable.blocked';
const SAVE_FAILED = 'ideas.saveFailed';

let root: string;
let dirA: string;
let dirB: string;
let ideasA: string;
let hintsFail: boolean;

const idea = (title: string): Idea => ({
  id: `idee-${title}`,
  title,
  content: '',
  tags: [],
  links: [],
  origin: { type: 'manual' },
  position: { x: 0, y: 0 },
  createdAt: '2026-05-06T10:00:00.000Z',
  updatedAt: '2026-05-06T10:00:00.000Z',
});

const ideasFile = (...titles: string[]) => JSON.stringify({ ideas: titles.map(idea) });
const ipc = (channel: string, ...args: unknown[]) => {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`canal non enregistré : ${channel}`);
  return handler({}, ...args);
};

function openProject(dir: string | null): void {
  h.mainCurrent = dir;
  act(() => {
    useProjectStore.setState({ currentProject: dir ? ({ path: dir } as never) : null });
  });
}

const settled = () =>
  act(async () => {
    await vi.waitFor(() => expect(useIdeaStore.getState().isLoading).toBe(false), { timeout: 5000, interval: 5 });
  });

const clickTab = async (name: string) => {
  await userEvent.click(screen.getByRole('tab', { name }));
  await settled();
};

const backups = () =>
  fs.readdirSync(path.join(dirA, '.cliodeck')).filter((name) => name.startsWith('ideas.json.illisible-'));

beforeEach(() => {
  h.handlers.clear();
  setupFilesystemHandlers();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-idees-banniere-')));
  dirA = path.join(root, 'A');
  dirB = path.join(root, 'B');
  fs.mkdirSync(path.join(dirA, '.cliodeck'), { recursive: true });
  fs.mkdirSync(path.join(dirB, '.cliodeck'), { recursive: true });
  ideasA = path.join(dirA, '.cliodeck', 'ideas.json');
  hintsFail = false;
  (window as unknown as { electron: unknown }).electron = {
    fs: {
      exists: (p: string) => ipc('fs:exists', p),
      readUserFile: (p: string) => ipc('fs:read-user-file', p),
      writeFile: (p: string, content: string, options?: unknown) => ipc('fs:write-file', p, content, options),
      quarantineFile: (p: string) => ipc('fs:quarantine-file', p),
    },
    fusion: {
      hints: {
        read: async () => {
          if (hintsFail) throw new Error('consignes illisibles');
          return { success: true, hints: { present: false, raw: '', normalized: '', sourcePath: '' } };
        },
      },
      recipes: { list: async () => ({ success: true, builtin: [], user: [] }) },
      vault: { status: async () => ({ success: true, indexed: false, dbPath: '' }) },
    },
    config: { get: async () => undefined, set: async () => undefined },
  };
  useIdeaStore.setState({
    ideas: [],
    isLoading: false,
    selectedId: null,
    persistence: { kind: 'ready' },
    loadedFor: null,
    saveError: null,
  });
});

afterEach(() => {
  cleanup();
  useProjectStore.setState({ currentProject: null, loadState: { kind: 'idle' } });
  sessionStorage.clear();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('fichier mis de côté', () => {
  beforeEach(() => {
    fs.writeFileSync(ideasA, '{ tronqué');
  });

  async function openedOnIdeas() {
    openProject(dirA);
    const view = render(<BrainstormPanel />);
    await settled();
    await clickTab('ideas.tabIdeas');
    return view;
  }

  it('la bannière donne le chemin, et le panneau reste utilisable', async () => {
    await openedOnIdeas();

    const banner = screen.getByRole('alert');
    expect(within(banner).getByText(QUARANTINED)).toBeInTheDocument();
    expect(within(banner).getByText(path.join(dirA, '.cliodeck', backups()[0]))).toBeInTheDocument();
    expect(screen.getByTitle('ideas.create')).toBeInTheDocument();
  });

  it('dès l’arrivée sur le chat, l’onglet par défaut : qui ne le quitte pas doit le savoir aussi', async () => {
    openProject(dirA);
    render(<BrainstormPanel />);
    await settled();

    expect(screen.getByTestId('chat')).toBeInTheDocument();
    const banner = screen.getByRole('alert');
    expect(within(banner).getByText(QUARANTINED)).toBeInTheDocument();
    expect(within(banner).getByText(path.join(dirA, '.cliodeck', backups()[0]))).toBeInTheDocument();
  });

  it('sur tous les onglets, dans tout changement d’onglet', async () => {
    await openedOnIdeas();

    for (const tab of ['ideas.tabChat', 'ideas.tabCanvas', 'ideas.tabGraph', 'ideas.tabIdeas']) {
      await clickTab(tab);
      expect(screen.getByText(QUARANTINED)).toBeInTheDocument();
    }
  });

  it('un aller-retour vers un autre projet, sans avoir quitté le chat : elle revient', async () => {
    openProject(dirA);
    render(<BrainstormPanel />);
    await settled();

    openProject(dirB);
    await settled();
    expect(screen.queryByText(QUARANTINED)).toBeNull();

    openProject(dirA);
    await settled();
    expect(screen.getByText(QUARANTINED)).toBeInTheDocument();
    expect(screen.getByText(path.join(dirA, '.cliodeck', backups()[0]))).toBeInTheDocument();
  });

  it('elle survit au rechargement du panneau et à la première sauvegarde, sans nouvelle mise de côté', async () => {
    const view = await openedOnIdeas();
    await userEvent.click(screen.getByTitle('ideas.create'));
    await vi.waitFor(() => expect(fs.existsSync(ideasA)).toBe(true), { timeout: 5000 });
    const backup = backups();

    // Quitter le Brainstorm et y revenir démonte le panneau, et son effet recharge.
    view.unmount();
    render(<BrainstormPanel />);
    await settled();
    await clickTab('ideas.tabIdeas');

    expect(screen.getByText(QUARANTINED)).toBeInTheDocument();
    expect(backups()).toEqual(backup);
    expect(screen.getByText('ideas.newIdeaTitle')).toBeInTheDocument();
  });

  it('un autre projet ne l’hérite pas', async () => {
    await openedOnIdeas();

    openProject(dirB);
    await settled();

    expect(screen.queryByText(QUARANTINED)).toBeNull();
    expect(screen.getByText('ideas.emptyState')).toBeInTheDocument();
  });
});

describe('le fichier sain recopié à côté de sa mise de côté, pendant la session (C40 puis C41)', () => {
  // Des idées que l'app n'a jamais placées : le Tableau doit le faire.
  const returnedTitles = Array.from({ length: 10 }, (_, i) => `Revenue ${i}`);
  const sane = JSON.stringify(
    {
      ideas: returnedTitles.map((title) => {
        const { position: _position, ...unplaced } = idea(title);
        return unplaced;
      }),
    },
    null,
    2
  );

  /** App fermée, le fichier tronqué ; Brainstormer, puis l'onglet : la bannière. */
  async function quarantinedOn(tab: string): Promise<string[]> {
    fs.writeFileSync(ideasA, sane.slice(0, 20));
    openProject(dirA);
    render(<BrainstormPanel />);
    await settled();
    await clickTab(tab);
    expect(screen.getByText(QUARANTINED)).toBeInTheDocument();
    return backups();
  }

  /** Le `cp` : la copie mise de côté reste où elle est. */
  const copySaneFileBack = () => fs.writeFileSync(ideasA, sane);

  const writtenCount = () =>
    act(async () => {
      await vi.waitFor(
        () => expect(JSON.parse(fs.readFileSync(ideasA, 'utf8')).ideas).toHaveLength(returnedTitles.length + 1),
        { timeout: 5000, interval: 5 }
      );
    });

  it('onglet Idées : les idées revenues s’affichent avec la nouvelle, sans changer d’onglet, et la bannière reste', async () => {
    const backup = await quarantinedOn('ideas.tabIdeas');
    copySaneFileBack();

    await userEvent.click(screen.getByTitle('ideas.create'));
    await writtenCount();

    expect(document.querySelectorAll('.ideas-panel__item')).toHaveLength(returnedTitles.length + 1);
    for (const title of returnedTitles) expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByText(QUARANTINED)).toBeInTheDocument();
    expect(screen.getByText(path.join(dirA, '.cliodeck', backup[0]))).toBeInTheDocument();
    expect(backups()).toEqual(backup);
  });

  it('onglet Tableau : les cartes revenues se placent sans s’empiler, sans changer d’onglet, et la nouvelle ne bouge pas', async () => {
    const backup = await quarantinedOn('ideas.tabCanvas');
    copySaneFileBack();

    await userEvent.click(screen.getByTitle('ideas.create'));
    const [created] = useIdeaStore.getState().ideas;
    await writtenCount();

    const cards = [...document.querySelectorAll<HTMLElement>('.ideas-canvas__card')];
    expect(cards).toHaveLength(returnedTitles.length + 1);
    // Des positions distinctes ne suffisent pas : deux cartes de 200 px décalées de 10 px se
    // recouvrent. jsdom ne mesure rien : largeur lue sur la carte, hauteur prêtée par le Tableau
    // (CARD_HEIGHT, 120 px). Seulement entre les revenues : la nouvelle, posée au centre de la vue,
    // peut en recouvrir une, la grille ignorant les cartes déjà placées (comme au montage).
    const returned = cards
      .filter((card) => returnedTitles.includes(card.querySelector('.ideas-canvas__card-title')?.textContent ?? ''))
      .map((card) => ({
        title: card.querySelector('.ideas-canvas__card-title')?.textContent,
        x: parseFloat(card.style.left),
        y: parseFloat(card.style.top),
        width: parseFloat(card.style.width),
      }));
    expect(returned).toHaveLength(returnedTitles.length);
    const overlapping = returned.flatMap((a, i) =>
      returned
        .slice(i + 1)
        .filter((b) => Math.abs(a.x - b.x) < a.width && Math.abs(a.y - b.y) < 120)
        .map((b) => `${a.title} / ${b.title}`)
    );
    expect(overlapping).toEqual([]);
    expect(useIdeaStore.getState().ideas.find((i) => i.id === created.id)?.position).toEqual(created.position);
    expect(screen.getByText(QUARANTINED)).toBeInTheDocument();
    expect(backups()).toEqual(backup);
  });
});

describe('lecture impossible', () => {
  it.skipIf(IS_ROOT)('la bannière remplace Idées, Tableau et Graphe, et Réessayer suffit', async () => {
    fs.writeFileSync(ideasA, ideasFile('Braudel'));
    fs.chmodSync(ideasA, 0o000);
    try {
      openProject(dirA);
      render(<BrainstormPanel />);
      await settled();

      // Rien n'est en jeu tant qu'on reste sur le chat, et le disque revient peut-être tout seul.
      expect(screen.queryByText(BLOCKED)).toBeNull();

      await clickTab('ideas.tabIdeas');
      expect(screen.getByText(BLOCKED)).toBeInTheDocument();
      expect(screen.getByText(ideasA)).toBeInTheDocument();
      expect(screen.queryByTitle('ideas.create')).toBeNull();

      await clickTab('ideas.tabCanvas');
      expect(screen.getByText(BLOCKED)).toBeInTheDocument();
      expect(document.querySelector('.ideas-canvas')).toBeNull();

      await clickTab('ideas.tabGraph');
      expect(screen.getByText(BLOCKED)).toBeInTheDocument();

      expect(backups()).toEqual([]);
    } finally {
      fs.chmodSync(ideasA, 0o644);
    }

    await clickTab('ideas.tabIdeas');
    await userEvent.click(screen.getByRole('button', { name: 'ideas.unreadable.retry' }));
    await settled();

    expect(screen.queryByText(BLOCKED)).toBeNull();
    expect(screen.getByText('Braudel')).toBeInTheDocument();
  });
});

describe('la bannière d’un projet ne déborde pas sur le suivant', () => {
  function holdReadsOf(dir: string): () => void {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = window.electron.fs.readUserFile;
    (window.electron.fs as { readUserFile: unknown }).readUserFile = async (p: string) => {
      if (p.startsWith(dir)) await held;
      return read(p);
    };
    return () => {
      release();
    };
  }

  it('la mise de côté de A ne se dit plus pendant le chargement de B', async () => {
    fs.writeFileSync(ideasA, '{ tronqué');
    openProject(dirA);
    render(<BrainstormPanel />);
    await settled();
    expect(screen.getByText(QUARANTINED)).toBeInTheDocument();
    const releaseB = holdReadsOf(dirB);

    openProject(dirB);
    await act(async () => {
      await vi.waitFor(() => expect(useIdeaStore.getState().isLoading).toBe(true), { timeout: 5000 });
    });

    expect(useIdeaStore.getState().loadedFor).toBe(dirA);
    expect(screen.queryByRole('alert')).toBeNull();

    releaseB();
    await settled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('le Réessayer de A, qui porterait sur B, non plus', async () => {
    const read = window.electron.fs.readUserFile;
    (window.electron.fs as { readUserFile: unknown }).readUserFile = async (p: string) =>
      p === ideasA ? { kind: 'unreadable', reason: 'io', message: 'ETIMEDOUT' } : read(p);
    openProject(dirA);
    render(<BrainstormPanel />);
    await settled();
    await clickTab('ideas.tabIdeas');
    expect(screen.getByRole('button', { name: 'ideas.unreadable.retry' })).toBeInTheDocument();
    const releaseB = holdReadsOf(dirB);

    openProject(dirB);
    await act(async () => {
      await vi.waitFor(() => expect(useIdeaStore.getState().isLoading).toBe(true), { timeout: 5000 });
    });

    expect(useIdeaStore.getState().loadedFor).toBe(dirA);
    expect(screen.queryByRole('button', { name: 'ideas.unreadable.retry' })).toBeNull();

    releaseB();
    await settled();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('bloqué, le Graphe reste fermé lui aussi', () => {
  it('même si une liste traîne en mémoire : le graphe vide ne prouverait rien, il ne rend alors rien', async () => {
    fs.writeFileSync(ideasA, ideasFile('Braudel'));
    openProject(dirA);
    render(<BrainstormPanel />);
    await settled();
    await clickTab('ideas.tabGraph');
    // Le témoin : avec cette liste et sans blocage, le graphe est là.
    expect(screen.getByTestId('graphe')).toBeInTheDocument();

    act(() => {
      useIdeaStore.setState({ persistence: { kind: 'blocked', reason: 'ETIMEDOUT' } });
    });

    expect(useIdeaStore.getState().ideas).toHaveLength(1);
    expect(screen.getByText(BLOCKED)).toBeInTheDocument();
    expect(screen.queryByTestId('graphe')).toBeNull();
  });
});

describe('un import Obsidian qui répond après une bascule', () => {
  const NOTE = 'NOTE-DU-COFFRE-DE-A';
  let answerImport: () => void;

  beforeEach(() => {
    const vault = window.electron.fusion?.vault as unknown as { importAsIdeas: unknown };
    vault.importAsIdeas = () =>
      new Promise((resolve) => {
        answerImport = () =>
          resolve({
            success: true,
            ideas: [{ title: NOTE, content: '', tags: [], wikilinks: [], notePath: 'note.md' }],
          });
      });
  });

  async function importStartedIn(dir: string): Promise<void> {
    openProject(dir);
    render(<BrainstormPanel />);
    await settled();
    await clickTab('ideas.tabIdeas');
    await userEvent.click(screen.getByTitle('ideas.importObsidian'));
  }

  it('ne laisse rien de A dans la liste de B, ni sur son disque à la sortie', async () => {
    const ideasB = path.join(dirB, '.cliodeck', 'ideas.json');
    const onDiskB = ideasFile('De B');
    fs.writeFileSync(ideasB, onDiskB);
    await importStartedIn(dirA);

    openProject(dirB);
    await settled();
    expect(screen.getByText('De B')).toBeInTheDocument();

    await act(async () => {
      answerImport();
      // La suite de l'import passe aux microtâches qui suivent sa réponse.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(useIdeaStore.getState().ideas.map((i) => i.title)).toEqual(['De B']);
    expect(hasUnwrittenIdeas()).toBe(false);
    await useIdeaStore.getState().flushIdeas();
    expect(fs.readFileSync(ideasB, 'utf8')).toBe(onDiskB);
  });

  it('sans bascule, les notes arrivent et s’écrivent', async () => {
    await importStartedIn(dirA);

    await act(async () => {
      answerImport();
      await vi.waitFor(() => expect(fs.existsSync(ideasA)).toBe(true), { timeout: 5000 });
    });

    expect(fs.readFileSync(ideasA, 'utf8')).toContain(NOTE);
    expect(useIdeaStore.getState().ideas.map((i) => i.title)).toEqual([NOTE]);
  });
});

describe('écriture ratée', () => {
  it('la bannière la dit, avec la raison, et Réessayer écrit une fois le disque revenu', async () => {
    fs.writeFileSync(ideasA, ideasFile('Braudel'));
    openProject(dirA);
    render(<BrainstormPanel />);
    await settled();
    await clickTab('ideas.tabIdeas');
    const write = window.electron.fs.writeFile;
    (window.electron.fs as { writeFile: unknown }).writeFile = async () => {
      throw new Error('ENOSPC: no space left on device, write');
    };

    await userEvent.click(screen.getByTitle('ideas.create'));

    expect(await screen.findByText(SAVE_FAILED, undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText(/ENOSPC/)).toBeInTheDocument();
    expect(screen.getByText('ideas.newIdeaTitle')).toBeInTheDocument();

    // Depuis le chat aussi : elle n'attend pas qu'on revienne voir.
    await clickTab('ideas.tabChat');
    expect(screen.getByText(SAVE_FAILED)).toBeInTheDocument();
    await clickTab('ideas.tabIdeas');

    (window.electron.fs as { writeFile: unknown }).writeFile = write;
    await userEvent.click(screen.getByRole('button', { name: 'ideas.unreadable.retry' }));

    await vi.waitFor(() => expect(screen.queryByText(SAVE_FAILED)).toBeNull(), { timeout: 5000 });
    expect(fs.readFileSync(ideasA, 'utf8')).toContain('ideas.newIdeaTitle');
  });

  it('regarder le Tableau d’un fichier en lecture seule n’écrit rien, et rien ne se dit', async () => {
    const { position: _position, ...unplaced } = idea('Braudel');
    fs.writeFileSync(ideasA, JSON.stringify({ ideas: [unplaced] }));
    openProject(dirA);
    render(<BrainstormPanel />);
    await settled();
    const written: string[] = [];
    (window.electron.fs as { writeFile: unknown }).writeFile = async (filePath: string) => {
      written.push(filePath);
      throw new Error('EACCES: permission denied, write');
    };

    await clickTab('ideas.tabCanvas');
    const card = await screen.findByText('Braudel', undefined, { timeout: 5000 });

    await userEvent.click(card);
    await settled();

    expect(written).toEqual([]);
    expect(screen.queryByText(SAVE_FAILED)).toBeNull();
    expect(useIdeaStore.getState().ideas[0].position).toBeDefined();
    expect(useIdeaStore.getState().saveError).toBeNull();
  });
});

describe('une liste qui n’est pas celle de ce projet ne se montre pas', () => {
  it('pendant le chargement : rien à modifier, ce qu’on y ferait disparaîtrait', async () => {
    fs.writeFileSync(ideasA, ideasFile('Braudel'));
    let release: (() => void) | null = null;
    const read = window.electron.fs.readUserFile;
    (window.electron.fs as { readUserFile: unknown }).readUserFile = async (p: string) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return read(p);
    };
    openProject(dirA);
    render(<BrainstormPanel />);

    await userEvent.click(screen.getByRole('tab', { name: 'ideas.tabIdeas' }));
    expect(screen.getByText('ideas.loading')).toBeInTheDocument();
    expect(screen.queryByTitle('ideas.create')).toBeNull();

    await vi.waitFor(() => expect(release).not.toBeNull(), { timeout: 5000 });
    (release as unknown as () => void)();
    await settled();
    expect(await screen.findByText('Braudel', undefined, { timeout: 5000 })).toBeInTheDocument();
  });

  it('pendant le rechargement du même projet aussi : la liste à l’écran va être remplacée', async () => {
    fs.writeFileSync(ideasA, ideasFile('Braudel'));
    openProject(dirA);
    const view = render(<BrainstormPanel />);
    await settled();
    view.unmount();

    let release: () => void = () => undefined;
    const read = window.electron.fs.readUserFile;
    (window.electron.fs as { readUserFile: unknown }).readUserFile = async (p: string) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return read(p);
    };
    render(<BrainstormPanel />);
    await userEvent.click(screen.getByRole('tab', { name: 'ideas.tabIdeas' }));

    expect(screen.getByText('ideas.loading')).toBeInTheDocument();
    expect(screen.queryByTitle('ideas.create')).toBeNull();

    await vi.waitFor(() => expect(useIdeaStore.getState().isLoading).toBe(true), { timeout: 5000 });
    await act(async () => {
      await vi.waitFor(() => {
        release();
        expect(useIdeaStore.getState().isLoading).toBe(false);
      }, { timeout: 5000 });
    });
    expect(await screen.findByText('Braudel', undefined, { timeout: 5000 })).toBeInTheDocument();
  });

  it('au rendu même de la bascule, avant que le chargement parte, la liste d’avant n’est déjà plus là', async () => {
    fs.writeFileSync(ideasA, ideasFile('Idée de A'));
    fs.writeFileSync(path.join(dirB, '.cliodeck', 'ideas.json'), ideasFile('Idée de B'));
    const seenAtCommit: Array<{ project: string | null; listed: boolean }> = [];
    // Un effet de mise en page voit le DOM de ce rendu, avant les effets qui lancent le chargement.
    const Probe: FC = () => {
      const project = useProjectStore((s) => s.currentProject?.path ?? null);
      useLayoutEffect(() => {
        seenAtCommit.push({ project, listed: screen.queryByText('Idée de A') !== null });
      }, [project]);
      return null;
    };
    openProject(dirA);
    render(
      <>
        <BrainstormPanel />
        <Probe />
      </>
    );
    await settled();
    await clickTab('ideas.tabIdeas');
    expect(screen.getByText('Idée de A')).toBeInTheDocument();

    openProject(dirB);
    await settled();

    expect(seenAtCommit.at(-1)).toEqual({ project: dirB, listed: false });
  });

  it('des consignes illisibles n’empêchent pas de charger les idées du nouveau projet', async () => {
    fs.writeFileSync(ideasA, ideasFile('Idée de A'));
    fs.writeFileSync(path.join(dirB, '.cliodeck', 'ideas.json'), ideasFile('Idée de B'));
    openProject(dirA);
    render(<BrainstormPanel />);
    await settled();
    await clickTab('ideas.tabIdeas');
    expect(screen.getByText('Idée de A')).toBeInTheDocument();

    hintsFail = true;
    openProject(dirB);
    await settled();

    expect(screen.queryByText('Idée de A')).toBeNull();
    expect(screen.getByText('Idée de B')).toBeInTheDocument();
  });

  it('sans projet : ni liste, ni bouton dont rien ne serait enregistré', async () => {
    fs.writeFileSync(ideasA, ideasFile('Idée de A'));
    openProject(dirA);
    render(<BrainstormPanel />);
    await settled();
    await clickTab('ideas.tabIdeas');

    openProject(null);
    await settled();

    expect(screen.queryByText('Idée de A')).toBeNull();
    expect(screen.queryByTitle('ideas.create')).toBeNull();
  });
});
