/**
 * La limite de durée d'un export.
 *
 * Un export qui ne se termine pas (xelatex qui boucle, page reveal.js qui ne
 * charge jamais) n'a aucune autre sortie : Échap et Annuler ne l'interrompent
 * pas, car ils feraient perdre le résultat de tout export qui aboutit (#179).
 * Passé ce délai, l'export échoue et l'historien retrouve la main. Ce qui précède
 * l'appel au main, les lectures des modales, a la même limite côté renderer
 * (`export-read-limit.ts`).
 *
 * Quatre règles :
 *  - **Durée totale, pas délai d'inactivité.** Pandoc ne transmet rien de la
 *    sortie de xelatex : aucun octet pendant la compilation (mesuré), donc aucun
 *    signal d'activité sur lequel s'appuyer.
 *  - **Une seule horloge par export**, pas une par chapitre : un livre de 30
 *    chapitres pourrait sinon bloquer 30 fois.
 *  - **C'est tout l'arbre qui meurt** : tuer pandoc seul laisserait xelatex
 *    tourner. D'où `detached`, qui fait de l'outil le chef de son groupe.
 *  - **La veille ne compte pas** : rien ne tourne pendant que le Mac dort.
 */

import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'child_process';
import { access } from 'fs/promises';
import { EXPORT_TIME_LIMIT_MS } from '../../../backend/types/export-limits.js';
import type { OutcomeIssue } from '../../../backend/types/outcome.js';

/** Entre SIGTERM et SIGKILL. */
const KILL_GRACE_MS = 5000;
const KILL_POLL_MS = 50;
/** Ce qu'on laisse au service pour nettoyer ; une attente bloquée n'y répondra pas. */
const CLEANUP_GRACE_MS = 2000;

export interface ExportLimits {
  /** Pour les tests : aucune interface ne la raccourcit. */
  timeLimitMs?: number;
  /**
   * L'étape d'export d'une recette qu'on annule en fermant sa fenêtre (D20) : l'arbre
   * meurt comme à l'échéance, et aucune sortie n'arrive après coup.
   */
  signal?: AbortSignal;
}

export type ExportErrorCode = 'export_timed_out' | 'export_cancelled';

/**
 * L'export PDF échoue sur une image que pandoc n'a pas su convertir pour xelatex (L07-2) : codes
 * relatifs à `messages.*`, avec l'image en `errorParams.file`.
 */
export type ExportImageErrorCode = 'export.imageNeedsRsvgConvert' | 'export.imageNotConverted';

/**
 * Le fichier de sortie est un fichier Markdown, que l'export remplacerait (`export-output-path.ts`) :
 * code relatif à `messages.*`, avec le nom du fichier en `errorParams.file`.
 */
export type ExportOutputErrorCode = 'export.outputIsMarkdown';

/**
 * L'export PDF ou hors ligne d'une présentation (L09-12) : les fichiers de reveal.js n'ont pu venir
 * ni du cache ni du réseau, ou la page n'a pas été mise en pages d'impression dans le délai. Codes
 * relatifs à `messages.*`.
 */
export type ExportPresentationErrorCode = 'presentation.assetsUnavailable' | 'presentation.notRendered';

/** Le résultat des services d'export, tel que le renderer le reçoit. */
export interface ExportResult {
  success: boolean;
  outputPath?: string;
  error?: string;
  errorCode?: ExportErrorCode | ExportImageErrorCode | ExportOutputErrorCode | ExportPresentationErrorCode;
  /** Les paramètres du message d'un `errorCode` relatif à `messages.*`. */
  errorParams?: Record<string, string | number>;
  /** Avec `export_timed_out` : le message ne doit pas écrire ce nombre en dur. */
  timeLimitMinutes?: number;
  /**
   * Word et PDF : le style CSL des paramètres du projet, déclaré mais
   * introuvable à ce chemin. Le document est écrit sans lui ; la modale le dit.
   */
  missingCsl?: string;
  /**
   * Le document est écrit, avec des réserves (une image introuvable, remplacée par sa légende).
   * Le handler IPC les rend par `outcomeResponse(partial(…))` : la modale les dit et reste ouverte.
   */
  warnings?: OutcomeIssue[];
}

