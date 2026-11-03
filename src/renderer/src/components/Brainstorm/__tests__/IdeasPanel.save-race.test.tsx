// @vitest-environment jsdom
/**
 * Retoucher une idée puis cliquer sur sa corbeille : deux sauvegardes coup sur coup, celle du
 * blur et celle de la suppression (S16-1-19).
 *
 * Vrai panneau, vrai store, vrais gestes (user-event), VRAIS handlers `fs:*` sur un vrai
 * disque. Seul le main occupé est simulé, comme l'audit l'a mesuré : ses messages attendent
 * 150 ms puis partent dans l'ordre, chacun dans sa tâche, sans attendre la fin du précédent,
 * puisque `ipcMain.handle` ne l'attend pas. `IDEES_ESSAIS=40` rejoue la mesure de l'audit :
 * avant le verrou et l'écriture atomique du main (#182), 21 fichiers corrompus et 3 périmés sur
 * 40. Depuis, 0 et 0 : ce test garde ce résultat. La file du store, elle, se voit au canevas.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { IdeasCanvas } from '../IdeasCanvas';
import { IdeasPanel } from '../IdeasPanel';
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

const { setupFilesystemHandlers } = await import('../../../../../main/ipc/handlers/filesystem-handlers');

const ESSAIS = Number(process.env.IDEES_ESSAIS ?? 5);
const MAIN_OCCUPE_MS = 150;
const CLIC_MS = 100;
const IDEES = 30;

let project: string;
let ideasJson: string;
let mainFreeAt = 0;
/** Le main occupé jusqu'à nouvel ordre, quand la durée de l'occupation ne doit rien décider. */
let mainGate: Promise<void> = Promise.resolve();
let unanswered = 0;
let writeRequests = 0;

const mailbox: Array<() => void> = [];
let pumping = false;

/** Le main occupé : rien ne part avant `mainFreeAt`, puis un message par tâche, dans l'ordre. */
function pump(): void {
  if (pumping) return;
  const deliver = mailbox.shift();
  if (!deliver) return;
  pumping = true;
  setTimeout(() => {
    void mainGate.then(() => {
      pumping = false;
      deliver();
      pump();
    });
  }, Math.max(0, mainFreeAt - Date.now()));
}

/** Un message au main : le suivant n'attend pas sa réponse, seulement son tour de partir. */
function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`canal non enregistré : ${channel}`);
  unanswered++;
  return new Promise<T>((resolve, reject) => {
    mailbox.push(() => {
      Promise.resolve(handler({}, ...args))
        .then((value) => resolve(value as T), reject)
        .finally(() => {
          unanswered--;
        });
    });
    pump();
  });
}

function seedIdeas(): Idea[] {
  const now = new Date().toISOString();
  const ideas: Idea[] = Array.from({ length: IDEES }, (_, i) => ({
    id: `idee-${i}`,
    title: `Idée ${i}`,
    content: `Contenu de l'idée ${i}, assez long pour que la queue d'un JSON se voie. `.repeat(3),
    tags: [],
    links: [],
    origin: { type: 'manual' },
    position: { x: 0, y: 0 },
    createdAt: now,
    updatedAt: now,
  }));
  fs.writeFileSync(ideasJson, JSON.stringify({ ideas }, null, 2));
  return ideas;
}

beforeEach(() => {
  h.handlers.clear();
  setupFilesystemHandlers();
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-idees-course-')));
  fs.mkdirSync(path.join(project, '.cliodeck'));
  ideasJson = path.join(project, '.cliodeck', 'ideas.json');
  h.mainCurrent = project;
  mainFreeAt = 0;
  mainGate = Promise.resolve();
  writeRequests = 0;
  (window as unknown as { electron: unknown }).electron = {
    fs: {
      exists: (p: string) => invoke('fs:exists', p),
      readUserFile: (p: string) => invoke('fs:read-user-file', p),
      writeFile: (p: string, content: string, options?: unknown) => {
        writeRequests++;
        return invoke('fs:write-file', p, content, options);
      },
      quarantineFile: (p: string) => invoke('fs:quarantine-file', p),
    },
  };
  useProjectStore.setState({ currentProject: { path: project } as never });
});

