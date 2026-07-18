import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { changeOrigin, resolveOrigin } from '../cm/change-origin';
import {
  createRejectionSampler,
  proposals,
  type Proposal,
  type ProposalAdjudicationEvent,
} from '../proposals';
import {
  addProposalEffect,
  resolveProposalEffect,
} from '../proposals/state';

/**
 * Contrat propositionnel (Phase 4) — sémantique du StateField testée sans
 * DOM : remapping, invalidation, application annotée. Les chemins qui
 * exigent une EditorView (boutons, popup, expiration à la destruction)
 * relèvent de la vérification dans l'app réelle.
 */

const LABELS = {
  accept: 'accepter',
  reject: 'rejeter',
  modify: 'modifier',
  rejectionPrompt: 'pourquoi ?',
  apply: 'appliquer',
  cancel: 'annuler',
};

function harness(doc: string) {
  const events: ProposalAdjudicationEvent[] = [];
  const instance = proposals({ onEvent: (e) => events.push(e), labels: LABELS });
  const state = EditorState.create({ doc, extensions: instance.extension });
  return { events, instance, state };
}

function makeProposal(partial: Partial<Proposal>): Proposal {
  return {
    id: partial.id ?? 'p1',
    range: partial.range ?? { from: 0, to: 0 },
    category: partial.category ?? 'test',
    original: partial.original ?? '',
    proposed: partial.proposed ?? '',
    source: partial.source ?? { model: 'unknown', task: 'test' },
    createdAt: partial.createdAt ?? new Date().toISOString(),
  };
}

function pending(state: EditorState, instance: ReturnType<typeof proposals>) {
  return state.field(instance.field);
}

describe('resolveOrigin (Phase 4a)', () => {
  const base = EditorState.create({ doc: 'abc' });

  it('lit l’annotation explicite en priorité', () => {
    const tr = base.update({
      changes: { from: 0, insert: 'x' },
      annotations: changeOrigin.of('programmatic'),
    });
    expect(resolveOrigin(tr)).toBe('programmatic');
  });

  it('dérive la frappe et le collage des userEvents CM6', () => {
    expect(
      resolveOrigin(
        base.update({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' })
      )
    ).toBe('human-input');
    expect(
      resolveOrigin(
        base.update({ changes: { from: 0, to: 1 }, userEvent: 'delete.backward' })
      )
    ).toBe('human-input');
    expect(
      resolveOrigin(
        base.update({ changes: { from: 0, insert: 'x' }, userEvent: 'input.paste' })
      )
    ).toBe('paste');
  });

  it('retourne null quand rien ne permet de résoudre (garde de dev)', () => {
    const tr = base.update({ changes: { from: 0, insert: 'x' } });
    expect(resolveOrigin(tr)).toBeNull();
  });
});

describe('propositions : remapping et invalidation', () => {
  const DOC = 'Hello world, bonjour.';
  const WORLD = { from: 6, to: 11 }; // 'world'

  function withProposal() {
    const h = harness(DOC);
    const state = h.state.update({
      effects: addProposalEffect.of(
        makeProposal({ id: 'p1', range: WORLD, original: 'world', proposed: 'monde' })
      ),
    }).state;
    return { ...h, state };
  }

  it('suit les éditions AVANT le range (décalage)', () => {
    const { events, instance, state } = withProposal();
    const next = state.update({
      changes: { from: 0, insert: 'XX' },
      annotations: changeOrigin.of('programmatic'),
    }).state;
    const [p] = pending(next, instance);
    expect(p.range).toEqual({ from: 8, to: 13 });
    expect(events).toHaveLength(0);
  });

  it('ignore les éditions APRÈS le range', () => {
    const { events, instance, state } = withProposal();
    const next = state.update({
      changes: { from: DOC.length, insert: ' fin' },
      annotations: changeOrigin.of('programmatic'),
    }).state;
    expect(pending(next, instance)[0].range).toEqual(WORLD);
    expect(events).toHaveLength(0);
  });

  it('invalide sur édition humaine DANS le range', () => {
    const { events, instance, state } = withProposal();
    const next = state.update({
      changes: { from: 7, to: 8, insert: 'X' },
      userEvent: 'input.type',
    }).state;
    expect(pending(next, instance)).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      proposalId: 'p1',
      decision: 'invalidated',
      category: 'test',
      original: 'world',
      proposed: 'monde',
    });
  });

  it('invalide une proposition d’insertion quand on tape exactement au point', () => {
    const h = harness(DOC);
    const state = h.state.update({
      effects: addProposalEffect.of(
        makeProposal({ id: 'ins', range: { from: 6, to: 6 }, proposed: 'beau ' })
      ),
    }).state;
    const next = state.update({
      changes: { from: 6, insert: 'y' },
      userEvent: 'input.type',
    }).state;
    expect(pending(next, h.instance)).toHaveLength(0);
    expect(h.events.map((e) => e.decision)).toEqual(['invalidated']);
  });
});

