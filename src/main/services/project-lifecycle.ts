/**
 * Une seule séquence pour ouvrir, rouvrir et fermer un projet côté main (L03-3).
 *
 * Les handlers ouvraient et fermaient chacun leurs services à leur façon : la création oubliait le
 * journal d'usage, la fermeture n'attendait pas le service PDF, un échec laissait le main sur le
 * projet d'à côté. Ici, une file sérialise toutes les ouvertures et fermetures, dans l'ordre
 * d'arrivée, et chacune suit la même séquence :
 *
 * - ouvrir : lire le manifeste de B sans rien changer (un `project.json` illisible laisse A intact,
 *   services compris) ; le même dossier ne relit que son manifeste (le style CSL) ; sinon fermer A,
 *   charger B, lui donner un nouveau handle et ouvrir ses services dans l'ordre ;
 * - fermer : avorter le signal du handle, appeler tous les `abort()`, puis les `close()` en ordre
 *   inverse d'ouverture, chacun pour soi, et enfin le gestionnaire de projet ;
 * - échouer : un service `required` qui échoue referme tout ce qui a été ouvert et rouvre A ; un
 *   `best-effort` laisse un avertissement ; un `background` est lancé sans attente.
 *
 * Aucune attente sans sortie : la file bloquerait toutes les suivantes, et l'auteur devrait quitter
 * l'app pour ouvrir un projet. Chaque attente est donc bornée, journalisée quand le délai tombe, et
 * la séquence continue : un `open()` sans réponse compte comme un échec, un `close()` comme fait.
 *
 * N'importe aucun service : la table des services et le gestionnaire de projet lui sont passés.
 */
import path from 'path';
import { sameFile } from '../../../backend/core/vector-store/file-identity.js';
import { ProjectChangedError, type ProjectHandle } from '../../../backend/types/project-handle.js';

/**
 * `required` : sans lui le projet ne s'ouvre pas, et A revient. `best-effort` : son échec devient un
 * avertissement. `background` : lancé sans attente, après les autres ; son erreur va au journal.
 */
export type ProjectServiceMode = 'required' | 'best-effort' | 'background';

/** Ce que répond le gestionnaire de projet : un succès, ou un refus qui dit pourquoi. */
export interface ManagerReply {
  success: boolean;
  /** Le code d'un refus (`manifest_unreadable`…), que le renderer traduit. */
  code?: string;
  fileName?: string;
  error?: string;
}

/**
 * Le gestionnaire de projet tel que la séquence le voit. Les noms sont ceux de `ProjectManager`,
 * qui s'y branche tel quel une fois `close()` ajouté.
 */
export interface ProjectManagerPort<TLoaded extends ManagerReply = ManagerReply> {
  /** Lit le manifeste sans rien changer : la garde des deux portes (`readManifestToOpen`). */
  getProjectMetadata(projectFile: string): Promise<ManagerReply>;
  /** Charge le projet et en fait le projet courant. Un refus laisse le projet courant tel quel. */
  loadProject(projectFile: string): Promise<TLoaded>;
  /** Le dossier du projet courant, ou null. */
  getCurrentProjectPath(): string | null;
  /** Plus aucun projet courant. */
  close(): void | Promise<void>;
}

/** Ce que reçoit l'ouverture d'un service, en plus du handle. */
export interface ServiceOpenContext<TLoaded extends ManagerReply = ManagerReply, TRequest = void> {
  /** La réponse du gestionnaire au chargement (`configIssue`…). */
  readonly loaded: TLoaded;
  /** Ce que l'appelant d'`open` a passé, tel quel (le suivi de reconstruction de l'index…). */
  readonly request: TRequest;
}

/**
 * Un service lié au projet ouvert. `abort` coupe ce qui court ; `close` libère, et peut attendre la
 * fin de ce que `abort` a coupé. Les délais remplacent ceux de la séquence pour ce service seul.
 */
