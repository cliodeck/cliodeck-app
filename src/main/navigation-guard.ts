/**
 * Garde de navigation du processus principal.
 *
 * `setWindowOpenHandler` ne couvre que `window.open` et `target=_blank` : il
 * laissait passer la navigation du frame principal. Or les réponses de
 * l'assistant sont rendues en HTML avec les ancres autorisées, et leur
 * contenu peut être dicté par une source non fiable (PDF, archive Tropy,
 * note Obsidian, serveur MCP, réponse du modèle). Un clic suffisait donc à
 * faire quitter l'application à la fenêtre — le preload étant réinjecté dans
 * le document distant, la page de l'attaquant héritait des canaux IPC, dont
 * la lecture et l'écriture de fichiers.
 *
 * Règle : la fenêtre ne navigue QUE dans l'application. Un lien web part vers
 * le navigateur du système ; tout le reste est refusé.
 */
import { shell, type WebContents } from 'electron';

/** Protocoles qu'on accepte de confier au navigateur du système. */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export type NavigationDecision = 'allow' | 'external' | 'block';

/**
 * Que faire d'une navigation vers `target` depuis une application servie
 * à `appUrl` ? Fonction pure — c'est elle que les tests exercent.
 */
export function classifyNavigation(target: string, appUrl: string): NavigationDecision {
  let url: URL;
  let base: URL;
  try {
    url = new URL(target);
    base = new URL(appUrl);
  } catch {
    return 'block';
  }

  // Navigation interne : même origine, et pour `file:` même document.
  // Une origine `file:` est opaque (« null ») : comparer les origines y
  // autoriserait n'importe quel fichier local, y compris hors du paquet.
  if (base.protocol === 'file:') {
    if (url.protocol === 'file:' && url.pathname === base.pathname) return 'allow';
  } else if (url.origin === base.origin) {
    return 'allow';
  }

  if (EXTERNAL_PROTOCOLS.has(url.protocol)) return 'external';

  return 'block';
}

/**
 * `WebContents` déjà gardés. Le filet global `web-contents-created` couvre
 * aussi la fenêtre principale : sans cette garde, un appel explicite en plus
 * posait deux fois les mêmes écouteurs, et un lien externe ouvrait DEUX
 * onglets. Défaut invisible aux tests unitaires, relevé en pilotant l'app.
 */
const guarded = new WeakSet<WebContents>();

/**
 * Applique la règle à un `WebContents` : navigation de frame (principal et
 * enfants) et création de tout nouveau `WebContents`. Idempotent.
 */
export function attachNavigationGuard(contents: WebContents, appUrl: string): void {
  if (guarded.has(contents)) return;
  guarded.add(contents);

  const handle = (event: { preventDefault: () => void }, target: string): void => {
    const decision = classifyNavigation(target, appUrl);
    if (decision === 'allow') return;

    event.preventDefault();
    if (decision === 'external') {
      void shell.openExternal(target).catch((err) => {
        console.warn('[NavigationGuard] openExternal failed:', err);
      });
      return;
    }
    console.warn('[NavigationGuard] navigation bloquée:', target);
  };

  // Frame principal.
  contents.on('will-navigate', handle);

  // Sous-frames uniquement (aperçu de présentation en iframe).
  // `will-frame-navigate` couvre AUSSI le frame principal : sans ce filtre,
  // un lien externe était traité deux fois et `openExternal` ouvrait deux
  // onglets. Défaut invisible aux tests unitaires, relevé en pilotant l'app.
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return;
    handle(event, event.url);
  });

  contents.on('will-redirect', handle);
}
