/**
 * Une seule séquence pour ouvrir, rouvrir et fermer un projet côté main (L03-3).
 *
 * Les handlers ouvraient et fermaient chacun leurs services à leur façon : la création oubliait le
 * journal d'usage, la fermeture n'attendait pas le service PDF, un échec laissait le main sur le
 * projet d'à côté. Ici, une file sérialise toutes les ouvertures et fermetures, dans l'ordre
 * d'arrivée, et chacune suit la même séquence :
 *
 * - ouvrir : lire le manifeste de B sans rien changer (un `project.json` illisible laisse A intact,
 *   services compris) ; le même dossier ne relit que son manifeste (le style CSL), sauf si ce qui
 *   décide de ses services a changé depuis (`reopenWhen`) ; sinon fermer A, charger B, lui donner
 *   un nouveau handle et ouvrir ses services dans l'ordre ;
 * - fermer : avorter le signal du handle, appeler tous les `abort()`, puis les `close()` en ordre
 *   inverse d'ouverture, chacun pour soi, et enfin le gestionnaire de projet ;
 * - échouer : un service `required` qui échoue referme tout ce qui a été ouvert et rouvre A ; un
 *   `best-effort` laisse un avertissement ; un `background` est lancé sans attente.
 *
 * Aucune attente sans sortie : la file bloquerait toutes les suivantes, et l'auteur devrait quitter
 * l'app pour ouvrir un projet. Chaque attente est donc bornée, journalisée quand le délai tombe, et
 * la séquence continue : un `open()` sans réponse compte comme un échec, un `close()` comme fait.
 *
 * Un appel au gestionnaire (charger, fermer) qui dépasse son délai continue pourtant, et finira :
 * il reste suivi. Le chargement suivant l'attend d'abord, une seule fois, borné ; deux chargements
 * du même dossier ne courent jamais ensemble ; et sa fin remet le gestionnaire sur le projet de la
 * séquence, ou ferme tout, ce que l'appelant apprend par `onUnrequestedClose`.
 *
 * Le dossier d'un projet ne se compare jamais par sa chaîne, mais jamais non plus par un appel
 * synchrone au disque d'un autre projet que celui qu'on ouvre : son volume ne répond peut-être plus,
 * et l'appel gèlerait le main hors de toute borne. Sa clé (`sameFileKey`) se relève juste après son
 * préflight, quand son disque vient de répondre ; toutes les comparaisons se font ensuite sur elle.
 *
 * N'importe aucun service : la table des services et le gestionnaire de projet lui sont passés.
 */
import path from 'path';
import { sameFileKey } from '../../../backend/core/vector-store/file-identity.js';
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
  /**
   * Le dossier du projet courant, ou null : celui du `project.json` passé à `loadProject`, tel quel
   * (`path.dirname`), comme le range `ProjectManager`. La remise d'accord le reconnaît ainsi sans
   * toucher au disque ; une autre graphie la ferait seulement recharger le projet pour rien.
   */
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
 * fin de ce que `abort` a coupé. Les délais remplacent ceux de la séquence pour ce service seul :
 * un nombre fini de millisecondes, entre 1 et `MAX_DELAY_MS`, vérifié à la construction.
 */
export interface ProjectBoundService<TLoaded extends ManagerReply = ManagerReply, TRequest = void> {
  readonly name: string;
  readonly mode: ProjectServiceMode;
  readonly openTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  /**
   * Ouvre le service sur `handle`. Une ouverture abandonnée n'est pas interrompue : délai tombé,
   * ou autre service `required` en échec, elle continue pendant que la séquence referme ce projet
   * et rouvre le précédent, peut-être sur ce même service. Le signal du handle s'avorte alors.
   * Après chaque attente, avant de s'installer, elle vérifie donc `handle.isCurrent()` (ou appelle
   * `handle.assertCurrent()`) et s'arrête sinon. Seul un `best-effort` dont le délai tombe garde
   * un handle courant : son ouverture tardive peut s'installer.
   */
  open?(handle: ProjectHandle, ctx: ServiceOpenContext<TLoaded, TRequest>): void | Promise<void>;
  abort?(): void | Promise<void>;
  close?(): void | Promise<void>;
}

/**
 * Le plus long délai que `setTimeout` respecte : au-delà, Node le ramène à 1 ms (Infinity compris),
 * et « pas de plafond » ferait tomber le délai aussitôt.
 */
