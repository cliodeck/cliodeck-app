/**
 * `project:create`, `project:load` et `project:close` passent par une seule séquence (L03-3).
 *
 * Les vrais handlers, le vrai gestionnaire de projet sur un vrai disque, la vraie séquence et sa
 * table de services. Simulés : les services du projet, qui inscrivent chaque ouverture et chaque
 * fermeture dans `events`. Le service PDF est le vrai, sur un magasin simulé : c'est lui dont la
 * fermeture n'était pas attendue (S01-1-9), et sa reprise après une attente qu'il faut juger.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { RebuildProgressEvent } from '../../../../../backend/types/rebuild-progress.js';

interface FakeStore {
  path: string;
  closed: boolean;
  close: () => void;
  countDuplicateDocuments: () => number;
}

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  events: [] as string[],
  stores: [] as FakeStore[],
  progressCallbacks: new Map<string, (p: RebuildProgressEvent) => void>(),
  indexJobs: [] as Array<{ resolve: () => void }>,
  windowSends: [] as Array<[string, unknown]>,
}));

const label = (p: string): string => path.basename(p);

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: (channel: string, payload: unknown) => h.windowSends.push([channel, payload]),
        },
      },
    ],
    getFocusedWindow: () => null,
  },
  app: { isPackaged: false, getPath: () => os.tmpdir() },
}));
vi.mock('../../../services/config-manager.js', () => ({
  configManager: {
    addRecentProject: vi.fn(),
    removeRecentProject: vi.fn(),
    getRecentProjects: () => [],
    getLLMConfig: () => ({ backend: 'ollama', ollamaURL: 'http://127.0.0.1:9', ollamaEmbeddingModel: 'nomic' }),
    getRAGConfig: () => ({ topK: 10 }),
    get: () => ({}),
  },
}));
vi.mock('../../../services/history-service.js', () => ({
  historyService: {
    init: vi.fn(async (p: string) => {
      h.events.push(`open:history:${label(p)}`);
    }),
    close: vi.fn(() => {
      h.events.push('close:history');
    }),
    getHistoryManager: () => null,
  },
}));
vi.mock('../../../services/usage-journal-service.js', () => ({
  usageJournalService: {
    init: vi.fn((p: string) => {
      h.events.push(`open:usage:${label(p)}`);
    }),
    close: vi.fn(() => {
      h.events.push('close:usage');
    }),
  },
}));
vi.mock('../../../services/mode-service.js', () => ({
  modeService: {
    init: vi.fn((p: string) => {
      h.events.push(`open:mode:${label(p)}`);
    }),
    close: vi.fn(() => {
      h.events.push('close:mode');
    }),
  },
}));
vi.mock('../../../services/tropy-service.js', () => ({
  tropyService: {
    init: vi.fn(async (p: string) => {
      h.events.push(`open:tropy:${label(p)}`);
    }),
    close: vi.fn(async () => {
      h.events.push('close:tropy');
    }),
  },
}));
vi.mock('../../../services/retrieval-service.js', () => ({
  retrievalService: {
    configure: vi.fn(),
    clear: vi.fn(() => {
      h.events.push('close:retrieval');
    }),
    drainSearches: vi.fn(async () => undefined),
  },
}));
vi.mock('../../../services/manuscript-index-service.js', () => ({
  manuscriptIndexService: {
    configure: vi.fn((p: string | null) => {
      if (p) h.events.push(`open:manuscript:${label(p)}`);
    }),
    purgeOutside: vi.fn(() => 0),
    clear: vi.fn(),
  },
}));
vi.mock('../../../services/reading-notes-indexing.js', () => ({ indexReadingNotesInBackground: vi.fn() }));
vi.mock('../../../services/mcp-clients-service.js', () => ({
  mcpClientsService: {
    loadProject: vi.fn(async (p: string) => {
      h.events.push(`mcp:load:${label(p)}`);
    }),
    unload: vi.fn(async () => {
      h.events.push('mcp:unload');
    }),
  },
}));
// Le vrai service PDF, sur un magasin simulé, sans fournisseur sur le réseau.
vi.mock('../../../../../backend/core/llm/providers/cliodeck-config-adapter.js', () => ({
  createRegistryFromClioDeckConfig: () => ({
    getLLM: () => ({}),
    getEmbedding: () => ({ embed: async () => [[0.1]] }),
    dispose: async () => undefined,
  }),
}));
vi.mock('../../../services/pdf/PdfVectorStore.js', () => ({
  PdfVectorStore: {
    create: (projectPath: string, _rag: unknown, opts: { onRebuildProgress?: (p: RebuildProgressEvent) => void }) => {
      h.events.push(`open:pdf:${label(projectPath)}`);
      const store: FakeStore = {
        path: projectPath,
        closed: false,
        close: () => {
          store.closed = true;
          h.events.push('close:pdf');
        },
        countDuplicateDocuments: () => 0,
      };
      h.stores.push(store);
      if (opts.onRebuildProgress) h.progressCallbacks.set(label(projectPath), opts.onRebuildProgress);
      return { store, useEnhanced: true, initPromise: undefined };
    },
    configureEnhanced: vi.fn(),
    maybeRebuild: async () => undefined,
  },
}));
vi.mock('../../../services/pdf/PdfIndexer.js', () => ({
  PdfIndexer: class {
    indexPDF = vi.fn(
      () =>
        new Promise((resolve) => {
          h.indexJobs.push({ resolve: () => resolve({ id: 'doc' }) });
        })
    );
  },
}));
vi.mock('../../../services/pdf-extract-isolated.js', () => ({ extractPdfIsolated: vi.fn() }));

import { setupProjectHandlers } from '../project-handlers.js';
import { projectManager } from '../../../services/project-manager.js';
import { pdfService } from '../../../services/pdf-service.js';
import { usageJournalService } from '../../../services/usage-journal-service.js';
import { mcpClientsService } from '../../../services/mcp-clients-service.js';
import { retrievalService } from '../../../services/retrieval-service.js';
import { operations } from '../../../services/cancellable-operation.js';
import { projectServices } from '../../../services/project-services.js';
import { bibliographyService } from '../../../services/bibliography-service.js';

let workDir: string;
let sends: Array<[string, unknown]>;
let senderDestroyed: boolean;

interface Reply {
  success: boolean;
  code?: string;
  error?: string;
  restoredPath?: string | null;
}

function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`canal non enregistré : ${channel}`);
  const sender = {
    send: (c: string, payload: unknown) => sends.push([c, payload]),
    isDestroyed: () => senderDestroyed,
  };
  return handler({ sender }, ...args) as Promise<T>;
}

function makeProject(name: string): string {
  const dir = path.join(workDir, name);
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ name, type: 'article' }));
  writeFileSync(path.join(dir, 'document.md'), `# ${name}\n`);
  return path.join(dir, 'project.json');
}

/** Laisse passer les tâches en file sans avancer d'horloge. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/**
 * Attend `condition`, au plus `ms` : un chargement lit le disque, et ses étapes ne tiennent pas en
 * quelques microtâches. Ne lève pas : l'assertion qui suit dit ce qui manque.
 */
