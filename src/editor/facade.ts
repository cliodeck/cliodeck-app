/**
 * Façade éditeur-agnostique (plan CM6, Phase 1).
 *
 * Point de contact unique entre l'application (Slides, store, IPC) et
 * l'éditeur actif : elle remplace les accès directs à l'API Monaco
 * (`editorStore.monacoEditor`) et permet à CM6 et Monaco de coexister
 * derrière le flag `editor.engine` pendant la transition.
 *
 * Contrat : positions en offsets de caractères dans le document, lignes
 * numérotées à partir de 1. Aucune méthode ne passe par l'état React —
 * la façade parle à l'instance d'éditeur vivante.
 */
import type { ChangeOrigin } from './cm/change-origin';
import type { Proposal } from './proposals';

export interface EditorFacade {
  /** Le moteur qui implémente cette façade. */
  readonly engine: 'cm6' | 'monaco';

  /** Contenu réel de l'éditeur (source de vérité pour la sauvegarde). */
  getValue(): string;

  /** Offset du curseur (tête de sélection). */
  getCursorOffset(): number;

  /** Texte sélectionné, ou null si la sélection est vide. */
  getSelectionText(): string | null;

  /**
   * Remplace la sélection courante (ou insère au curseur) et focus.
   * `origin` : annotation changeOrigin de la transaction (Phase 4a),
   * défaut `programmatic` — CM6 seulement, Monaco l'ignore.
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
   * Phase 4b) plutôt que de l'insérer. Retourne false si le moteur ne
   * supporte pas les propositions (Monaco/Milkdown) — l'appelant retombe
   * alors sur son comportement historique.
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
}
