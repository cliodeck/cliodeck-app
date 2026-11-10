/**
 * Le projet dans lequel une opération a commencé (L03-3).
 *
 * Une opération longue capture le handle au départ puis, après chaque attente, se demande s'il est
 * encore courant : sinon elle s'arrête, sans rien écrire dans le projet suivant. `signal` s'avorte
 * dès que la fermeture de cette ouverture commence (bascule, fermeture) : un `fetch`, une recette
 * ou une opération annulable s'y abonnent.
 */
export interface ProjectHandle {
  /** Le dossier du projet. */
  readonly path: string;
  /**
   * Le numéro de cette ouverture. Rouvrir le même dossier après une fermeture en tire un nouveau :
   * deux handles du même projet ne sont pas la même ouverture.
   */
  readonly epoch: number;
  /**
   * Avorté dès que la fermeture de cette ouverture commence. Sans raison personnalisée, comme
   * `operations` (règle 3 de `cancellable-operation.ts`) : un `fetch` coupé rejette en `AbortError`.
   */
  readonly signal: AbortSignal;
  /** Cette ouverture est-elle toujours celle du projet courant ? */
  isCurrent(): boolean;
  /** Lève `ProjectChangedError` si elle ne l'est plus. */
  assertCurrent(): void;
}

/**
 * Le projet a changé pendant l'opération. Le message est le mot que l'IPC renvoie tel quel
 * (`errorResponse`) et que le renderer reconnaît (`refusedAsProjectChanged`) : `project-changed`,
 * le même refus que celui des handlers de L05 et du service MCP.
 */
export class ProjectChangedError extends Error {
  readonly code = 'project-changed' as const;

  constructor() {
    super('project-changed');
    this.name = 'ProjectChangedError';
  }
}
