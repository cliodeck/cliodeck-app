/**
 * Quitter l'application ferme le projet ouvert, dans une échéance (L03-9 ; S11-1-6).
 *
 * `before-quit` vidait l'éditeur, arrêtait le service des thèmes, puis appelait `app.exit()` sans
 * rien fermer d'autre : la session du journal de recherche restait « Active », sans durée, et les
 * derniers événements du journal d'usage, encore en tampon, étaient perdus. Cmd+Q est la façon
 * ordinaire de finir une journée.
 *
 * Le piège : les deux journaux s'ouvrent les premiers, donc se ferment les derniers. Un service
 * qui ne répond pas devant eux ne doit pas les faire sauter quand l'échéance tombe.
 *
 * Trois étages : `shutdownApp` et le gestionnaire de `before-quit` sur de faux arrêts ; puis la
 * vraie séquence et la vraie table des services du projet, dont seuls les services sont simulés
 * (chacun inscrit ses ouvertures et fermetures dans `events`). Faux minuteurs : le test attend le
 * résultat, jamais un délai réel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';

const h = vi.hoisted(() => ({
  events: [] as string[],
  /** Remplace la décharge des clients MCP : `never` pour une fermeture sans réponse. */
  mcpUnload: null as null | (() => Promise<void>),
  /** Remplace l'ouverture du service PDF : une reconstruction d'index qui dure. */
  pdfInit: null as null | (() => Promise<void>),
}));

vi.mock('../services/history-service.js', () => ({
  historyService: {
    init: vi.fn(async () => {
      h.events.push('open:history');
    }),
    close: vi.fn(() => {
      h.events.push('close:history');
    }),
  },
}));
vi.mock('../services/usage-journal-service.js', () => ({
  usageJournalService: {
    init: vi.fn(() => {
      h.events.push('open:usage');
    }),
    close: vi.fn(() => {
      h.events.push('close:usage');
    }),
  },
}));
vi.mock('../services/mode-service.js', () => ({
  modeService: {
    init: vi.fn(() => {
      h.events.push('open:mode');
    }),
    close: vi.fn(() => {
      h.events.push('close:mode');
    }),
  },
}));
vi.mock('../services/tropy-service.js', () => ({
  tropyService: {
    init: vi.fn(async () => {
      h.events.push('open:tropy');
    }),
    close: vi.fn(async () => {
      h.events.push('close:tropy');
    }),
  },
}));
vi.mock('../services/retrieval-service.js', () => ({
  retrievalService: {
    clear: vi.fn(() => {
      h.events.push('close:retrieval');
    }),
  },
}));
vi.mock('../services/pdf-service.js', () => ({
  pdfService: {
    init: vi.fn(async () => {
      h.events.push('open:pdf');
      await h.pdfInit?.();
    }),
    close: vi.fn(async () => {
      h.events.push('close:pdf');
    }),
  },
}));
vi.mock('../services/manuscript-index-service.js', () => ({
  manuscriptIndexService: {
    configure: vi.fn(() => {
      h.events.push('open:manuscript');
    }),
    purgeOutside: vi.fn(() => 0),
  },
}));
vi.mock('../services/reading-notes-indexing.js', () => ({ indexReadingNotesInBackground: vi.fn() }));
vi.mock('../services/mcp-clients-service.js', () => ({
  mcpClientsService: {
    unload: vi.fn(async () => {
      h.events.push('close:mcp');
      await h.mcpUnload?.();
    }),
  },
}));
vi.mock('../services/bibliography-service.js', () => ({
  bibliographyService: {
    forget: vi.fn(() => {
      h.events.push('close:bibliography');
    }),
  },
}));

import { createQuitHandler, QUIT_DEADLINE_MS, shutdownApp, type ShutdownParts } from '../services/app-shutdown.js';
import { createProjectLifecycle, type ProjectManagerPort } from '../services/project-lifecycle.js';
import { projectServices, type LoadedProject, type ProjectOpenRequest } from '../services/project-services.js';
import { operations } from '../services/cancellable-operation.js';

const PROJECT = '/projets/These/project.json';
const never = (): Promise<void> => new Promise<void>(() => undefined);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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

const quitEvent = () => ({ preventDefault: vi.fn() });