async function until(condition: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!condition() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
}

function watch<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    }
  );
  return { promise, settled: () => done };
}

beforeEach(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), 'cliodeck-sequence-'));
  h.events.length = 0;
  h.stores.length = 0;
  h.indexJobs.length = 0;
  h.windowSends.length = 0;
  h.progressCallbacks.clear();
  sends = [];
  senderDestroyed = false;
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  h.handlers.clear();
  setupProjectHandlers();
});

afterEach(async () => {
  // Une indexation laissée en vol par un test en échec ferait attendre chaque fermeture qui suit.
  for (const job of h.indexJobs) job.resolve();
  await call('project:close');
  vi.restoreAllMocks();
  await rm(workDir, { recursive: true, force: true });
});

describe('project:create — le projet créé a ses services, comme à l’ouverture', () => {
  it('le journal d’usage s’ouvre sur le projet créé (S11-1-4)', async () => {
    const created = await call<Reply>('project:create', { name: 'C', type: 'article', path: workDir });

    expect(created.success).toBe(true);
    expect(usageJournalService.init).toHaveBeenCalledWith(path.join(workDir, 'C'));
    expect(projectManager.getCurrentProjectPath()).toBe(path.join(workDir, 'C'));
  });

  it('un projet créé charge ses clients MCP sans attendre, comme avant (A10)', async () => {
    await call('project:create', { name: 'C', type: 'article', path: workDir });
    await settle();

    expect(mcpClientsService.loadProject).toHaveBeenCalledWith(path.join(workDir, 'C'));
  });

  it('un refus de création arrive avant toute fermeture : le projet ouvert reste, services compris', async () => {
    const fileA = makeProject('A');
    await call('project:load', fileA);
    h.events.length = 0;

    const refused = await call<Reply>('project:create', { name: 'A', type: 'article', path: workDir });

    expect(refused).toMatchObject({ success: false, error: 'project_exists' });
    expect(h.events).toEqual([]);
    expect(projectManager.getCurrentProjectPath()).toBe(path.dirname(fileA));
  });
});

