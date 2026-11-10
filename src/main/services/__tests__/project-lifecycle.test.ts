/**
 * La séquence d'ouverture et de fermeture d'un projet côté main (L03-3, première partie).
 *
 * De faux services et un faux gestionnaire de projet : la séquence n'en importe aucun, et c'est
 * son ordre qu'on juge ici. Chaque appel s'inscrit dans `events`. Les attentes bornées se jugent
 * avec un service qui ne répond jamais et un délai injecté (ou de faux minuteurs) : le test attend
 * le résultat, jamais un délai réel.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi, type MockInstance } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'fs';
import os from 'os';
import path from 'path';
import { ProjectChangedError, type ProjectHandle } from '../../../../backend/types/project-handle.js';
import type { ProjectManager } from '../project-manager.js';
import {
  createProjectLifecycle,
  type ProjectBoundService,
  type ProjectLifecycleOptions,
  type ProjectManagerPort,
  type ProjectServiceMode,
} from '../project-lifecycle.js';

interface Loaded {
  success: boolean;
  project?: { name: string };
  code?: string;
  fileName?: string;
  error?: string;
}

interface OpenRequest {
  tag: string;
}

const A = '/projets/A/project.json';
const B = '/projets/B/project.json';
const C = '/projets/C/project.json';

const label = (dir: string): string => path.basename(dir);
const never = (): Promise<void> => new Promise<void>(() => undefined);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface FakeProject {
  /** `project.json` illisible : le préflight le refuse. */
  unreadable?: boolean;
  /** Lisible, mais `lastOpenedAt` ne s'écrit pas : `loadProject` le refuse. */
  unwritable?: boolean;
}

type FakeManager = ProjectManagerPort<Loaded> & {
  current: () => string | null;
  metadataCalls: string[];
  loadCalls: string[];
};

function fakeManager(events: string[], projects: Record<string, FakeProject>): FakeManager {
  let current: string | null = null;
  const metadataCalls: string[] = [];
  const loadCalls: string[] = [];
  return {
    current: () => current,
    metadataCalls,
    loadCalls,
    async getProjectMetadata(projectFile) {
      metadataCalls.push(projectFile);
      const project = projects[projectFile];
      if (!project || project.unreadable) {
        return { success: false, code: 'manifest_unreadable', fileName: 'project.json', error: 'JSON invalide' };
      }
      return { success: true };
    },
    async loadProject(projectFile) {
      loadCalls.push(projectFile);
      const project = projects[projectFile];
      if (!project || project.unreadable) {
        return { success: false, code: 'manifest_unreadable', fileName: 'project.json', error: 'JSON invalide' };
      }
      if (project.unwritable) {
        return { success: false, code: 'manifest_unwritable', fileName: 'project.json', error: 'EROFS' };
      }
      current = path.dirname(projectFile);
      events.push(`load:${label(current)}`);
      return { success: true, project: { name: label(current) } };
    },
    getCurrentProjectPath: () => current,
    close() {
      current = null;
      events.push('manager:close');
    },
  };
}

interface FakeServiceOptions {
  mode?: ProjectServiceMode;
  openTimeoutMs?: number;
  closeTimeoutMs?: number;
  open?: (handle: ProjectHandle) => void | Promise<void>;
  abort?: () => void | Promise<void>;
  close?: () => void | Promise<void>;
}

function fakeService(
  events: string[],
  name: string,
  opts: FakeServiceOptions = {}
): ProjectBoundService<Loaded, OpenRequest> {
  return {
    name,
    mode: opts.mode ?? 'required',
    openTimeoutMs: opts.openTimeoutMs,
    closeTimeoutMs: opts.closeTimeoutMs,
    open: (handle) => {
      events.push(`open:${name}:${label(handle.path)}`);
      return opts.open?.(handle);
    },
    abort: () => {
      events.push(`abort:${name}`);
      return opts.abort?.();
    },
    close: () => {
      events.push(`close:${name}`);
      return opts.close?.();
    },
  };
}

function lifecycle(
  manager: FakeManager,
  services: ProjectBoundService<Loaded, OpenRequest>[],
  timeouts?: ProjectLifecycleOptions<Loaded, OpenRequest>['timeouts']
) {
  return createProjectLifecycle<Loaded, OpenRequest>({ manager, services, timeouts });
}