export class ExportTimedOutError extends Error {
  readonly code: ExportErrorCode = 'export_timed_out';

  constructor(readonly minutes: number) {
    super(`Export arrêté : aucun résultat après ${minutes} minutes.`);
    this.name = 'ExportTimedOutError';
  }
}

export class ExportCancelledError extends Error {
  readonly code: ExportErrorCode = 'export_cancelled';

  constructor() {
    super('Export annulé.');
    this.name = 'ExportCancelledError';
  }
}

type ExportStopped = ExportTimedOutError | ExportCancelledError;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Toute erreur vaut « plus personne à signaler » : ESRCH, ou EPERM sur des zombies (macOS). */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Déjà mort.
  }
}

async function groupGoneWithin(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (groupAlive(pid)) {
    if (Date.now() >= end) return false;
    await delay(KILL_POLL_MS);
  }
  return true;
}

/**
 * Tue un processus et toute sa descendance, et attend qu'ils soient morts.
 *
 * Sous POSIX, `child` doit avoir été lancé avec `detached: true` : c'est son
 * groupe qu'on vise. SIGTERM, puis SIGKILL si le groupe vit encore après 5 s.
 */
export async function killProcessTree(child: ChildProcess): Promise<void> {
  const { pid } = child;
  if (pid === undefined) return; // Jamais lancé.

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const taskkill = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      taskkill.on('error', () => resolve());
      taskkill.on('close', () => resolve());
    });
    return;
  }

  signalGroup(pid, 'SIGTERM');
  if (await groupGoneWithin(pid, KILL_GRACE_MS)) return;
  signalGroup(pid, 'SIGKILL');
  await groupGoneWithin(pid, KILL_GRACE_MS);
}

/**
 * Tout test d'existence d'un export passe par ici : `existsSync` gèlerait le main
 * sur un montage mort, et l'horloge avec lui, qui ne tomberait qu'au retour du disque.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Le cumul de la veille depuis le lancement de l'app, pour toutes les horloges. */
let sleptMs = 0;
let asleepSince: number | null = null;

function noteWake(): void {
  if (asleepSince === null) return;
  sleptMs += Date.now() - asleepSince;
  asleepSince = null;
}

/**
 * Ce que la limite écoute de la veille : `powerMonitor`, passé par le main, car ce
 * module doit pouvoir se charger sans Electron (les tests de l'export Word s'en passent).
 *
 * Sous macOS, l'horloge que lisent les minuteries de Node compte la veille
 * (`process.hrtime` suit `kern.boottime`, mesuré ; une vraie veille n'a pas été rejouée) :
 * sans cela, un export en cours serait tué au réveil d'une nuit, alors qu'il n'a tourné
 * que quelques instants.
 */
export function watchSystemSleep(power: {
  on(event: 'suspend' | 'resume', listener: () => void): unknown;
}): void {
  power.on('suspend', () => {
    asleepSince ??= Date.now();
  });
  power.on('resume', noteWake);
}

/** L'horloge d'un export : ce qui est lancé ou attendu sous elle s'arrête à l'échéance. */
export class ExportClock {
  private readonly minutes: number;
  private readonly startedAt = Date.now();
  private readonly sleptBefore = sleptMs;
  private readonly children = new Set<ChildProcess>();
  private readonly expireHooks: Array<() => void> = [];
  private readonly expiry: Promise<never>;
  private rejectExpiry: (error: ExportStopped) => void = () => undefined;
  private timer: NodeJS.Timeout;
  private expired = false;
  private stoppedBy: ExportStopped | null = null;

  constructor(private readonly limitMs: number) {
    this.minutes = Math.round(limitMs / 60_000);
    this.expiry = new Promise<never>((_, reject) => {
      this.rejectExpiry = reject;
    });
    // Rejet sans lecteur quand plus rien n'attend sous l'horloge à l'échéance.
    this.expiry.catch(() => undefined);
    this.timer = setTimeout(this.onDeadline, limitMs);
  }

