/**
 * Registre des chemins consentis par l'utilisateur.
 *
 * `path-validator.ts` refuse tout accès hors du projet courant — y compris
 * `$HOME` — pour qu'un renderer compromis ne puisse pas lire `~/.ssh` ni
 * écrire `~/.zshrc`. Son en-tête prescrit, pour les opérations légitimes
 * hors projet (ouvrir un document, « Enregistrer sous »), « une route IPC
 * dédiée qui obtient le consentement explicite de l'utilisateur via un
 * dialogue natif ».
 *
 * C'est ce registre. Le processus principal sait ce qu'il a lui-même
 * proposé : quand l'utilisateur choisit un fichier dans un dialogue natif,
 * le chemin retourné est enregistré ici, et lui seul devient accessible
 * hors projet. Le renderer ne peut rien y ajouter — il ne peut que
 * demander l'ouverture d'un dialogue, dont l'issue appartient à
 * l'utilisateur.
 *
 * Portée : la session applicative. Un chemin consenti le reste jusqu'à la
 * fermeture (l'utilisateur qui ouvre un fichier s'attend à pouvoir
 * l'enregistrer, puis le réenregistrer). Le registre est borné pour ne pas
 * croître indéfiniment sur une longue session.
 */
import path from 'path';
import { realpath } from 'fs/promises';

/** Au-delà, les entrées les plus anciennes sont oubliées. */
const MAX_ENTRIES = 200;

/** Chemins résolus (et dé-symlinkés quand c'est possible). */
const consented = new Set<string>();

function remember(p: string): void {
  // Set conserve l'ordre d'insertion : la première clé est la plus ancienne.
  if (consented.size >= MAX_ENTRIES) {
    const oldest = consented.values().next().value;
    if (oldest !== undefined) consented.delete(oldest);
  }
  consented.add(p);
}

/**
 * Enregistre un chemin choisi par l'utilisateur dans un dialogue natif.
 *
 * Appelé par les handlers `dialog:open-file` / `dialog:save-file` avec ce
 * que le dialogue a retourné — donc jamais avec une valeur fournie par le
 * renderer.
 */
export async function rememberConsentedPath(filePath: string): Promise<void> {
  if (typeof filePath !== 'string' || filePath.length === 0) return;
  const resolved = path.resolve(filePath);
  remember(resolved);
  // Mémoriser aussi la forme dé-symlinkée : sur macOS, `/var` → `/private/var`
  // ferait échouer la comparaison au moment de la lecture.
  try {
    const real = await realpath(resolved);
    if (real !== resolved) remember(real);
  } catch {
    // Le fichier n'existe pas encore (cas « Enregistrer sous ») : la forme
    // résolue suffit.
  }
}

/** Vrai si ce chemin a été explicitement choisi par l'utilisateur. */
export async function isConsentedPath(filePath: string): Promise<boolean> {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  const resolved = path.resolve(filePath);
  if (consented.has(resolved)) return true;
  try {
    const real = await realpath(resolved);
    return consented.has(real);
  } catch {
    return false;
  }
}

/** Réservé aux tests. */
export function __resetConsentedPaths(): void {
  consented.clear();
}
