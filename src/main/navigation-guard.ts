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
 * Règle : la fenêtre ne navigue QUE dans l'application. Toute autre
 * navigation est refusée, y compris vers le web.
 *
 * Un lien web que l'historien active (clic, Cmd+clic, clic du milieu, Entrée)
 * ne passe pas par ici : le preload l'ouvre lui-même par `shell:open-external`
 * et empêche la navigation. Une navigation externe qui arrive au garde n'a
 * donc pas eu de geste — meta refresh, `location` changé par la page,
 * redirection, lien activé par un script. Electron ne dit pas si une
 * navigation vient d'un geste : le garde l'ouvrait quand même, et une balise
 * `<meta http-equiv="refresh">` suffisait à ouvrir une page dans le
 * navigateur, sans aucun clic (mesuré par L08-1). Elle est refusée, et le
 * refus inscrit au journal de sécurité du projet.
 */
import type { WebContents } from 'electron';
import { workspaceFiles } from '../../backend/core/workspace/layout.js';
import { workspaceLinkOutside } from '../../backend/core/workspace/link-guard.js';
import { appendSecurityEvent } from '../../backend/security/source-inspector.js';
import { projectManager } from './services/project-manager.js';

/**
 * Protocoles d'un lien web, que le preload confie au navigateur du système
 * (même liste dans `src/preload/index.ts`).
 */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * `external` : une navigation vers le web, refusée et inscrite au journal de
 * sécurité ; `block` : tout autre protocole, refusé.
 */
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
 * Inscrit le refus au journal de sécurité du projet ouvert ; sans projet (ou
 * avec un `.cliodeck` lié hors du projet), au journal du processus seulement.
 */
async function recordRefusedNavigation(url: string): Promise<void> {
  console.warn('[NavigationGuard] navigation externe sans geste refusée:', url);
  const root = projectManager.getCurrentProjectPath();
  if (!root || (await workspaceLinkOutside(root))) return;
  await appendSecurityEvent(workspaceFiles(root).securityEventsLog, {
    kind: 'external_navigation_blocked',
    url,
    at: new Date().toISOString(),
  });
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
      void recordRefusedNavigation(target).catch((err) => {
        console.warn('[NavigationGuard] journal de sécurité indisponible:', err);
      });
      return;
    }
    console.warn('[NavigationGuard] navigation bloquée:', target);
  };

  // Frame principal.
  contents.on('will-navigate', handle);

  // Sous-frames uniquement (aperçu de présentation en iframe) : même règle.
  // Le preload n'y est pas injecté, un lien n'y a donc pas de geste.
  // `will-frame-navigate` couvre AUSSI le frame principal : sans ce filtre,
  // un lien externe était traité deux fois et `openExternal` ouvrait deux
  // onglets. Défaut invisible aux tests unitaires, relevé en pilotant l'app.
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return;
    handle(event, event.url);
  });

  // Une redirection vers l'extérieur n'est jamais un geste.
  contents.on('will-redirect', handle);
}
