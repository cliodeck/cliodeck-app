import { EXPORT_TIME_LIMIT_MS } from '@backend/types/export-limits';

/**
 * Les lectures qu'une modale fait avant d'appeler le main.
 *
 * L'horloge d'un export démarre dans le main (`export-time-limit.ts`), donc après
 * elles, alors que la modale est déjà verrouillée : Échap et Annuler n'y font plus
 * rien. Sur un disque qui ne répond plus, seule cette limite rend la main.
 *
 * Une lecture en cours ne s'annule pas : elle reste en attente, mais le rejet a
 * interrompu l'export, qui ne reprendra pas derrière elle.
 */

/** Se lit comme un résultat `export_timed_out` du main (voir `export-error.ts`). */
export class ExportReadTimedOutError extends Error {
  readonly errorCode = 'export_timed_out';

  constructor(readonly timeLimitMinutes: number) {
    super(`Export arrêté : lecture sans réponse après ${timeLimitMinutes} minutes.`);
    this.name = 'ExportReadTimedOutError';
  }
}

export type ExportReadLimit = <T>(read: Promise<T>) => Promise<T>;

/** Démarre l'horloge des lectures d'un export : une seule, quel qu'en soit le nombre. */
export function startExportReadLimit(limitMs: number = EXPORT_TIME_LIMIT_MS): ExportReadLimit {
  const deadline = Date.now() + limitMs;
  return <T>(read: Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new ExportReadTimedOutError(Math.round(limitMs / 60_000))),
        Math.max(0, deadline - Date.now())
      );
      read.then(resolve, reject).finally(() => clearTimeout(timer));
    });
}

/** Un réglage facultatif : absent ou illisible, l'export garde ses valeurs par défaut. */
export async function readOptionalConfig<T>(path: string): Promise<T | undefined> {
  try {
    if (!(await window.electron.fs.exists(path))) return undefined;
    return JSON.parse(await window.electron.fs.readFile(path)) as T;
  } catch (err) {
    console.warn(`Unreadable export config, using defaults: ${path}`, err);
    return undefined;
  }
}
