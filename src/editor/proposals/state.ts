import { StateEffect, StateField, type EditorState } from '@codemirror/state';
import type {
  Proposal,
  ProposalAdjudicationEvent,
  ProposalDecision,
  ProposalsConfig,
} from './types';

/**
 * État des propositions en attente : remapping des ranges à chaque édition,
 * invalidation quand une édition non-adjudicative touche un range.
 */

/** Proposition en attente + état d'UI (saisie de note / mode modification). */
export interface PendingProposal extends Proposal {
  ui: 'buttons' | 'note' | 'modify';
}

export const addProposalEffect = StateEffect.define<Proposal>();
/** Retire une proposition SANS émettre — l'appelant a déjà émis l'événement. */
export const resolveProposalEffect = StateEffect.define<string>();
export const setProposalUiEffect = StateEffect.define<{
  id: string;
  ui: PendingProposal['ui'];
}>();

export function makeAdjudicationEvent(
  proposal: Proposal,
  decision: ProposalDecision,
  extra?: { final?: string; rejectionNote?: string }
): ProposalAdjudicationEvent {
  const created = Date.parse(proposal.createdAt);
  return {
    proposalId: proposal.id,
    decision,
    category: proposal.category,
    model: proposal.source.model,
    task: proposal.source.task,
    latencyMs: Number.isFinite(created) ? Math.max(0, Date.now() - created) : 0,
    at: new Date().toISOString(),
    original: proposal.original,
    proposed: proposal.proposed,
    ...extra,
  };
}

export function createProposalsField(config: ProposalsConfig) {
  return StateField.define<readonly PendingProposal[]>({
    create: () => [],
    update(value, tr) {
      let proposals = value;

      for (const effect of tr.effects) {
        if (effect.is(addProposalEffect)) {
          proposals = [...proposals, { ...effect.value, ui: 'buttons' }];
        } else if (effect.is(resolveProposalEffect)) {
          proposals = proposals.filter((p) => p.id !== effect.value);
        } else if (effect.is(setProposalUiEffect)) {
          proposals = proposals.map((p) =>
            p.id === effect.value.id ? { ...p, ui: effect.value.ui } : p
          );
        }
      }

      if (tr.docChanged && proposals.length > 0) {
        const kept: PendingProposal[] = [];
        for (const p of proposals) {
          let touched = false;
          tr.changes.iterChangedRanges((fromA, toA) => {
            if (fromA <= p.range.to && toA >= p.range.from) touched = true;
          });
          if (touched) {
            // Une édition qui touche le range retire la proposition. Le plan
            // exige l'invalidation sur édition humaine ; on l'applique aussi
            // aux éditions programmatiques (ex. renumérotation) et aux
            // adjudications d'AUTRES propositions chevauchantes : un range
            // dont le contenu a changé n'est plus adjudicable tel quel.
            // (La proposition en cours d'adjudication, elle, est retirée par
            // resolveProposalEffect AVANT ce balayage — pas de double émission.)
            config.onEvent(makeAdjudicationEvent(p, 'invalidated'));
            continue;
          }
          kept.push({
            ...p,
            range: {
              from: tr.changes.mapPos(p.range.from, 1),
              to: tr.changes.mapPos(p.range.to, -1),
            },
          });
        }
        proposals = kept.filter((p) => p.range.to >= p.range.from);
      }

      return proposals;
    },
  });
}

export type ProposalsField = ReturnType<typeof createProposalsField>;

export function proposalAt(
  state: EditorState,
  field: ProposalsField,
  pos: number
): PendingProposal | undefined {
  return state
    .field(field)
    .find((p) => p.range.from <= pos && pos <= p.range.to);
}