const request: OpenRequest = { tag: 'ipc' };

let consoleError: MockInstance<typeof console.error>;
let consoleWarn: MockInstance<typeof console.warn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Tout ce que la console a reçu, en une seule chaîne : le nom du service doit y être. */
function logged(spy: MockInstance<typeof console.error>): string {
  return spy.mock.calls
    .map((args: unknown[]) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    .join('\n');
}

describe('projectLifecycle — contrat', () => {
  it('le port se branche tel quel sur ProjectManager, une fois close() ajouté (seconde partie)', () => {
    type ManagerLoaded = Awaited<ReturnType<ProjectManager['loadProject']>>;
    expectTypeOf<ProjectManager & { close(): void }>().toExtend<ProjectManagerPort<ManagerLoaded>>();
  });
});

describe('projectLifecycle — ouverture', () => {
  it('ouvre les services dans l’ordre, avec le handle du dossier et le contexte de la demande', async () => {
    const events: string[] = [];
    const manager = fakeManager(events, { [A]: {} });
    const seen: Array<{ path: string; loaded: Loaded; request: OpenRequest }> = [];
    const spy: ProjectBoundService<Loaded, OpenRequest> = {
      name: 'journal',
      mode: 'required',
      open: (handle, ctx) => {
        seen.push({ path: handle.path, loaded: ctx.loaded, request: ctx.request });
      },
    };
    const lc = lifecycle(manager, [fakeService(events, 'history'), spy, fakeService(events, 'pdf')]);

    const result = await lc.open(A, request);

    expect(result).toEqual({ success: true, project: { name: 'A' }, warnings: [] });
    expect(events).toEqual(['load:A', 'open:history:A', 'open:pdf:A']);
    expect(seen).toEqual([{ path: '/projets/A', loaded: { success: true, project: { name: 'A' } }, request }]);
    expect(lc.current()?.path).toBe('/projets/A');
  });

  it('échec de pdf sur B : A est rouvert et restoredPath vaut A', async () => {
    const events: string[] = [];
    const manager = fakeManager(events, { [A]: {}, [B]: {} });
    const lc = lifecycle(manager, [
      fakeService(events, 'history'),
      fakeService(events, 'pdf', {
        open: (handle) => {
          if (handle.path.endsWith('B')) throw new Error('index illisible');
        },
      }),
    ]);
    await lc.open(A, request);
    events.length = 0;

    const result = await lc.open(B, request);

    expect(result).toEqual({
      success: false,
      code: 'services_failed',
      error: 'index illisible',
      restoredPath: '/projets/A',
    });
    expect(events).toEqual([
      // A se ferme…
      'abort:pdf',
      'abort:history',
      'close:pdf',
      'close:history',
      'manager:close',
      // … B s'ouvre et échoue sur pdf, qui a pu s'ouvrir à moitié : tout ce qui a été ouvert se ferme…
      'load:B',
      'open:history:B',
      'open:pdf:B',
      'abort:pdf',
      'abort:history',
      'close:pdf',
      'close:history',
      'manager:close',
      // … et A revient, services compris.
      'load:A',
      'open:history:A',
      'open:pdf:A',
    ]);
    expect(lc.current()?.path).toBe('/projets/A');
    expect(manager.current()).toBe('/projets/A');
    // Le nom du service va au journal du processus, pas dans la réponse.
    expect(logged(consoleError)).toContain('pdf');
    expect(logged(consoleError)).toContain('index illisible');
  });

  it('échec aussi sur A : restoredPath null et current() null', async () => {
    const events: string[] = [];
    const manager = fakeManager(events, { [A]: {}, [B]: {} });
    let opensOfA = 0;
    const lc = lifecycle(manager, [
      fakeService(events, 'history'),
      fakeService(events, 'pdf', {
        open: (handle) => {
          if (handle.path.endsWith('A') && ++opensOfA === 1) return;
          throw new Error('disque plein');
        },
      }),
    ]);
    await lc.open(A, request);
    const handleOfA = lc.current();

    const result = await lc.open(B, request);

    expect(result).toEqual({ success: false, code: 'services_failed', error: 'disque plein', restoredPath: null });
    expect(lc.current()).toBeNull();
    expect(manager.current()).toBeNull();
    expect(handleOfA?.isCurrent()).toBe(false);
    // La tentative de retour sur A a refermé ce qu'elle avait ouvert.
    expect(events.slice(-6)).toEqual([
      'open:pdf:A',
      'abort:pdf',
      'abort:history',
      'close:pdf',
      'close:history',
      'manager:close',
    ]);
  });

  it('un refus du gestionnaire après la fermeture de A rouvre A, et garde son code', async () => {
    const events: string[] = [];
    const manager = fakeManager(events, { [A]: {}, [B]: { unwritable: true } });
    const lc = lifecycle(manager, [fakeService(events, 'history')]);
    await lc.open(A, request);
    events.length = 0;

    const result = await lc.open(B, request);

    expect(result).toEqual({
      success: false,
      code: 'manifest_unwritable',
      fileName: 'project.json',
      error: 'EROFS',
      restoredPath: '/projets/A',
    });
    expect(events).toEqual(['abort:history', 'close:history', 'manager:close', 'load:A', 'open:history:A']);
    expect(lc.current()?.path).toBe('/projets/A');
  });

  it('préflight refusé : A reste intact, services compris', async () => {
    const events: string[] = [];
    const manager = fakeManager(events, { [A]: {}, [B]: { unreadable: true } });
    const lc = lifecycle(manager, [fakeService(events, 'history'), fakeService(events, 'pdf')]);
    await lc.open(A, request);
    const handleOfA = lc.current();
    events.length = 0;

    const result = await lc.open(B, request);

    expect(result).toEqual({
      success: false,
      code: 'manifest_unreadable',
      fileName: 'project.json',
      error: 'JSON invalide',
      restoredPath: '/projets/A',
    });
    expect(events).toEqual([]);
    expect(manager.loadCalls).toEqual([A]);
    expect(manager.current()).toBe('/projets/A');
    expect(lc.current()).toBe(handleOfA);
    expect(handleOfA?.signal.aborted).toBe(false);
    expect(handleOfA?.isCurrent()).toBe(true);
  });

  it('best-effort en échec : un avertissement dans la réponse, le projet s’ouvre', async () => {
    const events: string[] = [];
    const manager = fakeManager(events, { [A]: {} });
    const lc = lifecycle(manager, [
      fakeService(events, 'history'),
      fakeService(events, 'tropy', {
        mode: 'best-effort',
        open: () => Promise.reject(new Error('tpy introuvable')),
      }),
      fakeService(events, 'pdf'),
    ]);

    const result = await lc.open(A, request);

    expect(result).toEqual({ success: true, project: { name: 'A' }, warnings: ['tropy'] });
    expect(events).toEqual(['load:A', 'open:history:A', 'open:tropy:A', 'open:pdf:A']);
    expect(lc.current()?.path).toBe('/projets/A');
    expect(logged(consoleWarn)).toContain('tropy');
    expect(logged(consoleWarn)).toContain('tpy introuvable');
  });

  it('background : lancé sans attente, après les autres, et son erreur journalisée', async () => {
    const events: string[] = [];
    const manager = fakeManager(events, { [A]: {} });
    const failed = deferred();
    const lc = lifecycle(manager, [
      fakeService(events, 'history'),
      // Ne répond jamais : l'ouverture n'a pas à l'attendre.
      fakeService(events, 'mcp', { mode: 'background', open: never }),
      fakeService(events, 'reading-notes', {
        mode: 'background',
        open: async () => {
          failed.resolve();
          throw new Error('embeddings indisponibles');
        },
      }),
      fakeService(events, 'pdf'),
    ]);

    const result = await lc.open(A, request);
    await failed.promise;
    // L'erreur est journalisée dans la tâche de fond, après son rejet.
    await vi.waitFor(() => expect(logged(consoleWarn)).toContain('embeddings indisponibles'));

    expect(result).toEqual({ success: true, project: { name: 'A' }, warnings: [] });
    expect(events).toEqual(['load:A', 'open:history:A', 'open:pdf:A', 'open:mcp:A', 'open:reading-notes:A']);
    expect(logged(consoleWarn)).toContain('reading-notes');
  });

  it('deux open concurrents sont sérialisés, dans l’ordre d’arrivée', async () => {
    const events: string[] = [];
    const manager = fakeManager(events, { [A]: {}, [B]: {} });
    const entered = deferred();
    const release = deferred();
    const lc = lifecycle(manager, [
      fakeService(events, 'history', {
        open: (handle) => {
          if (!handle.path.endsWith('A')) return undefined;
          entered.resolve();
          return release.promise;
        },
      }),
    ]);

    const first = lc.open(A, request);
    const second = lc.open(B, request);
    await entered.promise;
    // A s'ouvre encore : B n'a même pas été lu.
    expect(manager.metadataCalls).toEqual([A]);
    expect(manager.loadCalls).toEqual([A]);

    release.resolve();
    const [resultA, resultB] = await Promise.all([first, second]);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
    expect(events).toEqual([
      'load:A',
      'open:history:A',
      'abort:history',
      'close:history',
      'manager:close',
      'load:B',
      'open:history:B',
    ]);
    expect(lc.current()?.path).toBe('/projets/B');
  });

  describe('rouvrir le même projet', () => {
    let root: string;

    beforeEach(() => {
      root = mkdtempSync(path.join(os.tmpdir(), 'cliodeck-lifecycle-'));
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('n’appelle aucun close ni aucun open de service : le manifeste seul est relu', async () => {
      const real = path.join(root, 'Projet');
      mkdirSync(real);
      // Un autre chemin vers le même dossier : seule une comparaison par le disque les rapproche.
      const viaLink = path.join(root, 'lien');
      symlinkSync(real, viaLink);
      const realFile = path.join(real, 'project.json');
      const linkFile = path.join(viaLink, 'project.json');
      const events: string[] = [];
      const manager = fakeManager(events, { [realFile]: {}, [linkFile]: {} });
      const lc = lifecycle(manager, [fakeService(events, 'history'), fakeService(events, 'pdf')]);
      await lc.open(realFile, request);
      const handle = lc.current();
      events.length = 0;

      // Le cas réel : le style CSL change, et le renderer rouvre le projet courant.
      const result = await lc.open(linkFile, request);

      expect(result).toEqual({ success: true, project: { name: 'lien' }, warnings: [] });
      expect(manager.loadCalls).toEqual([realFile, linkFile]);
      expect(events).toEqual(['load:lien']);
      expect(lc.current()).toBe(handle);
      expect(handle?.signal.aborted).toBe(false);
      expect(handle?.isCurrent()).toBe(true);
    });
  });
});

describe('projectLifecycle — fermeture', () => {
  it('ferme dans l’ordre : signal du handle, abort(), close() en ordre inverse, puis le gestionnaire', async () => {
    const events: string[] = [];
    const manager = fakeManager(events, { [A]: {} });
    let handle: ProjectHandle | null = null;
    const abortedBeforeAbort: boolean[] = [];
    const lc = lifecycle(
      manager,
      ['history', 'mode', 'journal', 'pdf'].map((name) =>
        fakeService(events, name, {
          abort: () => {
            abortedBeforeAbort.push(handle?.signal.aborted ?? false);
          },
        })
      )
    );
    await lc.open(A, request);
    handle = lc.current();
    events.length = 0;

    await lc.close();

    expect(events).toEqual([
      'abort:pdf',
      'abort:journal',
      'abort:mode',
      'abort:history',
      'close:pdf',
      'close:journal',
      'close:mode',
      'close:history',
      'manager:close',
    ]);
    expect(abortedBeforeAbort).toEqual([true, true, true, true]);
    expect(handle?.signal.aborted).toBe(true);
    expect(handle?.isCurrent()).toBe(false);
    expect(lc.current()).toBeNull();
    expect(manager.current()).toBeNull();
  });

  it('assertCurrent lève ProjectChangedError (« project-changed ») après une bascule', async () => {
    const events: string[] = [];
    const manager = fakeManager(events, { [A]: {}, [B]: {} });
    const lc = lifecycle(manager, [fakeService(events, 'history')]);
    await lc.open(A, request);
    const handleOfA = lc.current();
    expect(() => handleOfA?.assertCurrent()).not.toThrow();

    await lc.open(B, request);
    const handleOfB = lc.current();

    let thrown: unknown = null;
    try {
      handleOfA?.assertCurrent();
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectChangedError);
    // Le mot que l'IPC renvoie déjà (L05) et que le renderer reconnaît : un seul refus.
    expect((thrown as ProjectChangedError).code).toBe('project-changed');
    expect((thrown as ProjectChangedError).message).toBe('project-changed');
    expect(handleOfA?.signal.aborted).toBe(true);
    expect(() => handleOfB?.assertCurrent()).not.toThrow();
    expect(handleOfB?.epoch).toBeGreaterThan(handleOfA?.epoch ?? Infinity);
  });

  it('un close qui lève n’empêche pas les autres', async () => {
    const events: string[] = [];
    const manager = fakeManager(events, { [A]: {} });
    const lc = lifecycle(manager, [
      fakeService(events, 'history'),
      fakeService(events, 'pdf', {
        close: () => {
          throw new Error('base verrouillée');
        },
      }),
      fakeService(events, 'tropy', { close: () => Promise.reject(new Error('worker mort')) }),
    ]);
    await lc.open(A, request);
    events.length = 0;

    await expect(lc.close()).resolves.toBeUndefined();

    expect(events.filter((e) => e.startsWith('close:') || e === 'manager:close')).toEqual([
      'close:tropy',
      'close:pdf',
      'close:history',
      'manager:close',
    ]);
    expect(logged(consoleError)).toContain('base verrouillée');
    expect(logged(consoleError)).toContain('worker mort');
    expect(logged(consoleError)).toContain('pdf');
  });

  it('un close qui ne rend jamais la main ne bloque pas la file : l’ouverture suivante passe', async () => {
    const events: string[] = [];
    const manager = fakeManager(events, { [A]: {}, [B]: {} });
    const lc = lifecycle(manager, [
      fakeService(events, 'history'),
      // Le pire cas attendu : un drain qui ne finit pas. Son délai est injecté, tout petit.
      fakeService(events, 'operations', { close: never, closeTimeoutMs: 1 }),
    ]);
    await lc.open(A, request);
    events.length = 0;

    const closing = lc.close();
    const reopening = lc.open(B, request);

    await expect(closing).resolves.toBeUndefined();
    await expect(reopening).resolves.toEqual({ success: true, project: { name: 'B' }, warnings: [] });
    expect(events).toEqual([
      'abort:operations',
      'abort:history',
      'close:operations',
      'close:history',
      'manager:close',
      'load:B',
      'open:history:B',
      'open:operations:B',
    ]);
    expect(lc.current()?.path).toBe('/projets/B');
    expect(logged(consoleWarn)).toContain('operations');
  });

  it('un open qui ne rend jamais la main compte comme un échec, sans bloquer la file', async () => {
    const events: string[] = [];
    const manager = fakeManager(events, { [A]: {}, [B]: {}, [C]: {} });
    const lc = lifecycle(manager, [
      fakeService(events, 'history'),
      fakeService(events, 'pdf', {
        openTimeoutMs: 1,
        open: (handle) => (handle.path.endsWith('B') ? never() : undefined),
      }),
    ]);
    await lc.open(A, request);

    const result = await lc.open(B, request);

    expect(result).toMatchObject({ success: false, code: 'services_failed', restoredPath: '/projets/A' });
    expect(lc.current()?.path).toBe('/projets/A');
    expect(logged(consoleError)).toContain('pdf');
    await expect(lc.open(C, request)).resolves.toMatchObject({ success: true });
    expect(lc.current()?.path).toBe('/projets/C');
  });

  it('les abort() sont bornés à 5 s par défaut : la fermeture continue après', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const manager = fakeManager(events, { [A]: {} });
    const lc = lifecycle(manager, [fakeService(events, 'chat', { abort: never })]);
    await lc.open(A, request);
    events.length = 0;

    const closing = lc.close();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(events).toEqual(['abort:chat']);

    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(events).toEqual(['abort:chat', 'close:chat', 'manager:close']);
    expect(logged(consoleWarn)).toContain('chat');
  });
});
