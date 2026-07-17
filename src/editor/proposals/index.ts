import { EditorSelection, type Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { changeOrigin } from '../cm/change-origin';
import {
  addProposalEffect,
  createProposalsField,
  makeAdjudicationEvent,
  resolveProposalEffect,
  setProposalUiEffect,
  type PendingProposal,
  type ProposalsField,
} from './state';
import {
  proposalDecorations,
  proposalExpiry,
  proposalKeymap,
  proposalTheme,
  type ProposalUiHandlers,
} from './ui';
import {
  createRejectionSampler,
  type Proposal,
  type ProposalsConfig,
} from './types';

export type {
  Proposal,
  ProposalAdjudicationEvent,
  ProposalDecision,
  ProposalLabels,
  ProposalsConfig,
} from './types';
export { createRejectionSampler } from './types';
export type { PendingProposal } from './state';

let idCounter = 0;
function generateId(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c?.randomUUID) return c.randomUUID();
  idCounter += 1;
  return `proposal-${Date.now()}-${idCounter}`;
}

export interface ProposalsInstance {
  extension: Extension;
  field: ProposalsField;
  /** Injecte une proposition (défauts : curseur, catégorie 'test'). */
  inject: (view: EditorView, partial: Partial<Proposal>) => Proposal;
  accept: (view: EditorView, id: string) => boolean;
  reject: (view: EditorView, id: string) => boolean;
  applyModified: (view: EditorView, id: string, final: string) => boolean;
}

/**
 * L'unique voie d'entrée de l'IA dans l'éditeur (plan CM6, Phase 4b).
 * Voir docs/editor-proposals.md — aucune fonctionnalité IA d'écriture ne
 * contourne cette API.
 */
export function proposals(config: ProposalsConfig): ProposalsInstance {
  const sample = config.shouldSampleRejection ?? createRejectionSampler();
  const field = createProposalsField(config);

  const find = (view: EditorView, id: string): PendingProposal | undefined =>
    view.state.field(field).find((p) => p.id === id);

  const accept = (view: EditorView, id: string): boolean => {
    const p = find(view, id);
    if (!p) return false;
    config.onEvent(makeAdjudicationEvent(p, 'accepted'));
    view.dispatch({
      changes: { from: p.range.from, to: p.range.to, insert: p.proposed },
      selection: EditorSelection.cursor(p.range.from + p.proposed.length),
      effects: resolveProposalEffect.of(id),
      annotations: changeOrigin.of('ai-proposal-accepted'),
    });
    view.focus();
    return true;
  };

  const submitRejection = (
    view: EditorView,
    id: string,
    note: string | null
  ): void => {
    const p = find(view, id);
    if (!p) return;
    config.onEvent(
      makeAdjudicationEvent(p, 'rejected', {
        rejectionNote: note ?? undefined,
      })
    );
    view.dispatch({ effects: resolveProposalEffect.of(id) });
    view.focus();
  };

  const reject = (view: EditorView, id: string): boolean => {
    const p = find(view, id);
    if (!p) return false;
    if (p.ui === 'buttons' && sample()) {
      // Annotation de rejet échantillonnée (arbitrage 1) : champ « pourquoi ? »
      // non bloquant — Entrée envoie, Échap/clic dehors passe.
      view.dispatch({ effects: setProposalUiEffect.of({ id, ui: 'note' }) });
      return true;
    }
    submitRejection(view, id, null);
    return true;
  };

  const applyModified = (
    view: EditorView,
    id: string,
    final: string
  ): boolean => {
    const p = find(view, id);
    if (!p) return false;
    config.onEvent(makeAdjudicationEvent(p, 'modified', { final }));
    view.dispatch({
      changes: { from: p.range.from, to: p.range.to, insert: final },
      selection: EditorSelection.cursor(p.range.from + final.length),
      effects: resolveProposalEffect.of(id),
      annotations: changeOrigin.of('ai-proposal-modified'),
    });
    view.focus();
    return true;
  };

  const handlers: ProposalUiHandlers = {
    accept,
    reject,
    submitRejection,
    startModify: (view, id) =>
      view.dispatch({ effects: setProposalUiEffect.of({ id, ui: 'modify' }) }),
    cancelUi: (view, id) =>
      view.dispatch({ effects: setProposalUiEffect.of({ id, ui: 'buttons' }) }),
    applyModified,
  };

  const inject = (view: EditorView, partial: Partial<Proposal>): Proposal => {
    const doc = view.state.doc;
    const head = view.state.selection.main.head;
    const from = Math.max(0, Math.min(partial.range?.from ?? head, doc.length));
    const to = Math.max(from, Math.min(partial.range?.to ?? from, doc.length));
    const proposal: Proposal = {
      id: partial.id ?? generateId(),
      range: { from, to },
      category: partial.category ?? 'test',
      original: partial.original ?? view.state.sliceDoc(from, to),
      proposed: partial.proposed ?? '',
      source: partial.source ?? { model: 'unknown', task: 'test' },
      createdAt: partial.createdAt ?? new Date().toISOString(),
    };
    view.dispatch({ effects: addProposalEffect.of(proposal) });
    return proposal;
  };

  return {
    extension: [
      field,
      proposalDecorations(field, config.labels, handlers),
      proposalKeymap(field, handlers),
      proposalExpiry(field, (p) =>
        config.onEvent(makeAdjudicationEvent(p, 'expired'))
      ),
      proposalTheme,
    ],
    field,
    inject,
    accept,
    reject,
    applyModified,
  };
}
