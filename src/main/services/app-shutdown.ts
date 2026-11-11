/**
 * Quitter l'application : un arrêt ordonné, et borné (L03-9).
 *
 * `before-quit` vidait l'éditeur, arrêtait le service des thèmes, puis appelait `app.exit()`, qui
 * ne ferme rien d'autre : la session du journal de recherche restait « Active », sans durée, et les
 * événements du journal d'usage encore en tampon (750 ms) étaient perdus (S11-1-6). Cmd+Q est la
 * façon ordinaire de finir une journée. Et un service des thèmes occupé à calculer retenait la
 * fermeture sans fin (S13-1-15).
 *
 * L'arrêt est en course contre une échéance : aucune attente sans sortie. Ce qui n'a pas fini à
 * l'échéance est nommé au journal du processus, et `app.exit()` suit quoi qu'il arrive.
 *
 * N'importe aucun service : ce qu'il arrête lui est passé (`ShutdownParts`).
 */

/** Ce que l'arrêt accorde à l'ensemble des services, après l'écriture du document. */
export const QUIT_DEADLINE_MS = 8_000;

/**
 * La part de l'échéance gardée pour libérer les modèles embarqués, après le projet. Sortir avec un
 * modèle chargé sur Metal fait planter l'app à la fermeture (rapport `.ips`) : le projet ne doit pas
 * prendre tout le temps.
 */
const EMBEDDED_RELEASE_RESERVE_MS = 1_500;

/** Ce que la sortie arrête. */
export interface ShutdownParts {
  /** Le service Python des thèmes, démarré ou en démarrage. */
  stopTopicModeling(): Promise<void>;
  /**
   * Le projet ouvert : ses services, journaux compris, en `budgetMs` au plus
   * (`ProjectLifecycle.shutdown`). Ses registres libèrent les modèles qu'ils tiennent.
   */
  closeProject(budgetMs: number): Promise<void>;
  /**
   * Tout client embarqué qui tient encore un modèle ou en charge un, projet ou pas ; aucun ne se
   * charge plus ensuite (`disposeAllEmbeddedClients`).
   */
  releaseEmbeddedModels(): Promise<void>;
}

export interface ShutdownReport {
  /** Les arrêts qui n'avaient pas fini à l'échéance. */
  unfinished: string[];
}

const LOG = '[Quit]';

/**
 * Arrête le service des thèmes et ferme le projet ensemble ; libère les modèles embarqués après le
 * projet, ou au plus tard quand son budget est écoulé. Rend la main à `deadlineMs` au plus tard.
 * Ne rejette jamais.
 */
export async function shutdownApp(options: { deadlineMs: number } & ShutdownParts): Promise<ShutdownReport> {
  const { deadlineMs } = options;
  const projectBudgetMs = Math.max(1, deadlineMs - EMBEDDED_RELEASE_RESERVE_MS);
  const pending = new Set<string>();
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const after = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      timers.push(setTimeout(resolve, ms));
    });

  const run = (name: string, step: () => Promise<void>): Promise<void> => {
    pending.add(name);
    return Promise.resolve()
      .then(step)
      .then(
        () => {
          pending.delete(name);
        },
        (error: unknown) => {
          pending.delete(name);
          console.warn(`⚠️ ${LOG} ${name} :`, error);
        }
      );
  };

  const project = run('projet', () => options.closeProject(projectBudgetMs));
  const steps = Promise.all([
    run('service des thèmes', () => options.stopTopicModeling()),
    project,
    // Après les registres du projet, qui libèrent les leurs en se fermant ; un service du projet
    // bloqué ne garde pas les modèles chargés jusqu'à la sortie.
    run('modèles embarqués', async () => {
      await Promise.race([project, after(projectBudgetMs)]);
      await options.releaseEmbeddedModels();
    }),
  ]);

  try {
    const outcome = await Promise.race([steps.then(() => 'done' as const), after(deadlineMs).then(() => 'deadline' as const)]);
    if (outcome === 'deadline') {
      console.warn(`⚠️ ${LOG} échéance de ${deadlineMs} ms atteinte, sortie sans attendre : ${[...pending].join(', ')}`);
    }
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
  return { unfinished: [...pending] };
}

/** Les temps de `before-quit`, dans l'ordre. */
export interface QuitSteps {
  /** Écrit le document ouvert ; faux si l'auteur préfère rester (`mayLeaveRenderer`). */
  mayLeave(): Promise<boolean>;
  /**
   * Retire les fenêtres de l'écran, une fois le document écrit : l'arrêt peut durer jusqu'à
   * l'échéance, et rien de ce qui se taperait pendant ce temps ne serait écrit.
   */
  hideWindows(): void;
  /** Arrête les services (`shutdownApp`). */
  shutdown(): Promise<unknown>;
  /** `app.exit()` : ne redéclenche pas `before-quit`. */
  exit(): void;
}

/** Le gestionnaire de `before-quit`, et ce qu'il dit de la sortie en cours. */
export interface QuitHandler {
  (event: { preventDefault(): void }): Promise<void>;
  /**
   * Vrai dès que la sortie est engagée — le document écrit, les fenêtres retirées de l'écran — et
   * jusqu'à `app.exit`. Pendant l'arrêt (jusqu'à 8 s), la barre de menus et le Dock restent actifs :
   * le menu et `activate` le lisent pour ne rien recréer, ne rien réafficher, ne rien envoyer.
   */
  isLeaving(): boolean;
}

/**
 * Le gestionnaire de `before-quit` : le document, puis les fenêtres retirées de l'écran, puis
 * l'arrêt, puis `app.exit`. Un second Cmd+Q pendant l'arrêt est retenu et ne relance rien ; mais si
 * l'auteur choisit de rester, sa fenêtre reste à l'écran et la sortie suivante repart de zéro.
 */
export function createQuitHandler(steps: QuitSteps): QuitHandler {
  let quitting = false;
  // Jamais remis à faux : `app.exit` suit quoi qu'il arrive.
  let leaving = false;
  const onQuit = async (event: { preventDefault(): void }): Promise<void> => {
    // Toujours retenu : sans cela, Electron quitterait sans attendre l'arrêt en cours.
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    // D'abord le travail de l'utilisateur, ensuite les services. L'auteur qui préfère rester garde
    // tout : la sortie est annulée, et les services tournent encore.
    if (!(await steps.mayLeave())) {
      quitting = false;
      return;
    }
    // Le document est écrit : une fenêtre encore à l'écran pendant l'arrêt (jusqu'à 8 s) recevrait
    // une frappe que plus personne n'écrirait, et `app.exit` l'emporterait. Le renderer vit encore :
    // une écriture qui traînait au flush peut toujours aboutir.
    leaving = true;
    try {
      steps.hideWindows();
    } catch (error: unknown) {
      console.warn(`⚠️ ${LOG} fenêtres non retirées :`, error);
    }
    try {
      const report = await steps.shutdown();
      console.log(`✅ ${LOG} arrêt terminé`, report ?? '');
    } catch (error: unknown) {
      console.warn(`⚠️ ${LOG} arrêt impossible :`, error);
    }
    steps.exit();
  };
  return Object.assign(onQuit, { isLeaving: () => leaving });
}
