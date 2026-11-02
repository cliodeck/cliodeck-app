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
 * Trois règles :
 *  - **Durée totale, pas délai d'inactivité.** Pandoc ne transmet rien de la
 *    sortie de xelatex : aucun octet pendant la compilation (mesuré), donc aucun
 *    signal d'activité sur lequel s'appuyer.
 *  - **Une seule horloge par export**, pas une par chapitre : un livre de 30
 *    chapitres pourrait sinon bloquer 30 fois.
 *  - **C'est tout l'arbre qui meurt** : tuer pandoc seul laisserait xelatex
 *    tourner. D'où `detached`, qui fait de l'outil le chef de son groupe.
 */

import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'child_process';
import { EXPORT_TIME_LIMIT_MS } from '../../../backend/types/export-limits.js';

/** Entre SIGTERM et SIGKILL. */
const KILL_GRACE_MS = 5000;
const KILL_POLL_MS = 50;
/** Ce qu'on laisse au service pour nettoyer ; une attente bloquée n'y répondra pas. */
const CLEANUP_GRACE_MS = 2000;

/** Pour les tests : aucune interface ne la raccourcit. */
export interface ExportLimits {
  timeLimitMs?: number;
}

export type ExportErrorCode = 'export_timed_out';

/** Le résultat des services d'export, tel que le renderer le reçoit. */
export interface ExportResult {
  success: boolean;
  outputPath?: string;
  error?: string;
  errorCode?: ExportErrorCode;
  /** Avec `export_timed_out` : le message ne doit pas écrire ce nombre en dur. */
  timeLimitMinutes?: number;
}

export class ExportTimedOutError extends Error {
  readonly code: ExportErrorCode = 'export_timed_out';

  constructor(readonly minutes: number) {
    super(`Export arrêté : aucun résultat après ${minutes} minutes.`);
    this.name = 'ExportTimedOutError';
  }
}

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

/** L'horloge d'un export : ce qui est lancé ou attendu sous elle s'arrête à l'échéance. */
export class ExportClock {
  private readonly minutes: number;
  private readonly children = new Set<ChildProcess>();
  private readonly expireHooks: Array<() => void> = [];
  private readonly timer: NodeJS.Timeout;
  private readonly expiry: Promise<never>;
  private expired = false;

  constructor(limitMs: number) {
    this.minutes = Math.round(limitMs / 60_000);
    let timer: NodeJS.Timeout | undefined;
    this.expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.expired = true;
        for (const hook of this.expireHooks) hook();
        void Promise.all([...this.children].map(killProcessTree)).then(() =>
          reject(new ExportTimedOutError(this.minutes))
        );
      }, limitMs);
    });
    this.timer = timer as NodeJS.Timeout;
    // Rejet sans lecteur quand plus rien n'attend sous l'horloge à l'échéance.
    this.expiry.catch(() => undefined);
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
    if (this.expired) throw new ExportTimedOutError(this.minutes);
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
  const running = work(clock);
  try {
    return await clock.run(running);
  } catch (error: unknown) {
    if (!(error instanceof ExportTimedOutError)) throw error;
    await settledWithin(running, CLEANUP_GRACE_MS);
    console.error('❌ Export stopped by its time limit:', error.message);
    return {
      success: false,
      error: error.message,
      errorCode: error.code,
      timeLimitMinutes: error.minutes,
    };
  } finally {
    clock.stop();
  }
}
