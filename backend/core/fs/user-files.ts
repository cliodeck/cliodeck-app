/**
 * Les fichiers de l'historien : les écrire sans jamais perdre la version
 * d'avant, les lire sans confondre « absent » et « illisible ».
 *
 * `writeFile` ouvre en O_TRUNC : sur un disque plein, `document.md` passait de
 * 131 072 octets à 0 (mesuré sur une image disque pleine), et deux écritures
 * simultanées se mêlaient (30 et 29 idées : un JSON sur deux corrompu). On
 * écrit donc à côté, puis on renomme sur le chemin réel. Ce qui suit cette
 * règle a une raison mesurée : un `rename` nu remplacerait un lien par un
 * fichier, écraserait un fichier protégé en écriture, perdrait le mode, les
 * étiquettes Finder et la date de création.
 *
 * Limites assumées : le verrou vaut dans le processus (le serveur MCP et le CLI
 * ne réécrivent pas ces fichiers), les liens durs sont rompus, et un arrêt brutal
 * entre l'écriture et le rename laisse un `.~….tmp` caché, qu'aucun scan du
 * projet ne lit puisqu'il ne finit pas par `.md`.
 *
 * Pas de dépendance à Electron : le socle se teste et se réutilise hors du main.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { constants, readlinkSync, type Stats } from 'fs';
import { access, lstat, open, readFile, rename, rm, stat, writeFile, type FileHandle } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { fileIdentity } from '../vector-store/file-identity.js';

export type UserFileRead =
  | { kind: 'absent' }
  | { kind: 'ok'; content: string }
  | {
      kind: 'unreadable';
      reason: 'permission' | 'encoding' | 'not-a-file' | 'io' | 'refused';
      message: string;
    };

/** Le fichier existe mais on ne sait pas le lire : surtout ne pas le réécrire. */
export class UnreadableFileError extends Error {
  readonly code = 'file_unreadable';
  readonly filePath: string;
  /** Une raison de `UserFileRead`, ou `invalid-json` pour `updateJsonFile`. */
  readonly reason: string;

  constructor(filePath: string, reason: string, message: string) {
    super(message);
    this.name = 'UnreadableFileError';
    this.filePath = filePath;
    this.reason = reason;
  }
}

const execFileAsync = promisify(execFile);
const noop = (): void => undefined;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Le chemin sur lequel écrire : liens suivis, lien pendant compris, et casse
 * telle qu'enregistrée sur le disque. Synchrone, car c'est aussi la clé du
 * verrou : calculée dans l'ordre des appels, elle garde leur ordre d'arrivée.
 */
function resolveTarget(filePath: string): string {
  let current = path.resolve(filePath);
  // Au-delà, c'est une boucle de liens : le `stat` qui suit dira ELOOP.
  for (let hops = 0; hops < 40; hops++) {
    const real = fileIdentity(current);
    if (real !== current) return real;
    let link: string;
    try {
      link = readlinkSync(current);
    } catch {
      // Pas un lien : fichier existant, ou à créer. Son dossier, lui, se résout,
      // sinon la clé changerait à la création (/var et /private/var sous macOS).
      return path.join(fileIdentity(path.dirname(current)), path.basename(current));
    }
    current = path.resolve(path.dirname(current), link);
  }
  return current;
}

const lockTails = new Map<string, Promise<void>>();
const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>();

function runLocked<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // Réentrant : sans cela, écrire depuis `withFileLock` s'attendrait soi-même.
  const held = heldLocks.getStore();
  if (held?.has(key)) return fn();

  const run = (lockTails.get(key) ?? Promise.resolve()).then(() =>
    heldLocks.run(new Set([...(held ?? []), key]), fn)
  );
  const tail = run.then(noop, noop);
  lockTails.set(key, tail);
  void tail.then(() => {
    if (lockTails.get(key) === tail) lockTails.delete(key);
  });
  return run;
}

/**
 * File d'attente par fichier, dans le processus : `fn` passe après les appels
 * précédents sur ce fichier, quel que soit le chemin (lien, casse) qui le désigne.
 */
export function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  return runLocked(resolveTarget(filePath), fn);
}

const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * `rename`, repris sous Windows, où un antivirus ou un indexeur garde souvent le
 * fichier ouvert un instant. Ailleurs, ces codes sont de vraies erreurs.
 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const retryable =
        process.platform === 'win32' &&
        RENAME_RETRY_CODES.has(errorCode(error) ?? '') &&
        attempt < RENAME_RETRY_DELAYS_MS.length;
      if (!retryable) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]));
    }
  }
}