export const MAX_DELAY_MS = 2_147_483_647;

/** Les délais de la séquence, en millisecondes : finis, entre 1 et `MAX_DELAY_MS`. */
export interface ProjectLifecycleTimeouts {
  /** Chaque `abort()`, tous en même temps. */
  abortMs: number;
  /** Chaque `open()` attendu. */
  openMs: number;
  /** Chaque `close()`, et la fermeture côté gestionnaire. */
  closeMs: number;
  /**
   * Chaque lecture ou chargement du manifeste, et l'attente, une fois pour chacun, des appels au
   * gestionnaire restés en retard avant un nouveau chargement.
   */
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

/**
 * La séquence a fermé d'elle-même le projet `path`, hors de toute demande. `code` et `error` disent
 * pourquoi, comme un refus d'`open` : le code que le renderer traduit, l'erreur pour le journal.
 */
export interface UnrequestedClose {
  readonly path: string;
  readonly code: string;
  readonly error: string;
}

export interface ProjectLifecycleOptions<TLoaded extends ManagerReply = ManagerReply, TRequest = void> {
  manager: ProjectManagerPort<TLoaded>;
  /** Dans l'ordre d'ouverture. */
  services: readonly ProjectBoundService<TLoaded, TRequest>[];
  timeouts?: Partial<ProjectLifecycleTimeouts>;
  /**
   * Appelé quand la séquence ferme le projet d'elle-même : un appel au gestionnaire resté en retard
   * l'a fait basculer, et le projet ne s'y recharge pas. Le renderer le croit encore ouvert, et le
   * validateur refuserait ses enregistrements sans rien dire : il doit l'apprendre. Jamais après
   * `close()` ni après une bascule demandée par `open()`, dont la réponse dit déjà tout. Une
   * exception y est journalisée, et la séquence continue.
   */
  onUnrequestedClose?: (closed: UnrequestedClose) => void;
  /**
   * Le projet ouvert, rouvert : `opened` est la réponse du gestionnaire qui a servi à ouvrir ses
   * services (ou à la dernière relecture), `reloaded` celle de la relecture. Vrai : ce qui décide de
   * ses services a changé sur le disque (un `.cliodeck` lié dehors remis en place, par exemple), et
   * le projet se ferme puis se rouvre en entier, comme un autre. Absent ou faux : seul son manifeste
   * est relu.
   */
  reopenWhen?: (opened: TLoaded, reloaded: TLoaded) => boolean;
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

/** `late` : l'appel resté sans réponse, qui se résout (sans jamais rejeter) quand il finit. */
type Settled<T> =
  | { kind: 'done'; value: T }
  | { kind: 'failed'; error: unknown }
  | { kind: 'timeout'; late: Promise<void> };

/** `busy` : un chargement du même dossier court encore, et l'appel n'est pas parti. */
type ManagerOutcome<T> = Settled<T> | { kind: 'busy' };

const LOG = '[project-lifecycle]';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Un délai que `setTimeout` respecte, ou une erreur dès la construction : jamais d'attente sans borne. */
function checkDelay(name: string, ms: number | undefined): void {
  if (ms === undefined) return;
  if (!Number.isFinite(ms) || ms < 1 || ms > MAX_DELAY_MS) {
    throw new RangeError(
      `${LOG} délai ${name} invalide (${ms}) : un nombre fini de millisecondes, entre 1 et ${MAX_DELAY_MS}`
    );
  }
}

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
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    const outcome = await Promise.race([
      work.then(
        (value): Settled<T> => ({ kind: 'done', value }),
        (error: unknown): Settled<T> => ({ kind: 'failed', error })
      ),
      timedOut,
    ]);
    if (outcome !== 'timeout') return outcome;
    console.warn(`${LOG} ${label} : pas de réponse après ${ms} ms, la séquence continue`);
    const late = work.then(
      () => undefined,
      (error: unknown) => console.warn(`${LOG} ${label} : échec après le délai :`, error)
    );
    return { kind: 'timeout', late };
  } finally {
    clearTimeout(timer);
  }
}

type Refusal = ManagerReply & { error: string };

/**
 * Un appel au gestionnaire qui n'a pas abouti : son refus passe tel quel ; une exception, un délai
 * tombé ou un chargement du même dossier qui court encore disent que le projet n'a pas répondu
 * (`project_unavailable`).
 */