export interface ProjectBoundService<TLoaded extends ManagerReply = ManagerReply, TRequest = void> {
  readonly name: string;
  readonly mode: ProjectServiceMode;
  readonly openTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  open?(handle: ProjectHandle, ctx: ServiceOpenContext<TLoaded, TRequest>): void | Promise<void>;
  abort?(): void | Promise<void>;
  close?(): void | Promise<void>;
}

/** Les délais de la séquence, en millisecondes. */
export interface ProjectLifecycleTimeouts {
  /** Chaque `abort()`, tous en même temps. */
  abortMs: number;
  /** Chaque `open()` attendu. */
  openMs: number;
  /** Chaque `close()`, et la fermeture côté gestionnaire. */
  closeMs: number;
  /** Chaque lecture ou chargement du manifeste. */
  managerMs: number;
}

const DEFAULT_TIMEOUTS: ProjectLifecycleTimeouts = {
  abortMs: 5_000,
  openMs: 60_000,
  // Au-delà des 30 s qu'une fermeture attend au pire la fin des travaux en vol.
  closeMs: 35_000,
  managerMs: 30_000,
};

/**
 * Un refus. `restoredPath` dit quel projet est ouvert après lui : celui d'avant, ou null s'il n'a
 * pas pu se rouvrir. Le refus du gestionnaire passe tel quel (`code`, `fileName`) ; un service en
 * panne répond `services_failed`, et son nom ne va qu'au journal du processus.
 */
export type ProjectOpenRefusal = ManagerReply & {
  success: false;
  error: string;
  restoredPath: string | null;
};

/** `warnings` nomme les services `best-effort` qui ne se sont pas ouverts. */
export type ProjectOpenResult<TLoaded extends ManagerReply = ManagerReply> =
  | (TLoaded & { success: true; warnings: string[] })
  | ProjectOpenRefusal;

export interface ProjectLifecycleOptions<TLoaded extends ManagerReply = ManagerReply, TRequest = void> {
  manager: ProjectManagerPort<TLoaded>;
  /** Dans l'ordre d'ouverture. */
  services: readonly ProjectBoundService<TLoaded, TRequest>[];
  timeouts?: Partial<ProjectLifecycleTimeouts>;
}

export interface ProjectLifecycle<TLoaded extends ManagerReply = ManagerReply, TRequest = void> {
  /** Ouvre `projectFile` (un `project.json`) à la place du projet courant. */
  open(projectFile: string, request: TRequest): Promise<ProjectOpenResult<TLoaded>>;
  /** Ferme le projet courant ; ne lève pas. */
  close(): Promise<void>;
  /** Le handle de l'ouverture en cours, ou null. */
  current(): ProjectHandle | null;
}

/** Une ouverture : son handle, et la fin que seule la séquence peut lui donner. */
class Opening implements ProjectHandle {
  private readonly controller = new AbortController();
  readonly signal: AbortSignal = this.controller.signal;

  constructor(
    readonly path: string,
    readonly epoch: number
  ) {}

  isCurrent(): boolean {
    return !this.signal.aborted;
  }

  assertCurrent(): void {
    if (!this.isCurrent()) throw new ProjectChangedError();
  }

  /** Sans raison : voir `ProjectHandle.signal`. */
  end(): void {
    this.controller.abort();
  }
}

type Settled<T> = { kind: 'done'; value: T } | { kind: 'failed'; error: unknown } | { kind: 'timeout' };

const LOG = '[project-lifecycle]';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Attend `run` au plus `ms`, sans jamais lever. Le délai tombé est journalisé, et un échec qui
 * arriverait ensuite aussi : la séquence, elle, a continué.
 */
