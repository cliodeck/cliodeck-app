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
 * ni absent.
 *
 * Le délai rend la main au panneau, pas le fil du pool de libuv : sur un partage réseau figé, le
 * `stat` reste bloqué dans le noyau, et le pool n'a que quatre fils, dont dépend tout `fs.promises`
 * du main (enregistrer le document, ouvrir un projet, indexer). D'où trois règles : au plus
 * `LOCATE_MAX_READS` lectures en vol, toutes demandes confondues, chacune comptée jusqu'à sa vraie
 * fin ; une seule par volume (`volumeOf`) ; et une lecture qui attend sa place ne part plus une fois
 * son délai passé. Un dossier dont la lecture est encore en vol n'est pas relu.
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

/** Le délai de chaque chemin, attente de sa place comprise. */
export const LOCATE_TIMEOUT_MS = 2_000;

/**
 * Au plus autant de lectures en vol, toutes demandes confondues : deux fils du pool de libuv au plus
 * pour le localisateur, deux au moins pour le reste du main, même devant deux volumes figés.
 */
export const LOCATE_MAX_READS = 2;

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

/** Les dossiers où se montent les disques : macOS, puis Linux. */
const MOUNT_PARENTS: readonly (readonly string[])[] = [['Volumes'], ['mnt'], ['media'], ['run', 'media']];

/**
 * Le volume d'un chemin, d'après le chemin seul, sans appel au disque : `/Volumes/<nom>` (macOS),
 * `/mnt/<nom>`, `/media/<nom>`, `/run/media/<nom>` (Linux), le lecteur ou le partage réseau
 * (Windows), sinon la racine. Un volume monté ailleurs se confond avec la racine : le plafond
 * global protège encore le pool.
 */
export function volumeOf(dir: string, pathApi: path.PlatformPath = path): string {
  const { root } = pathApi.parse(dir);
  if (root !== '/') return root.toLowerCase();
  const segments = dir.split('/').filter((segment) => segment.length > 0);
  for (const parent of MOUNT_PARENTS) {
    const name = segments[parent.length];
    if (name !== undefined && parent.every((segment, i) => segments[i] === segment)) {
      return `/${[...parent, name].join('/')}`;
    }
  }
  return '/';
}

/** Un chemin absolu, sans caractère nul : sinon, rien ne se lit. */
function readable(dir: string): boolean {
  return path.isAbsolute(dir) && !dir.includes('\0');
}

async function readPlace(disk: LocateDisk, dir: string): Promise<ProjectPlace> {
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
}

/** Une lecture qui attend sa place. */
interface Waiting {
  dir: string;
  volume: string;
  start: (reading: Promise<ProjectPlace>) => void;
}

export function createProjectLocator(
  options: { disk?: LocateDisk; timeoutMs?: number; maxReads?: number } = {}
): ProjectLocator {
  const disk = options.disk ?? realDisk;
  const timeoutMs = options.timeoutMs ?? LOCATE_TIMEOUT_MS;
  const maxReads = options.maxReads ?? LOCATE_MAX_READS;
  /** Les lectures parties, par dossier, jusqu'à leur vraie fin, délai passé ou non. */
  const reading = new Map<string, Promise<ProjectPlace>>();
  /** Les volumes qui ont une lecture en vol. */
  const busyVolumes = new Set<string>();
  /** Les lectures qui attendent leur place, dans l'ordre des demandes. */
  const queue: Waiting[] = [];

  const begin = (dir: string, volume: string): Promise<ProjectPlace> => {
    busyVolumes.add(volume);
    const place = readPlace(disk, dir)
      .catch((): ProjectPlace => ({ path: dir, state: 'unknown' }))
      .finally(() => {
        reading.delete(dir);
        busyVolumes.delete(volume);
        pump();
      });
    reading.set(dir, place);
    return place;
  };

  /** Fait partir ce qui a sa place ; un dossier déjà en lecture rejoint celle-ci. */
  const pump = (): void => {
    for (let i = 0; i < queue.length; ) {
      const next = queue[i];
      const running = reading.get(next.dir);
      if (running === undefined && (reading.size >= maxReads || busyVolumes.has(next.volume))) {
        i += 1;
        continue;
      }
      queue.splice(i, 1);
      next.start(running ?? begin(next.dir, next.volume));
    }
  };

  const withinDeadline = (dir: string): Promise<ProjectPlace> => {
    let start: Waiting['start'] = () => undefined;
    const result = new Promise<ProjectPlace>((resolve) => {
      start = resolve;
    });
    const waiting: Waiting = { dir, volume: volumeOf(dir), start };
    queue.push(waiting);
    pump();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<ProjectPlace>((resolve) => {
      timer = setTimeout(() => {
        // Pas encore partie : elle ne partira plus.
        const index = queue.indexOf(waiting);
        if (index >= 0) queue.splice(index, 1);
        resolve({ path: dir, state: 'unknown' });
      }, timeoutMs);
    });
    return Promise.race([result, late]).finally(() => clearTimeout(timer));
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
