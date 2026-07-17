/**
 * Contrat propositionnel (plan CM6, Phase 4b).
 *
 * Toute intervention de l'IA dans le document passe par une proposition
 * atomique adjudicable — voir docs/editor-proposals.md. AUCUNE
 * fonctionnalité IA d'écriture ne contourne cette API.
 */

export interface Proposal {
  id: string;
  /** Positions dans le document ; from === to = proposition d'insertion. */
  range: { from: number; to: number };
  /** Catégorie applicative : 'brainstorm-draft', 'ai-insert', 'test'… */
  category: string;
  /** Texte courant du range ('' pour une insertion). */
  original: string;
  /** Texte proposé. */
  proposed: string;
  source: { model: string; task: string };
  /** ISO 8601 — sert au calcul de latence d'adjudication. */
  createdAt: string;
}

export type ProposalDecision =
  | 'accepted'
  | 'rejected'
  | 'modified'
  | 'invalidated'
  | 'expired';

/**
 * Événement d'adjudication émis vers le main (IPC 'proposals:adjudication').
 * Les contenus (original/proposed/final/rejectionNote) sont réservés au
 * journal de recherche ; le journal d'usage IA ne reçoit que les champs
 * décisionnels sans contenu — le routage est fait côté main.
 */
export interface ProposalAdjudicationEvent {
  proposalId: string;
  decision: ProposalDecision;
  category: string;
  model: string;
  task: string;
  latencyMs: number;
  at: string;
  original?: string;
  proposed?: string;
  final?: string;
  rejectionNote?: string;
}

export interface ProposalLabels {
  accept: string;
  reject: string;
  modify: string;
  /** Placeholder du champ « pourquoi ? » (annotation de rejet échantillonnée). */
  rejectionPrompt: string;
  apply: string;
  cancel: string;
}

export interface ProposalsConfig {
  onEvent: (event: ProposalAdjudicationEvent) => void;
  labels: ProposalLabels;
  /**
   * Décide si un rejet donné déclenche le champ « pourquoi ? ».
   * Défaut : 1 rejet sur 5, jamais deux de suite (arbitrage 1 du plan).
   */
  shouldSampleRejection?: () => boolean;
}

/**
 * Échantillonneur par défaut : demande le « pourquoi » au 5e rejet de la
 * session, puis tous les 5 — jamais deux fois de suite par construction.
 */
export function createRejectionSampler(): () => boolean {
  let rejections = 0;
  return () => {
    rejections += 1;
    return rejections % 5 === 0;
  };
}
