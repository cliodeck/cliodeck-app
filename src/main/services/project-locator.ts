/**
 * Où sont les projets que nomment les brouillons (J12).
 *
 * Un brouillon porte le chemin de son projet (Q12). Dossier déplacé, renommé ou supprimé : ses
 * brouillons n'apparaissaient plus nulle part. Pour chaque chemin, `project.json` y est-il encore,
 * et quelle est la clé de fichier du dossier (`sameFileKey`) ? Absent, le panneau propose ses
 * brouillons au projet ouvert ; présent sous la même clé que le projet ouvert (dossier renommé par
 * la seule casse sous macOS, lien), ils sont les siens.
 *
 * Ces dossiers sont ceux de projets que l'app ne connaît plus, sur un volume qui peut ne plus
 * répondre (L03-3) : lecture seule — ni création, ni écriture, ni base ouverte —, jamais d'appel
 * synchrone, et chaque chemin sous un délai. Un chemin qui ne répond pas à temps n'est ni présent
 * ni absent. Sa lecture n'est pas relancée tant qu'elle n'a pas fini : un volume mort ne retient
 * qu'une lecture par dossier dans le pool de libuv.
 */
import path from 'path';
import { stat } from 'fs/promises';
import { sameFileKeyAsync } from '../../../backend/core/vector-store/file-identity.js';

export type ProjectPlace =
  | { path: string; state: 'present'; key: string }
  | { path: string; state: 'absent' }
  | { path: string; state: 'unknown' };

/** Au plus autant de chemins par demande : la validation de l'IPC le vérifie aussi. */
export const LOCATE_MAX_PATHS = 100;

/** Le délai de chaque chemin. */
export const LOCATE_TIMEOUT_MS = 2_000;

/** Ce que la lecture demande au disque ; un test le simule pour un volume qui ne répond pas. */
export interface LocateDisk {
  stat(filePath: string): Promise<{ isFile(): boolean }>;
  key(dirPath: string): Promise<string>;
}

const realDisk: LocateDisk = { stat, key: sameFileKeyAsync };

export interface ProjectLocator {
  /** Un résultat par chemin distinct, dans l'ordre reçu. */
  locate(paths: readonly string[]): Promise<ProjectPlace[]>;
}

/** Un chemin absolu, sans caractère nul : sinon, rien ne se lit. */
function readable(dir: string): boolean {
  return path.isAbsolute(dir) && !dir.includes('\0');
}

export function createProjectLocator(options: { disk?: LocateDisk; timeoutMs?: number } = {}): ProjectLocator {
  const disk = options.disk ?? realDisk;
  const timeoutMs = options.timeoutMs ?? LOCATE_TIMEOUT_MS;
  const inFlight = new Map<string, Promise<ProjectPlace>>();

  const read = (dir: string): Promise<ProjectPlace> => {
    const running = inFlight.get(dir);
    if (running) return running;
    const reading = (async (): Promise<ProjectPlace> => {
      try {
        const manifest = await disk.stat(path.join(dir, 'project.json'));
        if (!manifest.isFile()) return { path: dir, state: 'absent' };
      } catch (error: unknown) {
        // Absent seulement quand le disque le dit ; des droits retirés ou un disque abîmé ne disent
        // pas que le projet est parti.
        const code = (error as NodeJS.ErrnoException | null)?.code;
        return code === 'ENOENT' || code === 'ENOTDIR' ? { path: dir, state: 'absent' } : { path: dir, state: 'unknown' };
      }
      return { path: dir, state: 'present', key: await disk.key(dir) };
    })()
      .catch((): ProjectPlace => ({ path: dir, state: 'unknown' }))
      .finally(() => inFlight.delete(dir));
    inFlight.set(dir, reading);
    return reading;
  };

  const withinDeadline = (dir: string): Promise<ProjectPlace> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<ProjectPlace>((resolve) => {
      timer = setTimeout(() => resolve({ path: dir, state: 'unknown' }), timeoutMs);
    });
    return Promise.race([read(dir), late]).finally(() => clearTimeout(timer));
  };

  return {
    locate: (paths) =>
      Promise.all(
        [...new Set(paths)].map((dir) =>
          readable(dir) ? withinDeadline(dir) : Promise.resolve<ProjectPlace>({ path: dir, state: 'unknown' })
        )
      ),
  };
}