describe('propositions : application (sémantique accept/modify)', () => {
  const DOC = 'Hello world, bonjour.';

  it('accepter remplace le range, retire la proposition, annote la transaction', () => {
    const { events, instance, state } = (() => {
      const h = harness(DOC);
      return {
        ...h,
        state: h.state.update({
          effects: addProposalEffect.of(
            makeProposal({
              id: 'p1',
              range: { from: 6, to: 11 },
              original: 'world',
              proposed: 'monde',
            })
          ),
        }).state,
      };
    })();

    // Transaction équivalente à celle du bouton ✓ (accept()) :
    const tr = state.update({
      changes: { from: 6, to: 11, insert: 'monde' },
      effects: resolveProposalEffect.of('p1'),
      annotations: changeOrigin.of('ai-proposal-accepted'),
    });
    expect(resolveOrigin(tr)).toBe('ai-proposal-accepted');
    expect(tr.state.doc.toString()).toBe('Hello monde, bonjour.');
    expect(pending(tr.state, instance)).toHaveLength(0);
    // resolveProposalEffect retire SANS émettre : pas de double événement
    // (l'événement 'accepted' est émis par la commande avant dispatch).
    expect(events).toHaveLength(0);
  });

  it('l’adjudication d’une proposition invalide une AUTRE proposition chevauchante', () => {
    const h = harness(DOC);
    let state = h.state.update({
      effects: addProposalEffect.of(
        makeProposal({ id: 'a', range: { from: 6, to: 11 }, original: 'world', proposed: 'monde' })
      ),
    }).state;
    state = state.update({
      effects: addProposalEffect.of(
        makeProposal({ id: 'b', range: { from: 9, to: 20 }, proposed: 'x' })
      ),
    }).state;

    const next = state.update({
      changes: { from: 6, to: 11, insert: 'monde' },
      effects: resolveProposalEffect.of('a'),
      annotations: changeOrigin.of('ai-proposal-accepted'),
    }).state;

    expect(pending(next, h.instance)).toHaveLength(0);
    expect(h.events.map((e) => [e.proposalId, e.decision])).toEqual([
      ['b', 'invalidated'],
    ]);
  });
});

describe('échantillonnage des annotations de rejet (arbitrage 1)', () => {
  it('demande le pourquoi 1 rejet sur 5, jamais deux de suite', () => {
    const sample = createRejectionSampler();
    const sequence = Array.from({ length: 10 }, () => sample());
    expect(sequence).toEqual([
      false, false, false, false, true,
      false, false, false, false, true,
    ]);
    for (let i = 1; i < sequence.length; i++) {
      expect(sequence[i - 1] && sequence[i]).toBe(false);
    }
  });
});

describe('latence et horodatage des événements', () => {
  it('calcule une latence positive depuis createdAt', () => {
    const h = harness('abc');
    const created = new Date(Date.now() - 1500).toISOString();
    const state = h.state.update({
      effects: addProposalEffect.of(
        makeProposal({ id: 'p', range: { from: 0, to: 1 }, createdAt: created })
      ),
    }).state;
    // .state force le calcul du champ (les transactions CM6 sont paresseuses)
    void state.update({
      changes: { from: 0, to: 1, insert: 'z' },
      userEvent: 'input.type',
    }).state;
    expect(h.events).toHaveLength(1);
    expect(h.events[0].latencyMs).toBeGreaterThanOrEqual(1400);
    expect(Number.isNaN(Date.parse(h.events[0].at))).toBe(false);
  });
});
