/**
 * Le projet à l'écran, côté renderer (L03-4) : ce qui appartient à un projet s'efface quand l'écran
 * passe à un autre, et une réponse partie pour un projet ne s'inscrit pas dans le suivant.
 *
 * Le pendant de la séquence du main (`src/main/services/project-lifecycle.ts`), que seul
 * `projectStore` pilote : `beginTransition` juste avant de demander au main un autre projet ou la
 * fermeture, `enter` quand l'écran passe au projet rendu (ou à l'état sans projet), et
 * `abortTransition` quand le projet d'avant revient après un échec.
 *
 * Chaque store lié au projet inscrit sa remise à zéro à son chargement (`onReset`). `enter` les
 * appelle dans l'ordre d'inscription, avant que l'écran ne montre le projet entrant, et seulement si
 * le projet change : le même dossier rouvert ne perd rien. Une remise à zéro qui lève est
 * journalisée, et les suivantes passent quand même. Le test d'inventaire
 * (`__tests__/project-scope-inventory.test.ts`) classe chaque fichier de `stores/`.
 *
 * Les chargeurs capturent le handle du projet à leur départ (`capture`) et n'écrivent leur réponse
 * que s'il est encore courant. Il cesse de l'être dès `beginTransition` : pendant la demande, le main
 * sert peut-être déjà l'autre projet. Il ne le redevient pas quand le projet d'avant revient, qui
 * reçoit un nouveau handle : une réponse ignorée pendant la tentative ne revient pas d'elle-même.
 * Ne remplace pas `stillIn` (L05), qui attend l'issue d'une ouverture au lieu de s'arrêter.
 */
import { ProjectChangedError, type ProjectHandle } from '@backend/types/project-handle';

/** Ce que reçoit une remise à zéro : le projet entrant, ou null quand plus aucun n'est ouvert. */
export interface ResetContext {
  to: string | null;
}

type Reset = (ctx: ResetContext) => void;

/** Le projet à l'écran, le temps qu'il y reste et qu'aucune demande au main ne soit partie. */
class Shown implements ProjectHandle {
  private readonly controller = new AbortController();
  readonly signal: AbortSignal = this.controller.signal;

  constructor(
    readonly path: string,
    readonly epoch: number
  ) {}

  isCurrent(): boolean {
    return !this.signal.aborted;
  }

  assertCurrent(): void {
    if (!this.isCurrent()) throw new ProjectChangedError();
  }

  end(): void {
    this.controller.abort();
  }
}

const resets = new Map<string, Reset>();
let epoch = 0;
/** Le dossier du projet à l'écran, tel que le main l'a rendu ; null sans projet. */
let shownPath: string | null = null;
/** Son handle ; null sans projet, et pendant une demande au main. */
let current: Shown | null = null;
let transitioning = false;

function endCurrent(): void {
  current?.end();
  current = null;
}

function show(path: string | null): void {
  current = path === null ? null : new Shown(path, ++epoch);
  transitioning = false;
}

function runResets(to: string | null): void {
  for (const [name, reset] of resets) {
    try {
      reset({ to });
    } catch (error: unknown) {
      console.error(`[project-lifecycle] la remise à zéro « ${name} » a échoué :`, error);
    }
  }
}

export const projectLifecycle = {
  /**
   * Inscrit la remise à zéro d'un store. Un nom déjà inscrit est remplacé (module rechargé), et
   * garde sa place dans l'ordre. Rend le retrait.
   */
  onReset(name: string, reset: Reset): () => void {
    resets.set(name, reset);
    return () => {
      if (resets.get(name) === reset) resets.delete(name);
    };
  },

  /** La demande part au main : plus aucun handle n'est courant jusqu'à son issue. */
  beginTransition(): void {
    endCurrent();
    transitioning = true;
  },

  /**
   * L'écran passe à `path` (le dossier rendu par le main), ou à l'état sans projet. Le même dossier
   * ne remet rien à zéro ; une autre graphie du même dossier le ferait, ce que la réouverture répare.
   */
  enter(path: string | null): void {
    endCurrent();
    if (path !== shownPath) {
      shownPath = path;
      runResets(path);
    }
    show(path);
  },

  /** Le projet d'avant revient, stores intacts : un nouveau handle, aucune remise à zéro. */
  abortTransition(): void {
    if (!transitioning) return;
    show(shownPath);
  },

  /** Le handle du projet à l'écran, à capturer avant une attente ; null sans projet ou pendant une demande. */
  capture(): ProjectHandle | null {
    return current;
  },
};
