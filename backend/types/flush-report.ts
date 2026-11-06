/**
 * Ce qu'est devenu le document ouvert quand le main a demandé de l'écrire.
 *
 * `clean` : rien à écrire. `saved` : écrit. `failed` : l'écriture a échoué, ou n'a pas répondu
 * à temps, et le texte n'est sûr que dans l'éditeur. `untitled` : un tampon sans titre non
 * vide, qui n'a nulle part où s'écrire. `timeout` : le renderer n'a même pas reçu la demande
 * à temps : il est bloqué. `no-window` : il n'y a personne à qui demander.
 */
export type FlushOutcome = 'clean' | 'saved' | 'failed' | 'untitled' | 'timeout' | 'no-window';

export interface FlushReport {
  outcome: FlushOutcome;
  error?: string;
  /**
   * Avec `failed` : l'écriture n'a pas échoué, elle n'a pas répondu à temps et court encore. Elle
   * peut aboutir si l'auteur reste ; la question le dit autrement qu'un échec.
   */
  stillWriting?: true;
}
