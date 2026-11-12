/**
 * Des vecteurs qui ne vivent pas dans l'espace d'un corpus déjà indexé : une autre dimension (le
 * modèle d'embeddings a changé depuis la première indexation), ou un autre modèle de même dimension
 * (provenance, L07). Une seule classe pour tous les corpus : l'index des PDF la lève (L04-7), celui
 * des sources primaires la reprendra (L06-9).
 *
 * Le refus porte un code, que l'IPC renvoie avec les deux valeurs et que l'interface traduit :
 * jamais le texte brut. Celui qui la lève n'a rien écrit.
 */
export type EmbeddingSpaceMismatch =
  | { kind: 'dimension'; expected: number; actual: number }
  | { kind: 'model'; expected: string; actual: string };

export type EmbeddingSpaceMismatchCode = 'embedding_dimension_mismatch' | 'embedding_model_mismatch';

export class EmbeddingSpaceMismatchError extends Error {
  readonly kind: EmbeddingSpaceMismatch['kind'];
  readonly code: EmbeddingSpaceMismatchCode;
  /** Ce que le corpus contient déjà. */
  readonly expected: number | string;
  /** Ce que le fournisseur vient de produire. */
  readonly actual: number | string;

  constructor(mismatch: EmbeddingSpaceMismatch, message?: string) {
    super(message ?? `Embedding ${mismatch.kind} mismatch: expected ${mismatch.expected}, got ${mismatch.actual}`);
    this.name = 'EmbeddingSpaceMismatchError';
    this.kind = mismatch.kind;
    this.code = mismatch.kind === 'dimension' ? 'embedding_dimension_mismatch' : 'embedding_model_mismatch';
    this.expected = mismatch.expected;
    this.actual = mismatch.actual;
  }
}
