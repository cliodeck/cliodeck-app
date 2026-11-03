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
import { useIdeaStore, type Idea } from '../../../stores/ideaStore';
import { useProjectStore } from '../../../stores/projectStore';

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
  useProjectStore.setState({ currentProject: null });
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

  it('pas sur le chat, mais sur Idées, Tableau et Graphe, dans tout changement d’onglet', async () => {
    await openedOnIdeas();

    await clickTab('ideas.tabChat');
    expect(screen.queryByRole('alert')).toBeNull();
    for (const tab of ['ideas.tabCanvas', 'ideas.tabGraph', 'ideas.tabIdeas']) {
      await clickTab(tab);
      expect(screen.getByText(QUARANTINED)).toBeInTheDocument();
    }
  });

  it('elle survit au rechargement du panneau et à la première sauvegarde, sans nouvelle mise de côté', async () => {
    const view = await openedOnIdeas();
    await userEvent.click(screen.getByTitle('ideas.create'));
    await vi.waitFor(() => expect(fs.existsSync(ideasA)).toBe(true));
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

describe('lecture impossible', () => {
  it.skipIf(IS_ROOT)('la bannière remplace Idées, Tableau et Graphe, et Réessayer suffit', async () => {
    fs.writeFileSync(ideasA, ideasFile('Braudel'));
    fs.chmodSync(ideasA, 0o000);
    try {
      openProject(dirA);
      render(<BrainstormPanel />);
      await settled();

      await clickTab('ideas.tabIdeas');
      expect(screen.getByText(BLOCKED)).toBeInTheDocument();
      expect(screen.getByText(ideasA)).toBeInTheDocument();
      expect(screen.queryByTitle('ideas.create')).toBeNull();

      await clickTab('ideas.tabCanvas');
      expect(screen.getByText(BLOCKED)).toBeInTheDocument();
      expect(document.querySelector('.ideas-canvas')).toBeNull();

      await clickTab('ideas.tabGraph');
      expect(screen.getByText(BLOCKED)).toBeInTheDocument();
      expect(screen.queryByTestId('graphe')).toBeNull();

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

    expect(await screen.findByText(SAVE_FAILED)).toBeInTheDocument();
    expect(screen.getByText(/ENOSPC/)).toBeInTheDocument();
    expect(screen.getByText('ideas.newIdeaTitle')).toBeInTheDocument();

    (window.electron.fs as { writeFile: unknown }).writeFile = write;
    await userEvent.click(screen.getByRole('button', { name: 'ideas.unreadable.retry' }));

    await vi.waitFor(() => expect(screen.queryByText(SAVE_FAILED)).toBeNull());
    expect(fs.readFileSync(ideasA, 'utf8')).toContain('ideas.newIdeaTitle');
  });
});

describe('une liste qui n’est pas celle de ce projet ne se montre pas', () => {
  it('pendant le chargement : rien à modifier, ce qu’on y ferait disparaîtrait', async () => {
    fs.writeFileSync(ideasA, ideasFile('Braudel'));
    let release: () => void = () => undefined;
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

    await vi.waitFor(() => release !== undefined);
    release();
    await settled();
    expect(await screen.findByText('Braudel')).toBeInTheDocument();
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

    await vi.waitFor(() => expect(useIdeaStore.getState().isLoading).toBe(true));
    await act(async () => {
      await vi.waitFor(() => {
        release();
        expect(useIdeaStore.getState().isLoading).toBe(false);
      });
    });
    expect(await screen.findByText('Braudel')).toBeInTheDocument();
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
