/**
 * Ce qu'est devenu le document ouvert quand le main a demandé de l'écrire.
 *
 * `clean` : rien à écrire. `saved` : écrit. `failed` : l'écriture a échoué, le texte n'est
 * que dans l'éditeur. `untitled` : un tampon sans titre non vide, qui n'a nulle part où
 * s'écrire. `timeout` : le renderer n'a pas répondu à temps. `no-window` : il n'y a personne
 * à qui demander.
 */
export type FlushOutcome = 'clean' | 'saved' | 'failed' | 'untitled' | 'timeout' | 'no-window';

export interface FlushReport {
  outcome: FlushOutcome;
  error?: string;
}
