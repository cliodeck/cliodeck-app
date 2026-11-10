/**
 * Les services liés au projet ouvert, dans l'ordre où la séquence les ouvre (L03-3). Elle les
 * ferme dans l'ordre inverse : les journaux (recherche, usage IA) s'ouvrent les premiers, donc se
 * ferment les derniers, et reçoivent ce que les autres écrivent en s'arrêtant ; les opérations en
 * cours (un tour de chat) s'arrêtent les premières.
 *
 * `.cliodeck` lié hors du projet (D18) : seul le service des modes s'ouvre, comme avant, ses modes
 * vivant hors de `.cliodeck`. Aucun autre n'ouvre une base, un index ou un journal à travers le lien.
 *
 * Les clients MCP ne démarrent pas à l'ouverture (A10) : leur chargement passe par une approbation,
 * et la rc.6 ne lance aucun processus tiers en ouvrant un projet. La table les décharge seulement, à
 * la bascule et à la fermeture.
 */
import type { RebuildProgressEvent } from '../../../backend/types/rebuild-progress.js';
import type { ProjectHandle } from '../../../backend/types/project-handle.js';
import type { ProjectManager } from './project-manager.js';
import type { ProjectBoundService, ServiceOpenContext } from './project-lifecycle.js';
import { historyService } from './history-service.js';
import { usageJournalService } from './usage-journal-service.js';
import { modeService } from './mode-service.js';
import { tropyService } from './tropy-service.js';
import { retrievalService } from './retrieval-service.js';
import { pdfService } from './pdf-service.js';
import { manuscriptIndexService } from './manuscript-index-service.js';
import { indexReadingNotesInBackground } from './reading-notes-indexing.js';
import { mcpClientsService } from './mcp-clients-service.js';
import { bibliographyService } from './bibliography-service.js';
import { operations } from './cancellable-operation.js';

/** Ce que rend `ProjectManager.loadProject` : la séquence le passe à chaque service. */
export type LoadedProject = Awaited<ReturnType<ProjectManager['loadProject']>>;

/** Ce que l'appelant d'une ouverture passe aux services : le suivi de reconstruction de l'index. */
export interface ProjectOpenRequest {
  onRebuildProgress?: (progress: RebuildProgressEvent) => void;
}

type Service = ProjectBoundService<LoadedProject, ProjectOpenRequest>;
type Context = ServiceOpenContext<LoadedProject, ProjectOpenRequest>;

/**
 * L'ouverture du service PDF : `EnhancedVectorStore.initialize` peut reconstruire tout l'index HNSW
 * depuis SQLite (index absent, abîmé, ou d'une autre dimension). Mesuré le 2026-11-10 sur un corpus
 * fabriqué (extraits de 768 dimensions, Apple M5 Pro) : 35 s pour 20 000 extraits, 103 s pour
 * 50 000, 224 s pour 100 000 (environ 800 PDF). Dix minutes laissent à ce dernier une marge de
 * 2,7 pour une machine plus lente (un Mac Intel). Au-delà, l'ouverture compte comme un échec et le
 * projet d'avant revient ; les 60 s par défaut de la séquence n'y suffiraient pas dès 30 000.
 */
export const PDF_OPEN_TIMEOUT_MS = 10 * 60_000;

/** Ce qu'une fermeture attend des opérations de portée projet : un tour de chat qui finit d'écrire. */
const OPERATIONS_DRAIN_MS = 30_000;

/**
 * Un service du projet n'a pas démarré. `project.json` n'y est pour rien : la réponse le dit par
 * son code, et le journal du processus principal nomme le service, dont la cause technique ne va
 * pas dans l'alerte.
 */
export class ProjectServiceError extends Error {
  readonly service: string;
  readonly cause: unknown;

  constructor(service: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'ProjectServiceError';
    this.service = service;
    this.cause = cause;
  }
}

async function startService(service: string, start: () => unknown): Promise<void> {
  try {
    await start();
  } catch (error: unknown) {
    throw new ProjectServiceError(service, error);
  }
}

const linkedOutside = (ctx: Context): boolean => ctx.loaded.configIssue?.kind === 'linked_outside';

/**
 * Rouvrir le projet ouvert ne relit que son manifeste (le style CSL), sauf si l'état de son
 * `config.json` a changé depuis l'ouverture de ses services. Les bandeaux de `configIssue` disent
 * « … puis rouvrez le projet » : un `.cliodeck` lié dehors n'ouvre que les modes, et un `config.json`
 * illisible fige le mode d'inspection des sources sur le plus strict (`refreshInspectorMode`, lu à
 * l'ouverture du service PDF). Relu seul, le projet réparé gardait ses services d'avant (le journal
 * d'usage IA fermé, la recherche PDF « not initialized ») jusqu'au redémarrage, sans bandeau.
 */
