/**
 * La séquence d'ouverture et de fermeture d'un projet côté main (L03-3, première partie).
 *
 * De faux services et un faux gestionnaire de projet : la séquence n'en importe aucun, et c'est
 * son ordre qu'on juge ici. Chaque appel s'inscrit dans `events`. Les attentes bornées se jugent
 * avec un service qui ne répond jamais et un délai injecté (ou de faux minuteurs) : le test attend
 * le résultat, jamais un délai réel.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi, type MockInstance } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, type EncodingOption, type PathLike } from 'fs';
import os from 'os';
import path from 'path';
import { ProjectChangedError, type ProjectHandle } from '../../../../backend/types/project-handle.js';
import { symlinkAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';
import type { ProjectManager } from '../project-manager.js';
import {
  createProjectLifecycle,
  type ProjectBoundService,
  type ProjectLifecycleOptions,
  type ProjectManagerPort,
  type ProjectServiceMode,
  type UnrequestedClose,
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
  /**
   * `loadProject` attend cette promesse avant de rien décider : une migration de l'espace de
   * travail qui dure. Comme `ProjectManager.loadProject`, il ne bascule qu'à la fin.
   */
  hold?: Promise<void>;
  /** Appelé au début de `loadProject` : le volume qui tombe pendant le chargement. */
  onLoad?: () => void;
}

type FakeManager = ProjectManagerPort<Loaded> & {
  current: () => string | null;
  metadataCalls: string[];
  loadCalls: string[];
  /** Les `loadProject` qui ont fini, réussis ou non, dans l'ordre. */
  loadsSettled: string[];
  /** Le plus grand nombre de `loadProject` qui ont couru ensemble. */
  maxLoadsInFlight: () => number;
  /** La prochaine fermeture attend `gate` avant de rien changer. */
  holdNextClose: (gate: Promise<void>) => void;
};

function fakeManager(events: string[], projects: Record<string, FakeProject>): FakeManager {
  let current: string | null = null;
  const metadataCalls: string[] = [];
  const loadCalls: string[] = [];
  const loadsSettled: string[] = [];
  let loadsInFlight = 0;
  let maxLoadsInFlight = 0;
  let nextCloseGate: Promise<void> | null = null;
  const closeNow = (): void => {
    current = null;
    events.push('manager:close');
  };
  return {
    current: () => current,
    metadataCalls,
    loadCalls,
    loadsSettled,
    maxLoadsInFlight: () => maxLoadsInFlight,
    holdNextClose: (gate) => {
      nextCloseGate = gate;
    },
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
      loadsInFlight += 1;
      maxLoadsInFlight = Math.max(maxLoadsInFlight, loadsInFlight);
      projects[projectFile]?.onLoad?.();
      try {
        const hold = projects[projectFile]?.hold;
        if (hold) await hold;
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
      } finally {
        loadsInFlight -= 1;
        loadsSettled.push(projectFile);
      }
    },
    getCurrentProjectPath: () => current,
    close() {
      const gate = nextCloseGate;
      nextCloseGate = null;
      if (gate) return gate.then(closeNow);
      closeNow();
      return undefined;
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
  timeouts?: ProjectLifecycleOptions<Loaded, OpenRequest>['timeouts'],
  onUnrequestedClose?: (closed: UnrequestedClose) => void
) {
  return createProjectLifecycle<Loaded, OpenRequest>({ manager, services, timeouts, onUnrequestedClose });
}

/** Suit une promesse sans l'attendre : sous faux minuteurs, dit si elle a fini sans avancer l'horloge. */
function watch<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  return { promise, settled: () => settled };
}

/**
 * Un volume qui ne répond plus (NAS injoignable, montage NFS dur) : un `realpath` synchrone dessous
 * gèlerait le main, et aucune borne de la séquence ne tomberait pendant ce temps. Chacun est donc
 * compté, puis échoue ; un test exige qu'il n'y en ait aucun.
 */
