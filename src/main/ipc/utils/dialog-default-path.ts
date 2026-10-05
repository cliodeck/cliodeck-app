/**
 * Dossier de départ des dialogues de fichiers.
 *
 * Jusqu'à Electron 42, un dialogue ouvert sans `defaultPath` laissait le
 * système choisir son dossier de départ : en pratique le dernier visité,
 * retenu d'un lancement à l'autre. Depuis Electron 43, Electron impose
 * « Téléchargements » dans ce cas, et le système ne retient plus rien —
 * chaque « Ouvrir un projet » repartirait de là.
 *
 * On retient donc nous-mêmes le dossier du dernier choix
 * (`lastDialogDirectory` dans la configuration). Comme pour les chemins
 * consentis, la valeur ne vient jamais du renderer : seulement de ce qu'un
 * dialogue natif a retourné.
 */
import path from 'path';
import { stat } from 'fs/promises';

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Le `defaultPath` à passer au dialogue.
 *
 * - chemin absolu demandé : inchangé, l'appelant sait où il veut aller ;
 * - nom de fichier seul (« document.md ») : placé dans le dernier dossier ;
 * - rien : le dernier dossier.
 *
 * Un dernier dossier disparu (disque débranché, projet déplacé) est ignoré :
 * Electron le prendrait pour un nom de fichier et le proposerait comme tel.
 */
export async function resolveDialogDefaultPath(
  requested: string | undefined,
  lastDirectory: string | undefined
): Promise<string | undefined> {
  if (requested && path.isAbsolute(requested)) return requested;
  if (!lastDirectory || !(await isDirectory(lastDirectory))) return requested;
  return requested ? path.join(lastDirectory, requested) : lastDirectory;
}

/**
 * Le dossier à retenir après un choix : celui que le dialogue affichait,
 * donc le parent de l'élément choisi — y compris quand c'est un dossier.
 */
export function directoryToRemember(chosenPath: string): string {
  return path.dirname(path.resolve(chosenPath));
}