describe('project:load — la bascule', () => {
  it('n’appelle pas mcpClientsService.loadProject, et décharge le projet précédent (A10)', async () => {
    await call('project:create', { name: 'A', type: 'article', path: workDir });
    await settle();
    const fileB = makeProject('B');
    h.events.length = 0;
    vi.mocked(mcpClientsService.loadProject).mockClear();

    const loaded = await call<Reply>('project:load', fileB);
    await settle();

    expect(loaded.success).toBe(true);
    expect(mcpClientsService.loadProject).not.toHaveBeenCalled();
    expect(h.events).toContain('mcp:unload');
    expect(h.events.indexOf('mcp:unload')).toBeLessThan(h.events.indexOf('open:history:B'));
  });

  it('les services de A se ferment avant que ceux de B s’ouvrent ; les journaux se ferment après pdf', async () => {
    await call('project:load', makeProject('A'));
    const fileB = makeProject('B');
    h.events.length = 0;

    await call('project:load', fileB);

    const firstOpenB = h.events.findIndex((e) => e.startsWith('open:') && e.endsWith(':B'));
    const closes = h.events.map((e, i) => (e.startsWith('close:') ? i : -1)).filter((i) => i >= 0);
    expect(firstOpenB).toBeGreaterThan(-1);
    expect(Math.max(...closes)).toBeLessThan(firstOpenB);
    expect(h.events.indexOf('close:pdf')).toBeGreaterThan(-1);
    expect(h.events.indexOf('close:history')).toBeGreaterThan(h.events.indexOf('close:pdf'));
    expect(h.events.indexOf('close:usage')).toBeGreaterThan(h.events.indexOf('close:pdf'));
  });

  it('la reconstruction de l’index de A ne parle plus à l’écran une fois B ouvert', async () => {
    await call('project:load', makeProject('A'));
    const progressOfA = h.progressCallbacks.get('A');
    await call('project:load', makeProject('B'));
    sends.length = 0;

    progressOfA?.({ current: 90, total: 100, status: 'Error', percentage: 90, phase: 'failed', error: 'disque' });

    expect(sends.filter(([channel]) => channel === 'project:rebuild-progress')).toEqual([]);
  });

  it('une fenêtre détruite ne reçoit pas le suivi de reconstruction', async () => {
    await call('project:load', makeProject('A'));
    senderDestroyed = true;

    h.progressCallbacks.get('A')?.({ current: 10, total: 100, status: 'x', percentage: 10, phase: 'running' });

    expect(sends).toEqual([]);
  });
});

describe('un tour de chat pendant la bascule (A17, Q11)', () => {
  it('annulé, il finit d’écrire dans les journaux de A avant leur fermeture', async () => {
    await call('project:load', makeProject('A'));
    // Comme `fusionChatService.start` : un tour de portée projet, qui écrit ses journaux en finissant.
    const turn = operations.begin('chat', { runId: 'tour-en-cours' });
    turn.signal.addEventListener('abort', () => {
      setTimeout(() => {
        h.events.push('chat:journal');
        turn.finish();
      }, 20);
    });
    h.events.length = 0;

    await call('project:load', makeProject('B'));

    expect(turn.cancelReason).toBe('project-closed');
    expect(h.events.indexOf('chat:journal')).toBeGreaterThan(-1);
    expect(h.events.indexOf('chat:journal')).toBeLessThan(h.events.indexOf('close:history'));
    expect(h.events.indexOf('chat:journal')).toBeLessThan(h.events.indexOf('close:usage'));
  });
});