/**
 * Sous macOS, `cp -p` vers le temporaire : c'est le seul moyen mesuré de garder
 * étiquettes Finder et xattr (`fs.copyFile` et `fs.cp` les perdent). Son échec
 * n'a pas à faire échouer la sauvegarde : seuls les xattr seraient perdus.
 */
async function copyExtendedAttributes(target: string, temporary: string): Promise<void> {
  await execFileAsync('/bin/cp', ['-p', '--', target, temporary], { timeout: 5000 }).catch(noop);
}

async function openTemporary(temporary: string, existing: Stats | null): Promise<FileHandle> {
  try {
    return await open(temporary, 'wx', existing ? existing.mode & 0o7777 : undefined);
  } catch (error) {
    // `cp -p` l'a déjà créé.
    if (errorCode(error) === 'EEXIST') return open(temporary, 'r+');
    throw error;
  }
}

/** Au mieux : une clé USB en exFAT refuse `chmod` sans que le texte en souffre. */
async function restoreMetadata(handle: FileHandle, existing: Stats): Promise<void> {
  await handle.chown(existing.uid, existing.gid).catch(noop);
  await handle.chmod(existing.mode & 0o7777).catch(noop);
  if (process.platform === 'darwin') {
    // macOS ramène la date de création dès qu'une modification la précède : sans
    // ce détour, le Finder daterait la création de l'avant-dernière sauvegarde.
    const now = new Date();
    await handle.utimes(now, existing.birthtime).catch(noop);
    await handle.utimes(now, now).catch(noop);
  }
}

/** Certains systèmes de fichiers ne savent pas faire `fsync` : ce n'est pas un échec d'écriture. */
const FSYNC_UNSUPPORTED_CODES = new Set(['EINVAL', 'ENOTSUP', 'ENOSYS']);

async function syncToDisk(handle: FileHandle): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    if (!FSYNC_UNSUPPORTED_CODES.has(errorCode(error) ?? '')) throw error;
  }
}

/** Au mieux : Windows ne sait pas, et le fichier est déjà à sa place. */
async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Rien à faire de plus.
  }
}

/** Dossier en lecture seule, fichier inscriptible : le seul cas où écrire en place. */
const NO_TEMPORARY_HERE_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

async function writeUnderLock(target: string, data: string | Uint8Array): Promise<void> {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;

  const existing = await stat(target).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  });
  if (existing) {
    if (!existing.isFile()) {
      throw Object.assign(new Error(`EISDIR: ${target} n'est pas un fichier ordinaire`), { code: 'EISDIR' });
    }
    // Un rename écraserait un fichier protégé en écriture, que writeFile refusait.
    await access(target, constants.W_OK);
  }

  // Préfixe et suffixe que les services de synchronisation ignorent (à confirmer
  // à la main) ; 32 caractères du nom pour tenir dans la limite du système.
  const temporary = path.join(
    path.dirname(target),
    `.~${path.basename(target).slice(0, 32)}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  );
  const removeTemporary = () => rm(temporary, { force: true }).catch(noop);

  if (existing && process.platform === 'darwin') await copyExtendedAttributes(target, temporary);

  let handle: FileHandle;
  try {
    handle = await openTemporary(temporary, existing);
  } catch (error) {
    await removeTemporary();
    // Jamais sur ENOSPC : écrire en place sur un disque plein, c'est le défaut
    // même que ce socle corrige.
    if (!NO_TEMPORARY_HERE_CODES.has(errorCode(error) ?? '')) throw error;
    await writeFile(target, bytes);
    return;
  }

  try {
    try {
      await handle.truncate(0);
      await handle.writeFile(bytes);
      if (existing) await restoreMetadata(handle, existing);
      await syncToDisk(handle);
    } finally {
      await handle.close();
    }
    await renameWithRetry(temporary, target);
  } catch (error) {
    await removeTemporary();
    throw error;
  }
  await syncDirectory(path.dirname(target));
}

/**
 * Écrit `data` à la place de `filePath`, tout entier ou pas du tout. Une chaîne
 * part en UTF-8, sans BOM ajouté ni fin de ligne touchée. Sur erreur, l'ancienne
 * version reste intacte et l'erreur d'origine remonte. Pas pour ce qui s'écrit
 * en flux (GGUF, PDF) : voir `renameWithRetry`.
 */
export function atomicWriteFile(filePath: string, data: string | Uint8Array): Promise<void> {
  const target = resolveTarget(filePath);
  return runLocked(target, () => writeUnderLock(target, data));
}

function unreadable(
  reason: Exclude<Extract<UserFileRead, { kind: 'unreadable' }>['reason'], 'refused'>,
  message: string
): UserFileRead {
  return { kind: 'unreadable', reason, message };
}

/**
 * Lit un fichier sans lever. `absent` seulement sur ENOENT et ENOTDIR : un volume
 * non monté rend donc `absent`, à l'appelant de regarder plus haut. Le décodage
 * est strict : un fichier Latin-1 est illisible plutôt que changé en U+FFFD, que
 * la sauvegarde suivante rendrait définitifs ; le BOM reste, pour un aller-retour
 * fidèle. La raison `refused` n'est posée que par le canal IPC.
 */
export async function readUserFile(filePath: string, opts?: { lossyUtf8?: boolean }): Promise<UserFileRead> {
  let bytes: Buffer;
  try {
    // `stat` d'abord : lire un tube nommé ne rendrait jamais la main.
    if (!(await stat(filePath)).isFile()) {
      return unreadable('not-a-file', `${filePath} n'est pas un fichier ordinaire`);
    }
    bytes = await readFile(filePath);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
    if (code === 'EACCES' || code === 'EPERM') return unreadable('permission', errorMessage(error));
    if (code === 'EISDIR') return unreadable('not-a-file', errorMessage(error));
    return unreadable('io', errorMessage(error));
  }

  try {
    const content = opts?.lossyUtf8
      ? bytes.toString('utf8')
      : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return { kind: 'ok', content };
  } catch {
    return unreadable('encoding', `${filePath} n'est pas encodé en UTF-8`);
  }
}

