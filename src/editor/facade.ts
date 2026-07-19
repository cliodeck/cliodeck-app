/**
 * Façade éditeur-agnostique (plan CM6, Phase 1).
 *
 * Point de contact unique entre l'application (Slides, store, IPC) et
 * l'éditeur CM6 : point de contact unique des Slides, de l'IPC et des
 * insertions du store (introduite en Phase 1 pour découpler l'app des
 * moteurs d'éditeur ; seul CM6 subsiste depuis la Phase 5).
 *
 * Contrat : positions en offsets de caractères dans le document, lignes
 * numérotées à partir de 1. Aucune méthode ne passe par l'état React —
 * la façade parle à l'instance d'éditeur vivante.
 */
import type { ChangeOrigin } from './cm/change-origin';
import type { Proposal } from './proposals';

export interface EditorFacade {
  /** Le moteur qui implémente cette façade. */
  readonly engine: 'cm6';

  /** Contenu réel de l'éditeur (source de vérité pour la sauvegarde). */
  getValue(): string;

  /** Offset du curseur (tête de sélection). */
  getCursorOffset(): number;

  /** Texte sélectionné, ou null si la sélection est vide. */
  getSelectionText(): string | null;

  /**
   * Remplace la sélection courante (ou insère au curseur) et focus.
   * `origin` : annotation changeOrigin de la transaction (Phase 4a),
   * défaut `programmatic`.
   */
  replaceSelection(text: string, origin?: ChangeOrigin): void;

  /**
   * Remplace tout le document en une seule édition (annulable d'un coup),
   * en plaçant le curseur à `cursorOffset` si fourni.
   */
  setValue(text: string, cursorOffset?: number, origin?: ChangeOrigin): void;

  /** Ajoute du texte en fin de document. */
  appendText(text: string, origin?: ChangeOrigin): void;

  /**
   * Soumet le texte comme proposition adjudicable (contrat propositionnel,
   * Phase 4b) plutôt que de l'insérer. Retourne false si l'extension de
   * propositions n'est pas active — l'appelant retombe alors sur une
   * insertion directe.
   */
  propose?(proposal: Partial<Proposal>): boolean;

  /** Fait défiler jusqu'à la ligne (1-indexée), y place le curseur, focus. */
  revealLine(lineNumber: number): void;

  focus(): void;

  /**
   * S'abonne aux changements du document. Retourne la fonction de
   * désabonnement. Le callback reçoit le contenu courant.
   */
  onContentChange(callback: (content: string) => void): () => void;

  /**
   * S'abonne aux déplacements du curseur (tête de sélection, en offset),
   * y compris après édition. Retourne le désabonnement.
   *
   * Optionnel : un moteur qui ne sait pas observer la sélection l'omet, et
   * les consommateurs (synchro preview ↔ curseur, slide active du
   * navigateur) se contentent alors de leur autre source de vérité.
   */
  onSelectionChange?(callback: (offset: number) => void): () => void;
}
