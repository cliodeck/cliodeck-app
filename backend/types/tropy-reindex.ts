/**
 * La réindexation complète des sources primaires (H7), telle que le main la dit au renderer
 * (`tropy:reindex-progress`, `tropy:get-reindex-status`).
 *
 * Une fois par projet, à son ouverture, les extraits écrits avant la version courante
 * (`TROPY_CHUNKS_VERSION`) sont refaits en arrière-plan, source par source. Imposée à
 * l'historien, elle doit être dite avec ce qu'elle coûte, et reprise sans perte après une
 * interruption.
 */
export type TropyReindexStatus =
  /** Rien à refaire, ou plus rien à dire. */
  | { phase: 'idle' }
  /**
   * `done` sources traitées sur `total` ; `chunks` : les extraits à refaire, comptés au départ.
   * `waitingForSync` : en pause, une synchronisation Tropy a la main ; la passe reprend après.
   */
  | { phase: 'running'; done: number; total: number; chunks: number; waitingForSync: boolean }
  /**
   * Arrêtée sans rien perdre, comme l'embarquement de la synchro (mêmes causes, même
   * vocabulaire) : `remaining` sources gardent leurs anciens extraits et leur marque, et la passe
   * reprend à la prochaine ouverture du projet.
   */
  | { phase: 'stopped'; reason: 'no-embedding-provider' | 'embedding-failed'; total: number; remaining: number }
  /** Finie : `total` sources refaites. Le renderer le dit un moment, puis l'efface. */
  | { phase: 'done'; total: number };