beforeEach(() => {
  h.events.length = 0;
  h.mcpUnload = null;
  h.pdfInit = null;
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('shutdownApp — une échéance, quoi qu’il arrive', () => {
  function parts(overrides: Partial<ShutdownParts> = {}): ShutdownParts {
    return {
      stopTopicModeling: vi.fn(async () => undefined),
      closeProject: vi.fn(async () => undefined),
      releaseEmbeddedModels: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  it('un arrêt bloqué : la sortie tombe à l’échéance, nomme ce qui n’a pas fini, et ne rejette pas', async () => {
    vi.useFakeTimers();
    const warn = vi.mocked(console.warn);
    const done = watch(
      shutdownApp({ deadlineMs: QUIT_DEADLINE_MS, ...parts({ stopTopicModeling: never, closeProject: never }) })
    );

    await vi.advanceTimersByTimeAsync(QUIT_DEADLINE_MS - 1);
    expect(done.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(done.settled()).toBe(true);
    const report = await done.promise;
    expect(report.unfinished).toEqual(expect.arrayContaining(['service des thèmes', 'projet']));
    expect(warn.mock.calls.flat().join(' ')).toMatch(/service des thèmes/);
  });

  it('un arrêt qui lève ne retient pas les autres, et la sortie ne rejette pas', async () => {
    vi.useFakeTimers();
    const p = parts({
      stopTopicModeling: async () => {
        throw new Error('python introuvable');
      },
    });

    const report = await shutdownApp({ deadlineMs: QUIT_DEADLINE_MS, ...p });

    expect(report.unfinished).toEqual([]);
    expect(p.closeProject).toHaveBeenCalledTimes(1);
    expect(p.releaseEmbeddedModels).toHaveBeenCalledTimes(1);
  });

  it('le projet a moins que l’échéance : les modèles embarqués se libèrent après lui, avant la sortie', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const project = deferred();
    const p = parts({
      closeProject: vi.fn(async (budgetMs: number) => {
        order.push(`projet:${budgetMs < QUIT_DEADLINE_MS ? 'sous-échéance' : 'trop-long'}`);
        await project.promise;
        order.push('projet:fermé');
      }),
      releaseEmbeddedModels: vi.fn(async () => {
        order.push('modèles');
      }),
    });
    const done = watch(shutdownApp({ deadlineMs: QUIT_DEADLINE_MS, ...p }));

    await vi.advanceTimersByTimeAsync(100);
    expect(order).toEqual(['projet:sous-échéance']);
    project.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(order).toEqual(['projet:sous-échéance', 'projet:fermé', 'modèles']);
    expect(done.settled()).toBe(true);
  });

  it('un projet qui ne finit pas de se fermer ne garde pas les modèles chargés jusqu’à la sortie', async () => {
    vi.useFakeTimers();
    const p = parts({ closeProject: never });
    const done = watch(shutdownApp({ deadlineMs: QUIT_DEADLINE_MS, ...p }));

    await vi.advanceTimersByTimeAsync(QUIT_DEADLINE_MS - 1);

    expect(p.releaseEmbeddedModels).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(done.settled()).toBe(true);
    expect((await done.promise).unfinished).toEqual(['projet']);
  });
});

describe('before-quit — l’éditeur, puis l’arrêt, puis app.exit', () => {
  function steps(overrides: { mayLeave?: () => Promise<boolean>; shutdown?: () => Promise<unknown> } = {}) {
    const order: string[] = [];
    return {
      order,
      mayLeave: vi.fn(async () => {
        order.push('mayLeave');
        return overrides.mayLeave ? overrides.mayLeave() : true;
      }),
      shutdown: vi.fn(async () => {
        order.push('shutdown');
        return overrides.shutdown?.();
      }),
      exit: vi.fn(() => {
        order.push('exit');
      }),
    };
  }

  it('dans l’ordre : le document, puis les services, puis la sortie', async () => {
    const s = steps();
    const onQuit = createQuitHandler(s);
    const event = quitEvent();

    await onQuit(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(s.order).toEqual(['mayLeave', 'shutdown', 'exit']);
  });

  it('un second Cmd+Q pendant l’arrêt ne relance rien', async () => {
    const stopping = deferred();
    const s = steps({ shutdown: () => stopping.promise });
    const onQuit = createQuitHandler(s);

    const first = onQuit(quitEvent());
    await vi.waitFor(() => expect(s.shutdown).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const secondEvent = quitEvent();
    await onQuit(secondEvent);
    stopping.resolve();
    await first;

    // Le second geste est retenu (sinon Electron quitterait sans attendre), mais ne refait rien.
    expect(secondEvent.preventDefault).toHaveBeenCalled();
    expect(s.mayLeave).toHaveBeenCalledTimes(1);
    expect(s.shutdown).toHaveBeenCalledTimes(1);
    expect(s.exit).toHaveBeenCalledTimes(1);
  });

  it('l’auteur choisit de rester : rien ne s’arrête, et un Cmd+Q suivant fonctionne de nouveau', async () => {
    let answer = false;
    const s = steps({ mayLeave: async () => answer });
    const onQuit = createQuitHandler(s);

    await onQuit(quitEvent());
    expect(s.shutdown).not.toHaveBeenCalled();
    expect(s.exit).not.toHaveBeenCalled();

    answer = true;
    await onQuit(quitEvent());
    expect(s.order).toEqual(['mayLeave', 'mayLeave', 'shutdown', 'exit']);
  });

  it('un arrêt qui lève n’empêche pas la sortie', async () => {
    const s = steps({
      shutdown: async () => {
        throw new Error('arrêt impossible');
      },
    });

    await createQuitHandler(s)(quitEvent());

    expect(s.exit).toHaveBeenCalledTimes(1);
  });
});

describe('la vraie table des services : les journaux se ferment dans l’échéance', () => {
  function fakeManager(): ProjectManagerPort<LoadedProject> {
    let current: string | null = null;
    return {
      getProjectMetadata: async () => ({ success: true }),
      loadProject: async (projectFile: string) => {
        current = path.dirname(projectFile);
        h.events.push('manager:load');
        return { success: true } as unknown as LoadedProject;
      },
      getCurrentProjectPath: () => current,
      close: () => {
        current = null;
        h.events.push('manager:close');
      },
    };
  }

  /** `before-quit` tel que `src/main/index.ts` le compose, `app.exit` inscrit dans `events`. */
  function quitHandlerFor(lifecycle: { shutdown(budgetMs: number): Promise<void> }) {
    const exit = vi.fn(() => {
      h.events.push('exit');
    });
    const onQuit = createQuitHandler({
      mayLeave: async () => true,
      shutdown: () =>
        shutdownApp({
          deadlineMs: QUIT_DEADLINE_MS,
          stopTopicModeling: async () => undefined,
          closeProject: (budgetMs) => lifecycle.shutdown(budgetMs),
          releaseEmbeddedModels: async () => undefined,
        }),
      exit,
    });
    return { onQuit, exit };
  }

  function lifecycleOverRealTable() {
    return createProjectLifecycle<LoadedProject, ProjectOpenRequest>({
      manager: fakeManager(),
      services: projectServices(),
    });
  }

  it('un tour de chat qui ne se draine pas et des clients MCP sans réponse : les deux journaux se ferment avant app.exit', async () => {
    vi.useFakeTimers();
    const lifecycle = lifecycleOverRealTable();
    const opened = await lifecycle.open(PROJECT, {});
    expect(opened.success).toBe(true);
    // Un tour de chat qui ignore son annulation, et une fermeture qui ne répond jamais.
    const chatTurn = operations.begin('chat');
    h.mcpUnload = never;
    h.events.length = 0;
    const { onQuit, exit } = quitHandlerFor(lifecycle);

    try {
      const quitting = watch(onQuit(quitEvent()));
      await vi.advanceTimersByTimeAsync(QUIT_DEADLINE_MS);

      expect(quitting.settled()).toBe(true);
      expect(exit).toHaveBeenCalledTimes(1);
      const exitAt = h.events.indexOf('exit');
      expect(h.events.indexOf('close:history')).toBeGreaterThan(-1);
      expect(h.events.indexOf('close:usage')).toBeGreaterThan(-1);
      expect(h.events.indexOf('close:history')).toBeLessThan(exitAt);
      expect(h.events.indexOf('close:usage')).toBeLessThan(exitAt);
      // Les autres aussi, dans l'ordre de la table : les journaux restent les derniers.
      expect(h.events.indexOf('close:pdf')).toBeLessThan(h.events.indexOf('close:usage'));
    } finally {
      chatTurn.finish();
    }
  });

  it('une sortie pendant une ouverture qui dure (index PDF) ne l’attend pas : les journaux se ferment avant app.exit', async () => {
    vi.useFakeTimers();
    const rebuild = deferred();
    h.pdfInit = () => rebuild.promise;
    const lifecycle = lifecycleOverRealTable();
    const opening = watch(lifecycle.open(PROJECT, {}));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.events).toContain('open:pdf');
    h.events.length = 0;
    const { onQuit, exit } = quitHandlerFor(lifecycle);

    const quitting = watch(onQuit(quitEvent()));
    await vi.advanceTimersByTimeAsync(QUIT_DEADLINE_MS);

    expect(quitting.settled()).toBe(true);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(h.events.indexOf('close:history')).toBeGreaterThan(-1);
    expect(h.events.indexOf('close:history')).toBeLessThan(h.events.indexOf('exit'));
    expect(h.events.indexOf('close:usage')).toBeLessThan(h.events.indexOf('exit'));

    // L'ouverture finit après la sortie : elle n'ouvre plus rien, et ne recharge aucun projet.
    h.events.length = 0;
    rebuild.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(opening.settled()).toBe(true);
    expect(h.events.filter((e) => e.startsWith('open:') || e === 'manager:load')).toEqual([]);
  });
});
