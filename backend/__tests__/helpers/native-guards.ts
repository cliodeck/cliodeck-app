/**
 * Gardes d'environnement partagées pour les suites dépendant de binaires
 * natifs ou de services locaux.
 *
 * Depuis better-sqlite3 13 (N-API), le même binaire sert à Node et à
 * Electron : les suites SQLite tournent aussi en local. La garde
 * `describe.skipIf(!sqliteAvailable)` ne joue plus que si le binding manque
 * vraiment (plateforme sans binaire précompilé et compilation impossible) ;
 * les tests purs tournent toujours. Ne JAMAIS utiliser ces gardes pour
 * masquer un échec qui n'est pas environnemental.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { extendedToolPath } from '../../core/tools/external-tools.js';

/** Message à coller en commentaire au point d'usage, pour un skip lisible. */
export const SQLITE_SKIP_REASON =
  'binding better-sqlite3 introuvable (ni binaire précompilé ni compilation) — ' +
  'lancer `npm run rebuild:native` (`npm rebuild better-sqlite3` ne compile plus rien depuis la 13) ou exécuter en CI';

export const sqliteAvailable: boolean = (() => {
  try {
    new Database(':memory:').close();
    return true;
  } catch {
    return false;
  }
})();

/** Créer un lien demande un droit sous Windows : sans lui, ces tests se sautent. */
export const symlinkAvailable: boolean = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cliodeck-lien-'));
  try {
    symlinkSync('cible', path.join(dir, 'lien'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

/**
 * Vrai si un serveur Ollama répond localement. Ping court (500 ms), jamais
 * bloquant : à utiliser avec un top-level await —
 * `describe.skipIf(!(await ollamaAvailable()))`.
 */
export async function ollamaAvailable(
  baseUrl = 'http://127.0.0.1:11434'
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/version`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Vrai si un vrai pandoc répond : à utiliser avec `describe.skipIf(!pandocAvailable())`. */
export function pandocAvailable(): boolean {
  try {
    execFileSync('pandoc', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** L'environnement d'un outil externe, cherché comme l'app le cherche (MacTeX, Homebrew). */
export function toolEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: extendedToolPath(process.env.PATH ?? '') };
}

function toolAnswers(tool: string, versionFlag: string): boolean {
  try {
    execFileSync(tool, [versionFlag], { stdio: 'ignore', env: toolEnv() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Vrai si un vrai xelatex répond, cherché comme l'export PDF le cherche (MacTeX n'est pas
 * toujours au PATH) : à utiliser avec `describe.skipIf(!xelatexAvailable())`.
 */
export function xelatexAvailable(): boolean {
  return toolAnswers('xelatex', '--version');
}

/**
 * Vrai si pdftotext (Poppler) répond, cherché de même : pour lire le texte d'un PDF produit par
 * un test, avec `it.skipIf(!pdftotextAvailable())`. Lancer pdftotext avec `toolEnv()`.
 */
export function pdftotextAvailable(): boolean {
  return toolAnswers('pdftotext', '-v');
}
