import { StateEffect, StateField, type EditorState, type Transaction } from '@codemirror/state';
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

/**
 * Le texte que la transaction ajoute au bout du document vient après les propositions en attente :
 * la définition d'une note (L01-6). `from`…`to` est sa plage dans le document de départ : vide pour
 * l'ajout, le texte même pour son retrait par Cmd+Z (voir `invertAfterProposals`). Ce changement ne
 * touche pas la proposition qui finit à `from`, qui reste devant lui. Toute autre édition de la
 * transaction compte comme d'habitude.
 */
export const afterProposalsEffect = StateEffect.define<{ from: number; to: number }>({
  map: ({ from, to }, mapping) => ({ from: mapping.mapPos(from, -1), to: mapping.mapPos(to, 1) }),
});

/**
 * Pour l'historique (`invertedEffects`) : Cmd+Z retire l'ajout, Cmd+Maj+Z le remet, et l'un comme
 * l'autre reste après les propositions. Sans cela, le retrait commencerait sur la proposition qui
 * attend devant lui, et la retirerait.
 */
export function invertAfterProposals(tr: Transaction): readonly StateEffect<unknown>[] {
  return afterProposalsRanges(tr).map(({ from, to }) =>
    afterProposalsEffect.of({ from: tr.changes.mapPos(from, -1), to: tr.changes.mapPos(to, 1) })
  );
}

function afterProposalsRanges(tr: Transaction): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  for (const e of tr.effects) if (e.is(afterProposalsEffect)) ranges.push(e.value);
  return ranges;
}

/**
 * Ces changements (offsets du document de longueur `docLength`) peuvent-ils porter
 * `afterProposalsEffect` ? Oui si l'un d'eux, marqué `afterProposals`, est une insertion pure au
 * bout du document, et qu'aucun autre n'atteint ce bout : CM6 les fondrait en un seul changement,
 * et l'autre toucherait la proposition qui finit là.
 */
export function appendsAfterProposals(
  changes: ReadonlyArray<{ from: number; to: number; afterProposals?: boolean }>,
  docLength: number
): boolean {
  return (
    changes.some((c) => c.afterProposals === true && c.from === docLength && c.to === docLength) &&
    !changes.some((c) => c.afterProposals !== true && c.to === docLength)
  );
}

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
        // Le texte ajouté au bout du document après les propositions, ou retiré par Cmd+Z
        // (`afterProposalsEffect`) : il ne touche pas la proposition qui finit devant lui.
        const docEnd = tr.startState.doc.length;
        const after = afterProposalsRanges(tr);
        const isAfter = (fromA: number, toA: number) =>
          toA === docEnd && after.some((r) => r.from === fromA && r.to === toA);
        const appendsAtEnd = isAfter(docEnd, docEnd);
        const kept: PendingProposal[] = [];
        for (const p of proposals) {
          let touched = false;
          tr.changes.iterChangedRanges((fromA, toA) => {
            if (isAfter(fromA, toA)) return;
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
              // Une proposition d'insertion posée au bout du document reste devant l'ajout : sa fin y
              // reste déjà (-1), son début la suit.
              from: tr.changes.mapPos(p.range.from, appendsAtEnd && p.range.from === docEnd ? -1 : 1),
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