async function settleWithin<T>(label: string, ms: number, run: () => T | Promise<T>): Promise<Settled<T>> {
  let work: Promise<T>;
  try {
    work = Promise.resolve(run());
  } catch (error: unknown) {
    return { kind: 'failed', error };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), ms);
  });
  try {
    const outcome = await Promise.race([
      work.then(
        (value): Settled<T> => ({ kind: 'done', value }),
        (error: unknown): Settled<T> => ({ kind: 'failed', error })
      ),
      timedOut,
    ]);
    if (outcome.kind === 'timeout') {
      console.warn(`${LOG} ${label} : pas de réponse après ${ms} ms, la séquence continue`);
      work.catch((error: unknown) => console.warn(`${LOG} ${label} : échec après le délai :`, error));
    }
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

type Refusal = ManagerReply & { error: string };

/**
 * Un appel au gestionnaire qui n'a pas abouti : son refus passe tel quel ; une exception ou un délai
 * tombé disent que le projet n'a pas répondu (`project_unavailable`).
 */
function managerRefusal(label: string, outcome: Settled<ManagerReply>): Refusal {
  if (outcome.kind === 'done') {
    return { ...outcome.value, success: false, error: outcome.value.error ?? 'project_unavailable' };
  }
  if (outcome.kind === 'failed') console.error(`${LOG} ${label} :`, outcome.error);
  const error = outcome.kind === 'failed' ? messageOf(outcome.error) : 'timeout';
  return { success: false, code: 'project_unavailable', error };
}

/** Ce qui est ouvert : le handle, le manifeste qui l'a ouvert, les services dans l'ordre d'ouverture. */
interface OpenState<TLoaded extends ManagerReply, TRequest> {
  handle: Opening;
  projectFile: string;
  opened: ProjectBoundService<TLoaded, TRequest>[];
}

type EnterOutcome<TLoaded extends ManagerReply> =
  | { kind: 'entered'; loaded: TLoaded; warnings: string[] }
  | { kind: 'refused'; reply: Refusal; managerUnsure: boolean };

export function createProjectLifecycle<TLoaded extends ManagerReply = ManagerReply, TRequest = void>(
  options: ProjectLifecycleOptions<TLoaded, TRequest>
): ProjectLifecycle<TLoaded, TRequest> {
  const { manager } = options;
  const services = [...options.services];
  const timeouts: ProjectLifecycleTimeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  let state: OpenState<TLoaded, TRequest> | null = null;
  let epoch = 0;
  let tail: Promise<unknown> = Promise.resolve();

  /** Dans l'ordre d'arrivée, une à la fois. Les tâches ne lèvent pas ; la file survit quand même. */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  }

  async function closeNow(): Promise<void> {
    const closing = state;
    state = null;
    if (closing) {
      closing.handle.end();
      const reversed = [...closing.opened].reverse();
      // Toutes ensemble : chaque `abort()` ne fait que couper, et aucun n'attend l'autre.
      await Promise.all(
        reversed
          .filter((service) => service.abort)
          .map(async (service) => {
            const outcome = await settleWithin(`abort de ${service.name}`, timeouts.abortMs, () =>
              service.abort?.()
            );
            if (outcome.kind === 'failed') console.error(`${LOG} abort de ${service.name} :`, outcome.error);
          })
      );
      for (const service of reversed) {
        if (!service.close) continue;
        const outcome = await settleWithin(
          `fermeture de ${service.name}`,
          service.closeTimeoutMs ?? timeouts.closeMs,
          () => service.close?.()
        );
        if (outcome.kind === 'failed') console.error(`${LOG} fermeture de ${service.name} :`, outcome.error);
      }
    }
    const outcome = await settleWithin('fermeture du projet', timeouts.closeMs, () => manager.close());
    if (outcome.kind === 'failed') console.error(`${LOG} fermeture du projet :`, outcome.error);
  }

  /**
   * Charge `projectFile` et ouvre ses services. En cas d'échec, tout ce qui a été ouvert est refermé.
   * `managerUnsure` : le gestionnaire n'a pas répondu à temps, et peut encore basculer.
   */
  async function enter(projectFile: string, request: TRequest): Promise<EnterOutcome<TLoaded>> {
    const load = await settleWithin(`chargement de ${projectFile}`, timeouts.managerMs, () =>
      manager.loadProject(projectFile)
    );
    if (load.kind !== 'done' || !load.value.success) {
      const reply = managerRefusal(`chargement de ${projectFile}`, load);
      return { kind: 'refused', reply, managerUnsure: load.kind === 'timeout' };
    }
    const loaded = load.value;

    const handle = new Opening(manager.getCurrentProjectPath() ?? path.dirname(projectFile), ++epoch);
    const opening: OpenState<TLoaded, TRequest> = { handle, projectFile, opened: [] };
    state = opening;
    const ctx: ServiceOpenContext<TLoaded, TRequest> = { loaded, request };
    const warnings: string[] = [];

    for (const service of services) {
      if (service.mode === 'background') continue;
      // Avant l'attente : un service qui échoue a pu s'ouvrir à moitié, et se ferme avec les autres.
      opening.opened.push(service);
      const ms = service.openTimeoutMs ?? timeouts.openMs;
      const outcome = await settleWithin(`ouverture de ${service.name}`, ms, () => service.open?.(handle, ctx));
      if (outcome.kind === 'done') continue;
      // Un délai tombé compte comme un échec ; le nom du service reste au journal, hors de la réponse.
      const error = outcome.kind === 'failed' ? outcome.error : new Error(`pas de réponse après ${ms} ms`);
      if (service.mode === 'best-effort') {
        console.warn(`${LOG} service ${service.name} (best-effort) :`, error);
        warnings.push(service.name);
        continue;
      }
      console.error(`${LOG} service ${service.name} :`, error);
      await closeNow();
      const reply: Refusal = { success: false, code: 'services_failed', error: messageOf(error) };
      return { kind: 'refused', reply, managerUnsure: false };
    }

    // Après les autres : une ouverture refusée ne laisse aucune tâche de fond derrière elle.
    for (const service of services) {
      if (service.mode !== 'background') continue;
      opening.opened.push(service);
      const logFailure = (error: unknown): void =>
        console.warn(`${LOG} service ${service.name} (arrière-plan) :`, error);
      try {
        void Promise.resolve(service.open?.(handle, ctx)).catch(logFailure);
      } catch (error: unknown) {
        logFailure(error);
      }
    }
    return { kind: 'entered', loaded, warnings };
  }

  async function openNow(projectFile: string, request: TRequest): Promise<ProjectOpenResult<TLoaded>> {
    const before = state;
    const refuse = (reply: Refusal, restoredPath: string | null): ProjectOpenRefusal => ({
      ...reply,
      success: false,
      restoredPath,
    });

    // Préflight : rien n'a encore changé, et un refus laisse A tel quel.
    const metadata = await settleWithin(`lecture de ${projectFile}`, timeouts.managerMs, () =>
      manager.getProjectMetadata(projectFile)
    );
    if (metadata.kind !== 'done' || !metadata.value.success) {
      return refuse(managerRefusal(`lecture de ${projectFile}`, metadata), before?.handle.path ?? null);
    }

    // Le même dossier, par le disque et non par la chaîne : seul le manifeste se relit.
    if (before && sameFile(path.dirname(projectFile), before.handle.path)) {
      const load = await settleWithin(`rechargement de ${projectFile}`, timeouts.managerMs, () =>
        manager.loadProject(projectFile)
      );
      if (load.kind === 'done' && load.value.success) return { ...load.value, success: true as const, warnings: [] };
      return refuse(managerRefusal(`rechargement de ${projectFile}`, load), before.handle.path);
    }

    if (before) await closeNow();
    const entered = await enter(projectFile, request);
    if (entered.kind === 'entered') {
      return { ...entered.loaded, success: true as const, warnings: entered.warnings };
    }

    // Retour sur A. Sauf si le gestionnaire n'a pas répondu : il pourrait encore basculer sur B
    // après ce retour, et le main servirait A sur le projet B. Aucun projet, alors.
    let restoredPath: string | null = null;
    if (before && !entered.managerUnsure) {
      const back = await enter(before.projectFile, request);
      if (back.kind === 'entered') restoredPath = state?.handle.path ?? null;
      else console.error(`${LOG} le projet précédent ne s'est pas rouvert :`, back.reply.error);
    }
    return refuse(entered.reply, restoredPath);
  }

  return {
    open: (projectFile, request) => enqueue(() => openNow(projectFile, request)),
    close: () => enqueue(closeNow),
    current: () => state?.handle ?? null,
  };
}