export function servicesNeedReopen(opened: LoadedProject, reloaded: LoadedProject): boolean {
  return (opened.configIssue?.kind ?? null) !== (reloaded.configIssue?.kind ?? null);
}

/**
 * Le suivi de reconstruction ne parle qu'au projet de son ouverture : celle de A, finie après la
 * bascule, publierait son échec sur l'écran de B.
 */
function progressFor(handle: ProjectHandle, ctx: Context): ((p: RebuildProgressEvent) => void) | undefined {
  const send = ctx.request.onRebuildProgress;
  if (!send) return undefined;
  return (progress) => {
    if (handle.isCurrent()) send(progress);
  };
}

/** La table, dans l'ordre d'ouverture. */
export function projectServices(): Service[] {
  /** Un service qui ne s'ouvre pas à travers un `.cliodeck` lié dehors. */
  const unlessLinked =
    (name: string, open: (handle: ProjectHandle, ctx: Context) => unknown) =>
    (handle: ProjectHandle, ctx: Context): Promise<void> | undefined =>
      linkedOutside(ctx) ? undefined : startService(name, () => open(handle, ctx));

  return [
    {
      name: 'historyService',
      mode: 'required',
      open: unlessLinked('historyService', (handle) => historyService.init(handle.path)),
      close: () => historyService.close(),
    },
    {
      name: 'usageJournalService',
      mode: 'required',
      open: unlessLinked('usageJournalService', (handle) => usageJournalService.init(handle.path)),
      close: () => usageJournalService.close(),
    },
    {
      name: 'modeService',
      mode: 'required',
      // Les modes du projet vivent hors de `.cliodeck` (`cliodeck-data/modes`) : même lié dehors.
      open: (handle) => startService('modeService', () => modeService.init(handle.path)),
      close: () => modeService.close(),
    },
    {
      name: 'tropyService',
      mode: 'required',
      open: unlessLinked('tropyService', (handle) => tropyService.init(handle.path, handle)),
      close: () => tropyService.close(),
    },
    {
      // Configuré par le service PDF ; sa fermeture rend les bases du coffre, du manuscrit et des
      // notes de lecture (S02-1-17).
      name: 'retrievalService',
      mode: 'required',
      close: () => retrievalService.clear(),
    },
    {
      name: 'pdfService',
      mode: 'required',
      openTimeoutMs: PDF_OPEN_TIMEOUT_MS,
      open: unlessLinked('pdfService', (handle, ctx) =>
        pdfService.init(handle.path, progressFor(handle, ctx), handle)
      ),
      close: () => pdfService.close(),
    },
    {
      // Un chapitre indexé puis devenu lien sortant : ses extraits partent avant la première
      // question, sans attendre une sauvegarde.
      name: 'manuscriptIndexService',
      mode: 'required',
      open: unlessLinked('manuscriptIndexService', (handle) => {
        manuscriptIndexService.configure(handle.path);
        manuscriptIndexService.purgeOutside();
      }),
    },
    {
      // Une note éditée hors de ClioDeck (Obsidian) entre deux sessions.
      name: 'readingNotes',
      mode: 'background',
      open: unlessLinked('readingNotes', () => indexReadingNotesInBackground('ouverture du projet')),
    },
    {
      // Ce que le renderer lui fait lire à l'ouverture (`bibliography:load-with-metadata`), pour
      // l'aperçu des citations et les exports. Oubliée à la bascule et à la fermeture : un projet sans
      // `.bib` résolvait ses clés avec celle du précédent (S07-1-31). Le renderer la renvoie quand le
      // projet d'avant revient après un échec, ses services ayant été fermés puis rouverts.
      name: 'bibliography',
      mode: 'required',
      close: () => bibliographyService.forget(),
    },
    {
      // Déchargés à la bascule et à la fermeture ; jamais chargés ici (A10).
      name: 'mcpClientsService',
      mode: 'best-effort',
      close: () => mcpClientsService.unload(),
    },
    {
      // Ce qui court pour ce projet (un tour de chat) s'arrête, puis finit d'écrire dans ses
      // journaux, encore ouverts : la réponse partielle reste au journal du projet quitté (Q11).
      name: 'operations',
      mode: 'required',
      abort: () => {
        operations.cancelScope('project', 'project-closed');
      },
      close: async () => {
        const drained = await operations.drain('project', OPERATIONS_DRAIN_MS);
        if (!drained) {
          console.warn(
            `⚠️ [project-services] des opérations du projet tournaient encore après ${OPERATIONS_DRAIN_MS} ms : fermeture malgré tout`
          );
        }
      },
    },
  ];
}
