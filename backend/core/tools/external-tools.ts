/**
 * Trouver les outils externes — pandoc, xelatex, Poppler — sur les trois
 * systèmes.
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

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { delimiter, join } from 'path';

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

export interface FindToolDeps {
  platform?: NodeJS.Platform;
  /** Un fichier existe-t-il ? (injecté dans les tests) */
  exists?: (filePath: string) => boolean;
  /** Lance la commande de recherche et rend sa sortie ; lève si l'outil manque. */
  run?: (finder: string, args: string[]) => string;
}

/**
 * Chemin complet d'un outil externe, ou `null` s'il est introuvable.
 *
 * Deux temps : les emplacements bien connus que le PATH d'une app lancée
 * depuis le Finder ne contient pas, puis la commande de recherche du système.
 * Sous Windows, l'exécutable porte le suffixe `.exe` et `where` peut rendre
 * plusieurs lignes — la première fait foi.
 */
export function findExternalTool(name: string, deps: FindToolDeps = {}): string | null {
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? existsSync;
  const run =
    deps.run ??
    ((finder: string, args: string[]) => execFileSync(finder, args, { encoding: 'utf8' }));

  const executable = platform === 'win32' ? `${name}.exe` : name;

  if (platform !== 'win32') {
    for (const directory of UNIX_TOOL_PATHS) {
      const candidate = join(directory, executable);
      if (exists(candidate)) return candidate;
    }
  }

  try {
    const output = run(toolFinderCommand(platform), [name]);
    const first = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (first && exists(first)) return first;
  } catch {
    // Outil absent du PATH : la commande de recherche sort en erreur.
  }

  return null;
}