function managerRefusal(label: string, outcome: ManagerOutcome<ManagerReply>): Refusal {
  if (outcome.kind === 'done') {
    return { ...outcome.value, success: false, error: outcome.value.error ?? 'project_unavailable' };
  }
  if (outcome.kind === 'failed') console.error(`${LOG} ${label} :`, outcome.error);
  // `busy` aussi : le chargement d'avant, dont le délai est tombé, court encore.
  const error = outcome.kind === 'failed' ? messageOf(outcome.error) : 'timeout';
  return { success: false, code: 'project_unavailable', error };
}

/** Un dossier de projet : sa graphie, et la clé relevée à son préflight (`sameFileKey`). */
interface ProjectDir {
  readonly dir: string;
  readonly key: string;
}

/**
 * Ce qui est ouvert : le handle, le manifeste qui l'a ouvert et la clé de son dossier, la réponse du
 * gestionnaire à sa dernière lecture (`reopenWhen`), les services dans l'ordre d'ouverture.
 */
interface OpenState<TLoaded extends ManagerReply, TRequest> {
  handle: Opening;
  projectFile: string;
  key: string;
  loaded: TLoaded;
  opened: ProjectBoundService<TLoaded, TRequest>[];
}

type EnterOutcome<TLoaded extends ManagerReply> =
  | { kind: 'entered'; loaded: TLoaded; warnings: string[] }
  | { kind: 'refused'; reply: Refusal; managerUnsure: boolean };

/** Un appel qui change le gestionnaire (charger, fermer), resté sans réponse et qui court encore. */
interface LateCall {
  /** Le dossier qu'il charge ; null pour une fermeture. */
  readonly target: ProjectDir | null;
  /** Se résout quand il a fini, une fois retiré du suivi et la remise d'accord mise en file. */
  readonly finished: Promise<void>;
  /** Déjà attendu une fois, en entier : on ne l'attend plus. */
  awaited: boolean;
}