/**
 * La bibliographie du main est celle que le renderer lui fait lire à l'ouverture d'un projet
 * (`bibliography:load-with-metadata`). L'aperçu des citations et les exports PDF et Word la
 * consultent. Elle survivait au changement de projet : un projet sans `.bib` résolvait les clés
 * avec celle du précédent (S07-1-31).
 */
describe('la bibliographie du main suit le projet (S07-1-31)', () => {
  const BIB = '@book{Dupont_1990,\n  author = {Dupont, Jean},\n  title = {Le préfet et la grève},\n  year = {1990}\n}\n';

  /** A, avec son `.bib` lu comme à l'ouverture côté renderer. */
  async function openAWithBibliography(): Promise<string> {
    const fileA = makeProject('A');
    const bibA = path.join(path.dirname(fileA), 'a.bib');
    writeFileSync(bibA, BIB);
    await call('project:load', fileA);
    await bibliographyService.loadFromFile(bibA);
    expect(bibliographyService.getByCitationKey('Dupont_1990')?.title).toBe('Le préfet et la grève');
    return fileA;
  }

  it('ouvrir B après A : plus aucune clé de A ne se résout', async () => {
    await openAWithBibliography();

    await call('project:load', makeProject('B'));

    expect(bibliographyService.getCitations()).toEqual([]);
    expect(bibliographyService.getByCitationKey('Dupont_1990')).toBeUndefined();
    expect(bibliographyService.getCitationByKey('Dupont_1990')).toBeUndefined();
  });

  it('fermer le projet : plus aucune clé ne se résout', async () => {
    await openAWithBibliography();

    await call('project:close');

    expect(bibliographyService.getByCitationKey('Dupont_1990')).toBeUndefined();
  });

  it('le même projet rouvert (style CSL) garde sa bibliographie : ses services ne se ferment pas', async () => {
    const fileA = await openAWithBibliography();

    await call('project:load', fileA);

    expect(bibliographyService.getByCitationKey('Dupont_1990')?.title).toBe('Le préfet et la grève');
  });

  it('B échoue et A revient : ses services se sont fermés, sa bibliographie aussi (le renderer la renvoie)', async () => {
    const fileA = await openAWithBibliography();
    const fileB = makeProject('B');
    // B ne s'ouvre pas : un service requis échoue, et la séquence rouvre A.
    const { tropyService } = await import('../../../services/tropy-service.js');
    vi.mocked(tropyService.init).mockImplementationOnce(async () => {
      throw new Error('panne');
    });

    const refused = await call<Reply>('project:load', fileB);

    expect(refused).toMatchObject({ success: false, restoredPath: path.dirname(fileA) });
    // Le renderer, qui sait que A revient (`restoredPath`), la lui fait relire : `projectStore`.
    expect(bibliographyService.getCitations()).toEqual([]);
  });

  it('« Nouveau projet » au nom de A, refusé : le main garde la bibliographie de A, et la réponse ne porte pas restoredPath', async () => {
    await openAWithBibliography();

    const refused = await call<Reply>('project:create', { name: 'A', type: 'article', path: workDir });

    expect(refused).toMatchObject({ success: false, error: 'project_exists' });
    // Le renderer ne relit rien sans `restoredPath` : `projectStore`, `restorePreviousProject`.
    expect(refused).not.toHaveProperty('restoredPath');
    expect(bibliographyService.getByCitationKey('Dupont_1990')?.title).toBe('Le préfet et la grève');
  });

  it('la table : les journaux s’ouvrent en premier, les opérations en dernier, la bibliographie entre les deux', () => {
    const names = projectServices().map((service) => service.name);

    expect(names.slice(0, 2)).toEqual(['historyService', 'usageJournalService']);
    expect(names.at(-1)).toBe('operations');
    expect(names).toContain('bibliography');
    // Fermée après les opérations (un tour de chat qui finit), avant les journaux.
    expect(names.indexOf('bibliography')).toBeLessThan(names.indexOf('operations'));
    expect(names.indexOf('bibliography')).toBeGreaterThan(names.indexOf('usageJournalService'));
  });
});

