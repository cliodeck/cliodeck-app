/**
 * Trouver pandoc et xelatex, sur les trois systèmes.
 *
 * Ces deux règles vivaient en double, dans `pdf-export.ts` et
 * `word-export.ts` — c'est pourquoi le même défaut s'y trouvait deux fois au
 * premier essai sous Windows : le bouton « Exporter » restait grisé alors que
 * pandoc et xelatex étaient installés.
 *
 *  - **La commande de recherche** : `which` n'existe pas sous Windows, où
 *    l'équivalent est `where`.
 *  - **Le PATH étendu** : une application lancée depuis le Finder n'hérite pas
 *    du PATH du shell, d'où les emplacements Homebrew et MacTeX ajoutés à la
 *    main. Sous Windows ces chemins n'ont aucun sens, et les recoller avec `:`
 *    couperait les lettres de lecteur (`C:\…`) — le PATH y part donc tel quel.
 */

import { delimiter } from 'path';

/** Emplacements que le PATH d'une app lancée depuis le Finder n'a pas. */
const UNIX_TOOL_PATHS = [
  '/opt/homebrew/bin', // Homebrew sur Apple Silicon
  '/usr/local/bin', // Homebrew sur Mac Intel
  '/Library/TeX/texbin', // MacTeX
  '/usr/texbin', // MacTeX, ancien emplacement
  '/opt/local/bin', // MacPorts
];

/** `where` sous Windows, `which` ailleurs. */
export function toolFinderCommand(platform: NodeJS.Platform = process.platform): 'where' | 'which' {
  return platform === 'win32' ? 'where' : 'which';
}

/** Le PATH à donner aux outils d'export — inchangé sous Windows. */
export function extendedToolPath(
  currentPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') return currentPath;
  const missing = UNIX_TOOL_PATHS.filter((p) => !currentPath.includes(p));
  return [...missing, currentPath].join(delimiter);
}