/**
 * Lecture, mutation et écriture atomique sous le verrou du fichier. `current` vaut
 * `null` si le fichier est absent ; un retour `null` n'écrit rien. Un fichier
 * illisible lève `UnreadableFileError` sans appeler le mutator.
 */
export function updateFile(
  filePath: string,
  mutator: (current: string | null) => string | null | Promise<string | null>
): Promise<{ written: boolean; content: string | null }> {
  const target = resolveTarget(filePath);
  return runLocked(target, async () => {
    const read = await readUserFile(target);
    if (read.kind === 'unreadable') throw new UnreadableFileError(filePath, read.reason, read.message);

    const current = read.kind === 'ok' ? read.content : null;
    const next = await mutator(current);
    if (next === null) return { written: false, content: current };

    await writeUnderLock(target, next);
    return { written: true, content: next };
  });
}

/**
 * `updateFile` pour un JSON. Un JSON invalide lève `UnreadableFileError` de raison
 * `invalid-json`, mutator non appelé. Par défaut, indentation 2 sans saut final.
 */
export async function updateJsonFile<T>(
  filePath: string,
  mutator: (current: T | null) => T | null | Promise<T | null>,
  opts?: { indent?: number; trailingNewline?: boolean }
): Promise<{ written: boolean; value: T | null }> {
  let value: T | null = null;
  const { written } = await updateFile(filePath, async (current) => {
    let parsed: T | null = null;
    if (current !== null) {
      try {
        parsed = JSON.parse(current) as T;
      } catch (error) {
        throw new UnreadableFileError(filePath, 'invalid-json', errorMessage(error));
      }
    }
    const next = await mutator(parsed);
    value = next ?? parsed;
    if (next === null) return null;
    return `${JSON.stringify(next, null, opts?.indent ?? 2)}${opts?.trailingNewline ? '\n' : ''}`;
  });
  return { written, value };
}

/**
 * Met un fichier abîmé de côté : `<nom>.illisible-<horodatage>` dans le même
 * dossier, sans jamais écraser une mise de côté précédente. Rend le nouveau
 * chemin. Sur un lien, c'est le fichier réel qui est déplacé.
 */
export function quarantineFile(filePath: string): Promise<string> {
  const target = resolveTarget(filePath);
  return runLocked(target, async () => {
    // `:` est interdit dans un nom de fichier sous Windows.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (let n = 0; ; n++) {
      const candidate = `${target}.illisible-${stamp}${n === 0 ? '' : `-${n}`}`;
      const taken = await lstat(candidate).then(
        () => true,
        (error: unknown) => {
          if (errorCode(error) === 'ENOENT') return false;
          throw error;
        }
      );
      if (taken) continue;
      await renameWithRetry(target, candidate);
      return candidate;
    }
  });
}