describe('project:close — fermer ferme vraiment', () => {
  it('appelle unload et retrievalService.clear, et ne répond qu’une fois pdfService.close résolu', async () => {
    await call('project:load', makeProject('A'));
    const indexing = pdfService.indexPDF('/A/long.pdf');

    const closing = watch(call('project:close'));
    await settle();
    expect(closing.settled()).toBe(false);
    expect(h.stores[0].closed).toBe(false);

    h.indexJobs[0].resolve();
    await indexing;
    await closing.promise;

    expect(h.stores[0].closed).toBe(true);
    expect(mcpClientsService.unload).toHaveBeenCalled();
    expect(retrievalService.clear).toHaveBeenCalled();
  });

  it('getCurrentProjectPath() vaut null après project:close (S11-1-20)', async () => {
    await call('project:load', makeProject('A'));

    await call('project:close');

    expect(projectManager.getCurrentProjectPath()).toBeNull();
  });

  it('fermer puis ouvrir B pendant une indexation : B s’ouvre du premier coup (S01-1-9)', async () => {
    await call('project:load', makeProject('A'));
    const indexing = pdfService.indexPDF('/A/long.pdf');
    const fileB = makeProject('B');

    const closing = call('project:close');
    await settle();
    const loading = call<Reply>('project:load', fileB);
    // Avant : la fermeture répondait aussitôt, et l'ouverture de B arrivait jusqu'au service PDF,
    // qui attendait la même indexation que lui. Après : B attend la fin de la fermeture, en file.
    await until(() => h.events.includes('open:tropy:B'), 3_000);
    await settle();
    h.indexJobs[0].resolve();
    await indexing;
    await closing;
    const loaded = await loading;

    expect(loaded).toMatchObject({ success: true });
    expect(pdfService.getCurrentProjectPath()).toBe(path.dirname(fileB));
    expect(h.stores.map((s) => [label(s.path), s.closed])).toEqual([
      ['A', true],
      ['B', false],
    ]);
  });
});

describe('fermeture d’office', () => {
  /**
   * Par les vrais handlers et le vrai gestionnaire : le chargement de B ne répond pas à temps, C
   * s'ouvre, puis B finit, fait basculer le gestionnaire, et C ne se recharge plus. La séquence ferme
   * tout ; sans le relais branché, l'écran garderait C et le validateur refuserait ses écritures.
   */
  it('une vraie fermeture d’office par la séquence atteint le renderer (project:closed)', async () => {
    h.handlers.clear();
    // Assez long pour qu'un chargement réel de C finisse à temps sous charge ; B, lui, est retenu.
    setupProjectHandlers({ timeouts: { managerMs: 1_000 } });
    const fileA = makeProject('A');
    const fileB = makeProject('B');
    const fileC = makeProject('C');
    await call('project:load', fileA);
    let releaseB!: () => void;
    const heldB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let refuseC = false;
    const load = projectManager.loadProject.bind(projectManager);
    vi.spyOn(projectManager, 'loadProject').mockImplementation(async (file: string) => {
      if (file === fileB) await heldB;
      if (refuseC && file === fileC) {
        return { success: false, code: 'manifest_unwritable' as const, fileName: 'project.json', error: 'EROFS' };
      }
      return load(file);
    });

    const late = await call<Reply>('project:load', fileB);
    expect(late).toMatchObject({ success: false, code: 'project_unavailable', restoredPath: null });
    await expect(call<Reply>('project:load', fileC)).resolves.toMatchObject({ success: true });
    h.windowSends.length = 0;

    refuseC = true;
    releaseB();

    await until(() => h.windowSends.some(([channel]) => channel === 'project:closed'), 5_000);
    expect(h.windowSends).toEqual([
      ['project:closed', { path: path.dirname(fileC), code: 'manifest_unwritable', error: 'EROFS' }],
    ]);
    expect(projectManager.getCurrentProjectPath()).toBeNull();
  });

  it('le renderer l’apprend : project:closed, avec le chemin et le code à traduire', async () => {
    const { relayUnrequestedClose } = await import('../project-handlers.js');

    relayUnrequestedClose({ path: '/projets/A', code: 'project_unavailable', error: 'timeout' });

    expect(h.windowSends).toEqual([
      ['project:closed', { path: '/projets/A', code: 'project_unavailable', error: 'timeout' }],
    ]);
  });
});