function deadVolume(prefix: string): { kill: () => void; syncCalls: string[] } {
  let dead = false;
  const syncCalls: string[] = [];
  const original = realpathSync.native;
  const realpathOrHang = (target: PathLike, options?: EncodingOption): string => {
    if (dead && String(target).startsWith(prefix)) {
      syncCalls.push(String(target));
      throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
    }
    return original(target, options);
  };
  vi.spyOn(realpathSync, 'native').mockImplementation(realpathOrHang as typeof realpathSync.native);
  return {
    kill: () => {
      dead = true;
    },
    syncCalls,
  };
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

  it('refuse à la construction un délai sans borne ou hors de ce que setTimeout accepte', () => {
    const events: string[] = [];
    const manager = fakeManager(events, { [A]: {} });
    // Node ramène à 1 ms tout délai au-delà de 2^31-1, Infinity compris : « pas de plafond » ferait
    // échouer l'ouverture aussitôt. Et une attente sans plafond serait une attente sans sortie.
    for (const bad of [Infinity, Number.NaN, 2 ** 31, 0, -1]) {
      expect(() => lifecycle(manager, [fakeService(events, 'pdf', { openTimeoutMs: bad })])).toThrow(RangeError);
      expect(() => lifecycle(manager, [fakeService(events, 'pdf', { closeTimeoutMs: bad })])).toThrow(RangeError);
      expect(() => lifecycle(manager, [], { managerMs: bad })).toThrow(RangeError);
    }
    expect(() => lifecycle(manager, [], { abortMs: Infinity })).toThrow(/abortMs/);
    expect(() => lifecycle(manager, [fakeService(events, 'pdf', { openTimeoutMs: 2 ** 31 - 1 })])).not.toThrow();
  });

  it('un délai de séquence passé à undefined garde sa valeur par défaut', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const manager = fakeManager(events, { [A]: {} });
    const lc = lifecycle(manager, [fakeService(events, 'chat', { abort: never })], { abortMs: undefined });
    await lc.open(A, request);
    events.length = 0;

    const closing = lc.close();
    // Pas 1 ms : les 5 s par défaut.
    await vi.advanceTimersByTimeAsync(4_999);
    expect(events).toEqual(['abort:chat']);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(events).toEqual(['abort:chat', 'close:chat', 'manager:close']);
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

  it('ni close() ni une bascule demandée n’appellent onUnrequestedClose : leur réponse suffit', async () => {
    const events: string[] = [];
    const manager = fakeManager(events, { [A]: {}, [B]: {}, [C]: { unwritable: true } });
    const unrequested = vi.fn<(closed: UnrequestedClose) => void>();
    const lc = lifecycle(manager, [fakeService(events, 'history')], undefined, unrequested);
    await lc.open(A, request);
    await lc.open(B, request);
    await lc.open(C, request);
    await lc.close();

    expect(lc.current()).toBeNull();
    expect(unrequested).not.toHaveBeenCalled();
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

/**
 * Le gestionnaire qui ne répond pas à temps : son appel continue, et finit plus tard. Le délai est
 * injecté, tout petit ; le chargement retenu ne finit que quand le test le libère, si bien que le
 * délai tombe toujours, quelle que soit la charge de la machine.
 */
describe('projectLifecycle — gestionnaire en retard', () => {
  it('B sans réponse à temps : A n’est pas rouvert, et restoredPath vaut null', async () => {
    const events: string[] = [];
    const held = deferred();
    const manager = fakeManager(events, { [A]: {}, [B]: { hold: held.promise } });
    const lc = lifecycle(manager, [fakeService(events, 'history')], { managerMs: 5 });
    await lc.open(A, request);

    const result = await lc.open(B, request);

    expect(result).toEqual({ success: false, code: 'project_unavailable', error: 'timeout', restoredPath: null });
    // Le gestionnaire peut encore basculer sur B : rouvrir A maintenant mettrait les services de A sur B.
    expect(manager.loadCalls).toEqual([A, B]);
    expect(lc.current()).toBeNull();
    expect(events).not.toContain('open:history:B');

    held.resolve();
    // Sa fin tardive ne laisse pas le main sur B, qu'aucune ouverture n'a gardé.
    await vi.waitFor(() => expect(events.slice(-2)).toEqual(['load:B', 'manager:close']));
    expect(manager.current()).toBeNull();
  });

  it('la fin tardive du chargement de B ne fait pas basculer le main : il revient sur C, ouvert entre-temps', async () => {
    const events: string[] = [];
    const held = deferred();
    const manager = fakeManager(events, { [A]: {}, [B]: { hold: held.promise }, [C]: {} });
    const lc = lifecycle(manager, [fakeService(events, 'history')], { managerMs: 5 });
    await lc.open(A, request);
    await lc.open(B, request);

    // B ne finit pas : un autre projet s'ouvre quand même, sans quitter l'app.
    await expect(lc.open(C, request)).resolves.toMatchObject({ success: true });
    expect(manager.current()).toBe('/projets/C');

    held.resolve();
    // B finit : le gestionnaire bascule un instant, puis revient sur le projet de la séquence.
    await vi.waitFor(() => expect(manager.loadCalls).toEqual([A, B, C, C]));
    await vi.waitFor(() => expect(manager.current()).toBe('/projets/C'));
    expect(lc.current()?.path).toBe('/projets/C');
    // Aucun service ne s'est ouvert sur B, et le retour du gestionnaire n'en a rouvert aucun.
    expect(events.filter((e) => e.startsWith('open:'))).toEqual(['open:history:A', 'open:history:C']);
  });

  it('un nouvel essai sur B pendant que son chargement court ne relance pas de loadProject', async () => {
    const events: string[] = [];
    const held = deferred();
    const manager = fakeManager(events, { [A]: {}, [B]: { hold: held.promise } });
    const lc = lifecycle(manager, [fakeService(events, 'history')], { managerMs: 5 });
    await lc.open(A, request);
    await lc.open(B, request);

    // Deux migrations du même `.cliodeck` en même temps, sans verrou : jamais.
    const retry = await lc.open(B, request);

    expect(retry).toEqual({ success: false, code: 'project_unavailable', error: 'timeout', restoredPath: null });
    expect(manager.loadCalls).toEqual([A, B]);
    expect(manager.maxLoadsInFlight()).toBe(1);

    held.resolve();
    await vi.waitFor(() => expect(events.slice(-2)).toEqual(['load:B', 'manager:close']));
    expect(lc.current()).toBeNull();
    // Une fois le premier chargement fini, B s'ouvre normalement.
    await expect(lc.open(B, request)).resolves.toMatchObject({ success: true });
    expect(manager.current()).toBe('/projets/B');
    expect(lc.current()?.path).toBe('/projets/B');
  });

  describe.skipIf(!symlinkAvailable)('sur le disque : une autre graphie du même dossier', () => {
    let root: string;

    beforeEach(() => {
      root = mkdtempSync(path.join(os.tmpdir(), 'cliodeck-lifecycle-'));
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    /** Un dossier de projet et un lien vers lui : deux graphies, un seul dossier sur le disque. */
    function projectWithLink(name: string): { realFile: string; linkFile: string; linkDir: string } {
      const real = path.join(root, name);
      mkdirSync(real);
      const linkDir = path.join(root, `lien-${name}`);
      symlinkSync(real, linkDir);
      return { realFile: path.join(real, 'project.json'), linkFile: path.join(linkDir, 'project.json'), linkDir };
    }

    it('un nouvel essai sur B par un lien, son chargement en cours : refusé, sans second loadProject', async () => {
      const { realFile, linkFile } = projectWithLink('B');
      const events: string[] = [];
      const held = deferred();
      const manager = fakeManager(events, {
        [A]: {},
        [realFile]: { hold: held.promise },
        [linkFile]: { hold: held.promise },
        [C]: {},
      });
      const lc = lifecycle(manager, [fakeService(events, 'history')], { managerMs: 5 });
      await lc.open(A, request);
      await expect(lc.open(realFile, request)).resolves.toMatchObject({ code: 'project_unavailable' });
      await expect(lc.open(C, request)).resolves.toMatchObject({ success: true });
      const handleOfC = lc.current();

      // Même `.cliodeck`, autre chaîne : deux migrations du même dossier en même temps, jamais. Et le
      // refus se sait avant de rien fermer : C reste ouvert.
      const retry = await lc.open(linkFile, request);

      expect(retry).toEqual({
        success: false,
        code: 'project_unavailable',
        error: 'timeout',
        restoredPath: '/projets/C',
      });
      // Aucun chargement par le lien : C, autre dossier, a pu se charger pendant celui de B.
      expect(manager.loadCalls).toEqual([A, realFile, C]);
      expect(lc.current()).toBe(handleOfC);
      held.resolve();
      await vi.waitFor(() => expect(manager.loadCalls).toEqual([A, realFile, C, C]));
      await vi.waitFor(() => expect(manager.current()).toBe('/projets/C'));
    });

    it('la remise d’accord reconnaît le projet ouvert sous une autre graphie : aucun rechargement', async () => {
      const { realFile, linkFile, linkDir } = projectWithLink('P');
      const X = '/projets/X/project.json';
      const events: string[] = [];
      const heldX = deferred();
      // X ne répond pas à temps, puis finit en échec : le gestionnaire reste où il est.
      const manager = fakeManager(events, {
        [X]: { hold: heldX.promise, unwritable: true },
        [realFile]: {},
        [linkFile]: {},
      });
      const lc = lifecycle(manager, [fakeService(events, 'history')], { managerMs: 5 });
      await expect(lc.open(X, request)).resolves.toMatchObject({ code: 'project_unavailable' });
      await expect(lc.open(realFile, request)).resolves.toMatchObject({ success: true });
      // Le style CSL : le projet se rouvre par le lien, et le gestionnaire garde cette graphie.
      await expect(lc.open(linkFile, request)).resolves.toMatchObject({ success: true });
      expect(manager.current()).toBe(linkDir);

      heldX.resolve();
      await vi.waitFor(() => expect(manager.loadsSettled).toContain(X));
      // Mise en file après la remise d'accord que la fin de X a lancée.
      await lc.close();

      expect(manager.loadCalls).toEqual([X, realFile, linkFile]);
    });
  });

  it('un chargement qui finit pendant l’attente du suivant : aucun chevauchement', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const held = deferred();
    const manager = fakeManager(events, { [A]: {}, [B]: { hold: held.promise }, [C]: {} });
    const lc = lifecycle(manager, [fakeService(events, 'history')], { managerMs: 1_000 });
    await lc.open(A, request);
    const openingB = lc.open(B, request);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(openingB).resolves.toMatchObject({ code: 'project_unavailable' });

    const openingC = lc.open(C, request);
    await vi.advanceTimersByTimeAsync(10);
    // C attend la fin de B avant de rien charger.
    expect(manager.loadCalls).toEqual([A, B]);

    held.resolve();
    await expect(openingC).resolves.toMatchObject({ success: true });
    expect(manager.maxLoadsInFlight()).toBe(1);
    expect(manager.current()).toBe('/projets/C');
    expect(lc.current()?.path).toBe('/projets/C');
  });

  it('une fermeture du gestionnaire en retard ne ferme pas le projet ouvert après elle', async () => {
    const events: string[] = [];
    const gate = deferred();
    const manager = fakeManager(events, { [A]: {}, [B]: {} });
    const lc = lifecycle(manager, [fakeService(events, 'history')], { closeMs: 5, managerMs: 5 });
    await lc.open(A, request);
    manager.holdNextClose(gate.promise);

    await lc.close();
    await expect(lc.open(B, request)).resolves.toMatchObject({ success: true });

    gate.resolve();
    // La fermeture tardive vide le gestionnaire ; il revient sur B.
    await vi.waitFor(() => expect(manager.loadCalls).toEqual([A, B, B]));
    await vi.waitFor(() => expect(manager.current()).toBe('/projets/B'));
    expect(lc.current()?.path).toBe('/projets/B');
  });

  it('si le projet de la séquence ne se recharge pas après une bascule tardive, tout est fermé', async () => {
    const events: string[] = [];
    const held = deferred();
    const projects: Record<string, FakeProject> = { [A]: {}, [B]: { hold: held.promise }, [C]: {} };
    const manager = fakeManager(events, projects);
    const unrequested = vi.fn<(closed: UnrequestedClose) => void>();
    const lc = lifecycle(manager, [fakeService(events, 'history')], { managerMs: 5 }, unrequested);
    await lc.open(A, request);
    await lc.open(B, request);
    await lc.open(C, request);
    const handleOfC = lc.current();
    projects[C].unwritable = true;

    held.resolve();

    // Le main ne reste ni sur B, que le renderer ne croit pas ouvert, ni à moitié sur C.
    await vi.waitFor(() => expect(manager.current()).toBeNull());
    expect(lc.current()).toBeNull();
    expect(handleOfC?.signal.aborted).toBe(true);
    expect(events.slice(-3)).toEqual(['abort:history', 'close:history', 'manager:close']);
    expect(logged(consoleError)).toContain('/projets/C');
    // Personne ne l'a demandé : le renderer, qui croit C ouvert, l'apprend par là.
    expect(unrequested.mock.calls).toEqual([[{ path: '/projets/C', code: 'manifest_unwritable', error: 'EROFS' }]]);
  });

  it('un rechargement de remise d’accord sans réponse à temps ferme tout, une seule fois', async () => {
    const events: string[] = [];
    const heldB = deferred();
    const heldC = deferred();
    const projects: Record<string, FakeProject> = { [A]: {}, [B]: { hold: heldB.promise }, [C]: {} };
    const manager = fakeManager(events, projects);
    const unrequested = vi.fn<(closed: UnrequestedClose) => void>(() => {
      // Le relais vers le renderer peut échouer (fenêtre fermée) : la séquence n'en dépend pas.
      throw new Error('fenêtre détruite');
    });
    const lc = lifecycle(manager, [fakeService(events, 'history')], { managerMs: 5 }, unrequested);
    await lc.open(A, request);
    await lc.open(B, request);
    await lc.open(C, request);
    const handleOfC = lc.current();
    // Le volume de C se dégrade : son rechargement sera lent, puis refusé.
    projects[C] = { hold: heldC.promise, unwritable: true };

    heldB.resolve();

    // B finit, le gestionnaire bascule sur B ; le rechargement de C ne répond pas à temps : tout se
    // ferme, plutôt que de laisser le main sur B pendant que le handle et les services sont sur C.
    await vi.waitFor(() => expect(lc.current()).toBeNull());
    expect(manager.current()).toBeNull();
    expect(handleOfC?.signal.aborted).toBe(true);
    expect(unrequested.mock.calls).toEqual([[{ path: '/projets/C', code: 'project_unavailable', error: 'timeout' }]]);

    // Le rechargement en retard finit en échec : rien ne le relance.
    heldC.resolve();
    await vi.waitFor(() => expect(manager.loadsSettled.filter((file) => file === C)).toHaveLength(2));
    // Mise en file après la remise d'accord que cette fin a lancée : elle a donc fini.
    projects[C] = {};
    await expect(lc.open(A, request)).resolves.toMatchObject({ success: true });
    expect(manager.loadCalls).toEqual([A, B, C, C, A]);
    expect(unrequested).toHaveBeenCalledTimes(1);
    expect(logged(consoleError)).toContain('fenêtre détruite');
  });

  it('un nouvel essai sur B, encore en chargement, laisse C ouvert et intact', async () => {
    const events: string[] = [];
    const held = deferred();
    const manager = fakeManager(events, { [A]: {}, [B]: { hold: held.promise }, [C]: {} });
    const lc = lifecycle(manager, [fakeService(events, 'history')], { managerMs: 5 });
    await lc.open(A, request);
    await lc.open(B, request);
    await expect(lc.open(C, request)).resolves.toMatchObject({ success: true });
    const handleOfC = lc.current();
    events.length = 0;

    const retry = await lc.open(B, request);

    // Refusé comme un préflight, avant de rien fermer : le refus se savait d'avance.
    expect(retry).toEqual({
      success: false,
      code: 'project_unavailable',
      error: 'timeout',
      restoredPath: '/projets/C',
    });
    expect(events).toEqual([]);
    expect(manager.loadCalls).toEqual([A, B, C]);
    // Pas même relu : son volume ne répond peut-être plus.
    expect(manager.metadataCalls).toEqual([A, B, C]);
    expect(lc.current()).toBe(handleOfC);
    expect(handleOfC?.isCurrent()).toBe(true);
    expect(manager.current()).toBe('/projets/C');

    held.resolve();
    await vi.waitFor(() => expect(manager.loadCalls).toEqual([A, B, C, C]));
    await vi.waitFor(() => expect(manager.current()).toBe('/projets/C'));
    expect(lc.current()).toBe(handleOfC);
  });

  it('un chargement sans fin n’est attendu qu’une fois : ni bascule ni fermeture ne le réattendent', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const D = '/projets/D/project.json';
    const manager = fakeManager(events, { [A]: {}, [B]: { hold: never() }, [C]: {}, [D]: {} });
    // Les délais par défaut : 30 s pour le gestionnaire.
    const lc = lifecycle(manager, [fakeService(events, 'history')]);
    await lc.open(A, request);
    const openingB = lc.open(B, request);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(openingB).resolves.toMatchObject({ code: 'project_unavailable' });

    // Une fermeture ne l'attend pas : si B finit après elle, la remise d'accord referme.
    const firstClose = watch(lc.close());
    await vi.advanceTimersByTimeAsync(0);
    expect(firstClose.settled()).toBe(true);

    // La première ouverture qui suit l'attend, une fois, au plus 30 s…
    const openingC = watch(lc.open(C, request));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(openingC.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(openingC.promise).resolves.toMatchObject({ success: true });

    // … puis plus jamais : ni la bascule suivante, ni la fermeture, sans avancer l'horloge.
    const openingD = watch(lc.open(D, request));
    await vi.advanceTimersByTimeAsync(0);
    expect(openingD.settled()).toBe(true);
    await expect(openingD.promise).resolves.toMatchObject({ success: true });
    const closing = watch(lc.close());
    await vi.advanceTimersByTimeAsync(0);
    expect(closing.settled()).toBe(true);
    expect(manager.current()).toBeNull();
  });

  it('volume perdu pendant un chargement : ouvrir un autre projet, ou réessayer, n’y touche plus', async () => {
    const events: string[] = [];
    const NAS_B = '/NAS/B/project.json';
    const volume = deadVolume('/NAS');
    // Le préflight a lu le manifeste ; le volume tombe pendant le chargement, qui ne finit jamais.
    const manager = fakeManager(events, { [A]: {}, [NAS_B]: { hold: never(), onLoad: volume.kill }, [C]: {} });
    const lc = lifecycle(manager, [fakeService(events, 'history')], { managerMs: 5 });
    await lc.open(A, request);
    await expect(lc.open(NAS_B, request)).resolves.toMatchObject({ code: 'project_unavailable' });

    // C s'ouvre sans un seul appel synchrone au volume perdu : un seul gèlerait le main, hors de
    // toute borne de la séquence.
    await expect(lc.open(C, request)).resolves.toMatchObject({ success: true });
    expect(volume.syncCalls).toEqual([]);

    // Réessayer B : refusé sans relire son manifeste ni toucher au volume, et C reste ouvert.
    await expect(lc.open(NAS_B, request)).resolves.toMatchObject({
      code: 'project_unavailable',
      restoredPath: '/projets/C',
    });
    expect(volume.syncCalls).toEqual([]);
    expect(lc.current()?.path).toBe('/projets/C');
  });

  it('le volume du projet ouvert tombe : en ouvrir un autre n’y touche pas', async () => {
    const events: string[] = [];
    const NAS_A = '/NAS/A/project.json';
    const volume = deadVolume('/NAS');
    const manager = fakeManager(events, { [NAS_A]: {}, [C]: {} });
    const lc = lifecycle(manager, [fakeService(events, 'history')]);
    await lc.open(NAS_A, request);
    volume.kill();

    await expect(lc.open(C, request)).resolves.toMatchObject({ success: true });

    expect(volume.syncCalls).toEqual([]);
  });
});
