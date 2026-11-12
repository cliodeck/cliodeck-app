/**
 * La réindexation complète des sources primaires (H7), telle que le main la dit au renderer
 * (`tropy:reindex-progress`, `tropy:get-reindex-status`).
 *
 * Une fois par projet, à son ouverture, les extraits écrits avant la version courante
 * (`TROPY_CHUNKS_VERSION`) sont refaits en arrière-plan, source par source. Imposée à
 * l'historien, elle doit être dite avec ce qu'elle coûte, et reprise sans perte après une
 * interruption.
 *
 * Après un changement de modèle d'embeddings, la même passe réembarque les sources dont les
 * extraits sont à une autre dimension que celle du nouveau modèle (J7), mais seulement quand
 * l'historien l'a confirmée (Q29) : `cause: 'model-change'`. Interrompue, elle ne reprend pas
 * seule ; elle est proposée de nouveau (`TropyReembedProposal`).
 */
export type TropyReindexStatus =
  /** Rien à refaire, ou plus rien à dire. */
  | { phase: 'idle' }
  /**
   * `done` sources traitées sur `total` ; `chunks` : les extraits à refaire, comptés au départ.
   * `waitingForSync` : en pause, une synchronisation Tropy a la main ; la passe reprend après.
   */
  | { phase: 'running'; cause?: 'model-change'; done: number; total: number; chunks: number; waitingForSync: boolean }
  /**
   * Arrêtée sans rien perdre, comme l'embarquement de la synchro (mêmes causes, même
   * vocabulaire) : `remaining` sources gardent leurs anciens extraits. Celle d'ouverture garde leur
   * marque et reprend à la prochaine ouverture du projet ; celle d'un changement de modèle est
   * proposée de nouveau.
   */
  | {
      phase: 'stopped';
      cause?: 'model-change';
      reason: 'no-embedding-provider' | 'embedding-failed';
      total: number;
      remaining: number;
    }
  /** Finie : `total` sources refaites. Le renderer le dit un moment, puis l'efface. */
  | { phase: 'done'; cause?: 'model-change'; total: number }
  /**
   * Plus aucune source à refaire, mais l'index de recherche relu du disque n'a pas `missing`
   * extraits de la base : l'app a été quittée sans l'enregistrer, par exemple pendant la
   * reconstruction finale d'une passe. Il se reconstruit par tranches ; d'ici là, la recherche par
   * le sens ne trouve pas ces extraits. `cause: 'model-change'` : l'index n'a pas été perdu, il
   * passe à la dimension du modèle d'embeddings que les Paramètres viennent de choisir.
   */
  | { phase: 'rebuilding-index'; cause?: 'model-change'; missing: number }
  /** L'index de recherche reconstruit. Le renderer le dit un moment, puis l'efface. */
  | { phase: 'index-rebuilt'; cause?: 'model-change' };

/**
 * La réindexation que le panneau des sources primaires propose après un changement de modèle
 * d'embeddings (J7, Q29) : `sources` sources ont des extraits calculés par un autre modèle, de
 * `expected` dimensions, que les questions du nouveau, de `actual` dimensions, ne peuvent pas
 * comparer. `chunks` : leurs extraits avant la passe, qui redécoupe chaque source et peut en
 * changer le nombre. Proposée, jamais faite d'office : `tropy:reembed`, après confirmation.
 */
export interface TropyReembedProposal {
  sources: number;
  chunks: number;
  expected: number;
  actual: number;
}