afterEach(() => {
  cleanup();
  useProjectStore.setState({ currentProject: null });
  fs.rmSync(project, { recursive: true, force: true });
});

describe('IdeasPanel : blur puis corbeille, sur un main occupé', () => {
  it(`le fichier reste valide et sans l'idée supprimée (${ESSAIS} essais)`, async () => {
    const user = userEvent.setup({ delay: null });
    let corrompus = 0;
    let perimes = 0;

    for (let essai = 0; essai < ESSAIS; essai++) {
      seedIdeas();
      await act(async () => {
        await useIdeaStore.getState().loadIdeas(project);
      });
      const victime = `idee-${essai % IDEES}`;
      useIdeaStore.getState().setSelected(victime);
      const { unmount } = render(<IdeasPanel />);

      await user.click(screen.getByPlaceholderText('ideas.contentPlaceholder'));
      mainFreeAt = Date.now() + MAIN_OCCUPE_MS;
      const corbeille = screen.getByTitle('ideas.delete');
      // Le blur part à l'appui, la suppression au relâchement : un vrai clic, pas deux appels.
      await user.pointer({ keys: '[MouseLeft>]', target: corbeille });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, CLIC_MS));
      });
      await user.pointer({ keys: '[/MouseLeft]', target: corbeille });
      expect(useIdeaStore.getState().ideas.some((idea) => idea.id === victime)).toBe(false);

      await vi.waitFor(() => expect(unanswered).toBe(0), { timeout: 10000, interval: 5 });
      await act(async () => {
        await useIdeaStore.getState().flushIdeas();
      });
      await vi.waitFor(() => expect(unanswered).toBe(0), { timeout: 10000, interval: 5 });

      const written = fs.readFileSync(ideasJson, 'utf8');
      try {
        const { ideas } = JSON.parse(written) as { ideas: Idea[] };
        if (ideas.some((idea) => idea.id === victime)) perimes++;
      } catch {
        corrompus++;
      }
      unmount();
    }

    console.log(`[mesure S16-1-19] ${ESSAIS} essais : ${corrompus} corrompus, ${perimes} périmés`);
    expect({ corrompus, perimes }).toEqual({ corrompus: 0, perimes: 0 });
  }, 120000);
});

describe('IdeasCanvas : des cartes déplacées coup sur coup, sur un main occupé', () => {
  it('la file ne s’allonge pas, et la dernière position est sur le disque', async () => {
    seedIdeas();
    await act(async () => {
      await useIdeaStore.getState().loadIdeas(project);
    });
    render(<IdeasCanvas />);
    const canvas = document.querySelector('.ideas-canvas') as HTMLElement;
    const card = document.querySelector('.ideas-canvas__card') as HTMLElement;
    let release: () => void = () => undefined;
    mainGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const DRAGS = 30;
    for (let drag = 1; drag <= DRAGS; drag++) {
      fireEvent.mouseDown(card, { button: 0, clientX: 0, clientY: 0 });
      for (let move = 1; move <= 20; move++) {
        fireEvent.mouseMove(canvas, { clientX: drag * 10 + move, clientY: 0 });
      }
      fireEvent.mouseUp(canvas);
      // Le maillon en attente part quand vient son tour : laisser tourner la file entre deux gestes.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    const last = useIdeaStore.getState().ideas[0].position;
    expect(last?.x).toBeGreaterThan(0);
    expect(writeRequests).toBe(1);

    release();
    await act(async () => {
      await useIdeaStore.getState().flushIdeas();
    });
    await vi.waitFor(() => expect(unanswered).toBe(0), { timeout: 10000, interval: 5 });

    expect(writeRequests).toBe(2);
    const { ideas } = JSON.parse(fs.readFileSync(ideasJson, 'utf8')) as { ideas: Idea[] };
    expect(ideas[0].position).toEqual(last);
  }, 30000);
});
