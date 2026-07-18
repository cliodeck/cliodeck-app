/**
 * Gardes d'environnement partagées pour les suites dépendant de binaires
 * natifs ou de services locaux.
 *
 * better-sqlite3 est recompilé pour l'ABI d'Electron par le postinstall
 * (`electron-builder install-app-deps`) : sous le node de vitest, le binding
 * peut être incompatible (NODE_MODULE_VERSION différent). Les suites SQLite
 * se gardent alors par `describe.skipIf(!sqliteAvailable)` — elles tournent
 * en CI et après `npm rebuild better-sqlite3` ; les tests purs tournent
 * toujours. Ne JAMAIS utiliser ces gardes pour masquer un échec qui n'est
 * pas environnemental.
 */
import Database from 'better-sqlite3';

/** Message à coller en commentaire au point d'usage, pour un skip lisible. */
export const SQLITE_SKIP_REASON =
  'binding better-sqlite3 compilé pour Electron (ABI ≠ node de vitest) — ' +
  'lancer `npm rebuild better-sqlite3` ou exécuter en CI';

export const sqliteAvailable: boolean = (() => {
  try {
    new Database(':memory:').close();
    return true;
  } catch {
    return false;
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