export function createProjectLifecycle<TLoaded extends ManagerReply = ManagerReply, TRequest = void>(
  options: ProjectLifecycleOptions<TLoaded, TRequest>
): ProjectLifecycle<TLoaded, TRequest> {
  const { manager } = options;
  const services = [...options.services];
  const timeouts: ProjectLifecycleTimeouts = { ...DEFAULT_TIMEOUTS };
  for (const key of Object.keys(DEFAULT_TIMEOUTS) as Array<keyof ProjectLifecycleTimeouts>) {
    // Un `undefined` explicite garde la valeur par défaut, au lieu de devenir un délai de 1 ms.
    const ms = options.timeouts?.[key];
    if (ms !== undefined) timeouts[key] = ms;
    checkDelay(key, timeouts[key]);
  }
  for (const service of services) {
    checkDelay(`openTimeoutMs de ${service.name}`, service.openTimeoutMs);
    checkDelay(`closeTimeoutMs de ${service.name}`, service.closeTimeoutMs);
  }
  let state: OpenState<TLoaded, TRequest> | null = null;
  let epoch = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const lateCalls = new Set<LateCall>();
  /**
   * La clé de chaque graphie de dossier passée au préflight. `ProjectManager` range comme chemin
   * courant le dossier du `project.json` chargé, tel quel : une remise d'accord y retrouve la clé du
   * dossier où il se trouve sans toucher à son disque.
   */
  const keys = new Map<string, string>();

  /** Dans l'ordre d'arrivée, une à la fois. Les tâches ne lèvent pas ; la file survit quand même. */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  }

  /** Un chargement de ce dossier, resté en retard, court-il encore ? Par la graphie, ou par la clé. */
  function stillLoading(dir: string, key?: string): boolean {
    for (const call of lateCalls) {
      if (call.target === null) continue;
      if (call.target.dir === dir || (key !== undefined && call.target.key === key)) return true;
    }
    return false;
  }

  /**
   * Attend les appels en retard, au plus `managerMs`, mais chacun une seule fois : un chargement qui
   * ne finit jamais (volume perdu) ne coûte pas ce délai à chaque bascule jusqu'à ce qu'on quitte.
   */
  async function awaitLateCallsOnce(label: string): Promise<void> {
    const pending = [...lateCalls].filter((call) => !call.awaited);
    if (pending.length === 0) return;
    await settleWithin(`${label}, attente des appels en retard`, timeouts.managerMs, () =>
      Promise.all(pending.map((call) => call.finished))
    );
    for (const call of pending) call.awaited = true;
  }

  /**
   * Charger (`target`) ou fermer (`target` null) côté gestionnaire. Un appel qui dépasse son délai
   * continue : il reste suivi jusqu'à sa fin, qui met en file une remise d'accord (`reconcile`).
   *
   * - Un chargement attend d'abord ceux qui courent encore, au plus `managerMs` et une fois chacun :
   *   le cas courant, une migration d'espace de travail un peu longue, finit là, sans chevauchement.
   * - Deux chargements du même dossier ne courent jamais ensemble : la migration de `.cliodeck`
   *   n'a pas de verrou. Le second n'est pas lancé (`busy`), et finit en `project_unavailable`.
   * - Un autre dossier passe après l'attente : un chargement qui ne finit jamais n'empêche pas
   *   d'ouvrir un autre projet sans quitter l'app.
   * - Une fermeture n'attend rien : si un chargement en retard finit après elle, la remise d'accord
   *   referme le gestionnaire.
   */
  async function changeManager<T>(
    label: string,
    target: ProjectDir | null,
    ms: number,
    run: () => T | Promise<T>
  ): Promise<ManagerOutcome<T>> {
    if (target !== null) {
      await awaitLateCallsOnce(label);
      if (stillLoading(target.dir, target.key)) {
        console.warn(`${LOG} ${label} : le chargement précédent de ${target.dir} court encore, refusé`);
        return { kind: 'busy' };
      }
    }
    const outcome = await settleWithin(label, ms, run);
    if (outcome.kind === 'timeout') {
      const call: LateCall = {
        target,
        awaited: false,
        finished: outcome.late.then(() => {
          lateCalls.delete(call);
          void enqueue(reconcile);
        }),
      };
      lateCalls.add(call);
    }
    return outcome;
  }

  /**
   * Un appel au gestionnaire a fini après son délai : il a pu basculer sur un projet que la
   * séquence a quitté, ou fermer celui qu'elle a ouvert depuis. Le gestionnaire revient sur le
   * projet de la séquence ; s'il ne peut pas, à temps ou pas du tout, tout se ferme plutôt que de
   * laisser le main sur un projet que le renderer ne croit pas ouvert, et l'appelant l'apprend.
   */
  async function reconcile(): Promise<void> {
    const managerPath = manager.getCurrentProjectPath();
    const target = state;
    if (target === null) {
      if (managerPath === null) return;
      console.warn(`${LOG} le gestionnaire est sur ${managerPath} après un appel en retard : fermeture`);
      const outcome = await changeManager('fermeture du projet', null, timeouts.closeMs, () => manager.close());
      if (outcome.kind === 'failed') console.error(`${LOG} fermeture du projet :`, outcome.error);
      return;
    }
    // Par la clé, sans toucher au disque : le dossier du gestionnaire est peut-être celui du
    // chargement en retard, dont le volume ne répond plus.
    if (managerPath !== null && keys.get(managerPath) === target.key) return;
    console.warn(
      `${LOG} le gestionnaire est sur ${managerPath ?? 'aucun projet'} après un appel en retard : ` +
        `retour sur ${target.handle.path}`
    );
    const label = `rechargement de ${target.projectFile}`;
    const back = await changeManager(label, { dir: target.handle.path, key: target.key }, timeouts.managerMs, () =>
      manager.loadProject(target.projectFile)
    );
    if (back.kind === 'done' && back.value.success) return;
    // Refusé, sans réponse à temps, ou un chargement de ce projet qui court encore après son délai :
    // attendre sa fin pour recommencer pourrait ne jamais finir, et le main resterait sur un autre
    // projet pendant ce temps. Tout se ferme ; une fin tardive trouvera la séquence sans projet, et
    // refermera le gestionnaire.
    const refusal = managerRefusal(label, back);
    console.error(
      `${LOG} ${target.handle.path} ne se recharge pas après un appel en retard, le projet est fermé :`,
      refusal.error
    );
    await closeNow();
    try {
      options.onUnrequestedClose?.({
        path: target.handle.path,
        code: refusal.code ?? 'project_unavailable',
        error: refusal.error,
      });
    } catch (error: unknown) {
      console.error(`${LOG} onUnrequestedClose :`, error);
    }
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
    const outcome = await changeManager('fermeture du projet', null, timeouts.closeMs, () => manager.close());
    if (outcome.kind === 'failed') console.error(`${LOG} fermeture du projet :`, outcome.error);
  }

  /**
   * Charge `projectFile` et ouvre ses services. En cas d'échec, tout ce qui a été ouvert est refermé.
   * `managerUnsure` : le gestionnaire n'a pas répondu à temps, ou un chargement du même dossier
   * court encore ; il peut encore basculer.
   */
  async function enter(projectFile: string, key: string, request: TRequest): Promise<EnterOutcome<TLoaded>> {
    const dir = path.dirname(projectFile);
    const load = await changeManager(`chargement de ${projectFile}`, { dir, key }, timeouts.managerMs, () =>
      manager.loadProject(projectFile)
    );
    if (load.kind !== 'done' || !load.value.success) {
      const reply = managerRefusal(`chargement de ${projectFile}`, load);
      return { kind: 'refused', reply, managerUnsure: load.kind === 'timeout' || load.kind === 'busy' };
    }
    const loaded = load.value;

    // Le dossier demandé, celui que range `ProjectManager.loadProject` : pas le chemin courant du
    // gestionnaire, qu'un appel en retard peut avoir changé entre-temps.
    const handle = new Opening(dir, ++epoch);
    const opening: OpenState<TLoaded, TRequest> = { handle, projectFile, key, loaded, opened: [] };
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
    const dir = path.dirname(projectFile);
    const refuse = (reply: Refusal, restoredPath: string | null): ProjectOpenRefusal => ({
      ...reply,
      success: false,
      restoredPath,
    });
    // Refusé comme un préflight, avant de rien fermer : A reste tel quel.
    const stillLoadingRefusal = (): ProjectOpenRefusal => {
      console.warn(`${LOG} ouverture de ${projectFile} : le chargement précédent de ce dossier court encore`);
      return refuse(managerRefusal(`ouverture de ${projectFile}`, { kind: 'busy' }), before?.handle.path ?? null);
    };

    // Ce dossier, sous cette graphie, se charge encore : pas même relu, son volume ne répond
    // peut-être plus.
    if (stillLoading(dir)) return stillLoadingRefusal();

    // Préflight : rien n'a encore changé, et un refus laisse A tel quel.
    const metadata = await settleWithin(`lecture de ${projectFile}`, timeouts.managerMs, () =>
      manager.getProjectMetadata(projectFile)
    );
    if (metadata.kind !== 'done' || !metadata.value.success) {
      return refuse(managerRefusal(`lecture de ${projectFile}`, metadata), before?.handle.path ?? null);
    }

    // Son disque vient de répondre : sa clé se relève maintenant. Tout ce qui suit la compare, et ne
    // touche plus au disque d'aucun projet.
    const key = sameFileKey(dir);
    keys.set(dir, key);

    // Le même dossier, par le disque et non par la chaîne : seul le manifeste se relit, sauf si ce
    // qui décide de ses services a changé depuis. Les bandeaux de `configIssue` disent « puis rouvrez
    // le projet » : relu seul, un `.cliodeck` remis en place laissait ses services fermés.
    if (before && before.key === key) {
      const label = `rechargement de ${projectFile}`;
      const load = await changeManager(label, { dir, key }, timeouts.managerMs, () => manager.loadProject(projectFile));
      if (load.kind !== 'done' || !load.value.success) return refuse(managerRefusal(label, load), before.handle.path);
      if (!options.reopenWhen?.(before.loaded, load.value)) {
        before.loaded = load.value;
        return { ...load.value, success: true as const, warnings: [] };
      }
      console.info(`${LOG} ${projectFile} se rouvre en entier : ce qui décide de ses services a changé`);
    }

    // Ce dossier, sous une autre graphie, se charge encore.
    if (stillLoading(dir, key)) return stillLoadingRefusal();

    if (before) await closeNow();
    const entered = await enter(projectFile, key, request);
    if (entered.kind === 'entered') {
      return { ...entered.loaded, success: true as const, warnings: entered.warnings };
    }

    // Retour sur A. Sauf si le gestionnaire n'a pas répondu : son chargement de B court encore, et
    // rouvrir A le chevaucherait. Aucun projet, alors ; la fin de B remettra le gestionnaire
    // d'accord (`reconcile`), et l'auteur peut rouvrir A ou un autre.
    let restoredPath: string | null = null;
    if (before && !entered.managerUnsure) {
      const back = await enter(before.projectFile, before.key, request);
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
