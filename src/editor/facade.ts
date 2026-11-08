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
import type { SelectionEdit } from './cm/inline-formatting';
import type { Proposal } from './proposals';

export interface EditorFacade {
  /** Le moteur qui implémente cette façade. */
  readonly engine: 'cm6';

  /** Un deck de diapositives : ses `---` y sont des frontières, pas du texte. */
  readonly isSlideDeck: boolean;

  /** Contenu réel de l'éditeur (source de vérité pour la sauvegarde). */
  getValue(): string;

  /** Offset du curseur (tête de sélection). */
  getCursorOffset(): number;

  /**
   * L'auteur a-t-il posé son curseur dans ce document ? Sinon, `getCursorOffset` rend 0 sans que
   * personne l'ait voulu : un document jamais affiché, ou dont l'état n'est plus mémorisé.
   */
  hasKnownCursor(): boolean;

  /** Texte sélectionné, ou null si la sélection est vide. */
  getSelectionText(): string | null;

  /**
   * Le curseur est-il dans le texte ? Il y reste quand la fenêtre perd le focus le temps d'un
   * menu natif : c'est la question du menu, et `view.hasFocus` répondrait non.
   */
  hasFocus(): boolean;

  /**
   * Remplace la sélection courante (ou insère au curseur) et focus, sauf sur
   * une vue en lecture seule, qui ne change rien.
   * `origin` : annotation changeOrigin de la transaction (Phase 4a),
   * défaut `programmatic`.
   */
  replaceSelection(text: string, origin?: ChangeOrigin): void;

  /**
   * Bascule une marque inline (gras/italique) sur la sélection : wrap si
   * absente, unwrap si présente, placeholder sélectionné si sélection
   * vide. Contrairement à replaceSelection, n'écrase JAMAIS le texte
   * sélectionné (#10). Rien sur une vue en lecture seule. `placeholder` part dans le
   * manuscrit : il est traduit par l'appelant.
   */
  toggleInline?(type: 'bold' | 'italic', placeholder: string): void;

  /**
   * Applique une édition calculée sur la sélection, en une seule étape de Cmd+Z, sélection comprise,
   * et focus. Ses offsets et son texte sont ceux du document : une fin de ligne y vaut 1, quel que
   * soit le fichier. Rend faux si rien n'a changé : vue en lecture seule, ou texte déjà celui-là.
   */
  editSelection(edit: SelectionEdit, origin?: ChangeOrigin): boolean;

  /**
   * Remplace tout le document en une seule édition (annulable d'un coup),
   * en plaçant le curseur à `cursorOffset` si fourni.
   */
  setValue(text: string, cursorOffset?: number, origin?: ChangeOrigin): void;

  /** Ajoute du texte en fin de document. */
  appendText(text: string, origin?: ChangeOrigin): void;

  /**
   * Soumet le texte comme proposition adjudicable (contrat propositionnel,
   * Phase 4b) plutôt que de l'insérer, et l'amène à l'écran, curseur compris :
   * Tab et Échap n'agissent qu'à son endroit. Retourne false sur une vue en
   * lecture seule : l'accepter n'y écrirait rien. L'appelant garde alors son
   * texte, sans jamais retomber sur une insertion directe.
   */
  propose(proposal: Partial<Proposal>): boolean;

  /**
   * Fait défiler jusqu'à la ligne (1-indexée), y place le curseur, focus. Sans le focus si
   * `focus: false` : une fenêtre encore ouverte par-dessus l'éditeur garde la main, et une
   * frappe ne part pas derrière elle.
   */
  revealLine(lineNumber: number, options?: { focus?: boolean }): void;

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
