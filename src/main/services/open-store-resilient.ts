/**
 * Ouvrir un store electron-store dont le fichier peut être abîmé (S11-1-10).
 *
 * electron-store (conf 14) lit son fichier dans son constructeur, avec `clearInvalidConfig: false` :
 * un JSON invalide y lève la `SyntaxError` de `JSON.parse`, un fichier vide aussi (« Unexpected end
 * of JSON input », coupure pendant une écriture). Le rejet arrivait dans le `whenReady` du main,
 * avant `createWindow` : l'app tournait sans fenêtre et sans un mot. `clearInvalidConfig: true`
 * aurait été pire : le store repart vide et réécrit le fichier avec les défauts, sans copie.
 *
 * Le fichier illisible est donc mis de côté tel quel (`quarantineFile`, jamais par-dessus une copie
 * précédente), puis le store repart des défauts. Toute autre erreur (droits, disque) remonte sans
 * rien renommer : le fichier est peut-être sain, et le renommer le ferait perdre.
 */
import { quarantineFile } from '../../../backend/core/fs/user-files.js';

/** Ce que lève `JSON.parse`, à travers le constructeur du store. */
function isUnparsable(error: unknown): boolean {
  return error instanceof Error && error.name === 'SyntaxError';
}

/**
 * Ouvre le store par `open`. Si son fichier `filePath` ne se lit pas comme du JSON, le met de côté
 * et rouvre avec les défauts ; `recoveredFrom` est alors le chemin de la copie, sinon `null`.
 */
export async function openStoreResilient<T>(
  open: () => T,
  filePath: string
): Promise<{ store: T; recoveredFrom: string | null }> {
  try {
    return { store: open(), recoveredFrom: null };
  } catch (error) {
    if (!isUnparsable(error)) throw error;
    const recoveredFrom = await quarantineFile(filePath);
    console.warn(`⚠️ [Config] ${filePath} illisible (${(error as Error).message}) : mis de côté sous ${recoveredFrom}`);
    return { store: open(), recoveredFrom };
  }
}