  private readonly onDeadline = (): void => {
    noteWake(); // Au réveil, la minuterie peut tomber avant l'annonce de `resume`.
    const slept = sleptMs - this.sleptBefore;
    const left = this.limitMs - (Date.now() - this.startedAt - slept);
    if (slept > 0 && left > 0) {
      this.timer = setTimeout(this.onDeadline, left);
      return;
    }
    this.halt(new ExportTimedOutError(this.minutes));
  };

  /** Une annulation fait comme l'échéance : l'arbre meurt, puis l'export échoue. */
  cancel(): void {
    clearTimeout(this.timer);
    this.halt(new ExportCancelledError());
  }

  private halt(error: ExportStopped): void {
    if (this.expired) return;
    this.expired = true;
    this.stoppedBy = error;
    for (const hook of this.expireHooks) hook();
    void Promise.all([...this.children].map(killProcessTree)).then(() => this.rejectExpiry(error));
  }

  /** Lance un outil : à l'échéance, tout son arbre mourra. Échue, elle ne lance plus rien. */
  spawn(
    command: string,
    args: string[],
    options: SpawnOptionsWithoutStdio
  ): ChildProcessWithoutNullStreams {
    this.throwIfExpired();
    // Sous Windows, `detached` ouvrirait une console ; taskkill n'en a pas besoin.
    const child = spawn(command, args, { ...options, detached: process.platform !== 'win32' });
    this.children.add(child);
    child.once('close', () => this.children.delete(child));
    return child;
  }

  /**
   * Attend `work` sous l'horloge. Le rejet n'arrive qu'une fois l'arbre mort : le
   * nettoyage qui suit ne court pas après un outil encore en train d'écrire.
   *
   * Échue, l'horloge a seule la parole : l'issue de `work` (« code null » d'un
   * outil qu'on vient de tuer, ou le repli d'un citeproc) ne compte plus.
   */
  run<T>(work: Promise<T>): Promise<T> {
    const settled = work.then(
      (value) => (this.expired ? this.expiry : value),
      (error: unknown) => {
        if (this.expired) return this.expiry;
        throw error;
      }
    );
    return Promise.race([settled, this.expiry]);
  }

  /** Ce qu'il faut arrêter d'autre qu'un outil (une fenêtre). */
  onExpire(hook: () => void): void {
    this.expireHooks.push(hook);
  }

  /** Pour un travail repris après coup : il n'écrit pas par-dessus l'annonce d'un échec. */
  throwIfExpired(): void {
    if (this.expired) throw this.stoppedBy ?? new ExportTimedOutError(this.minutes);
  }

  /** Désarme la minuterie : aucun `kill` tardif sur un pid réutilisé. */
  stop(): void {
    clearTimeout(this.timer);
  }
}

/** Attend `work`, mais pas plus de `ms`. */
function settledWithin(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    work.then(finish, finish);
  });
}

/**
 * Exécute un export entier sous une seule horloge, y compris ce qui n'est pas un
 * outil : une lecture bloquée sur un disque réseau rend la main comme le reste.
 *
 * Un dépassement ne lève pas : il devient un résultat `export_timed_out`.
 */
export async function withExportTimeLimit<R>(
  limits: ExportLimits | undefined,
  work: (clock: ExportClock) => Promise<R>
): Promise<R | ExportResult> {
  const clock = new ExportClock(limits?.timeLimitMs ?? EXPORT_TIME_LIMIT_MS);
  const signal = limits?.signal;
  const cancel = () => clock.cancel();
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const running = work(clock);
  try {
    return await clock.run(running);
  } catch (error: unknown) {
    if (!(error instanceof ExportTimedOutError) && !(error instanceof ExportCancelledError)) throw error;
    await settledWithin(running, CLEANUP_GRACE_MS);
    if (error instanceof ExportCancelledError) {
      console.warn('⚠️ Export cancelled');
      return { success: false, error: error.message, errorCode: error.code };
    }
    console.error('❌ Export stopped by its time limit:', error.message);
    return {
      success: false,
      error: error.message,
      errorCode: error.code,
      timeLimitMinutes: error.minutes,
    };
  } finally {
    signal?.removeEventListener('abort', cancel);
    clock.stop();
  }
}
