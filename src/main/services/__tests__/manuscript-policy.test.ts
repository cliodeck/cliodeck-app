/**
 * La place du manuscrit dans un tour : une table de préséance, pas une
 * suite de conditions dispersées (docs/poids-du-manuscrit.md, palier 2).
 */
import { describe, expect, it } from 'vitest';
import {
  backgroundSlots,
  normalizeStance,
  recallSlots,
  resolveManuscriptPolicy,
  resolveReadingNotesPolicy,
  shouldIncludeManuscript,
  type ManuscriptPolicyInput,
  type ReadingNotesPolicyInput,
} from '../manuscript-policy.js';
import { manuscriptSlots } from '../retrieval-quota.js';

const open = (over: Partial<ManuscriptPolicyInput> = {}): ManuscriptPolicyInput => ({
  enabled: true,
  sourceType: 'both',
  recallIntent: false,
  topK: 10,
  ...over,
});

describe('normalizeStance', () => {
  it('accepte les trois postures et ramène tout le reste à recall', () => {
    expect(normalizeStance('off')).toBe('off');
    expect(normalizeStance('background')).toBe('background');
    expect(normalizeStance('recall')).toBe('recall');
    expect(normalizeStance(undefined)).toBe('recall');
    expect(normalizeStance('BACKGROUND')).toBe('recall');
    expect(normalizeStance(42)).toBe('recall');
  });
});

describe('largeurs de bande', () => {
  it('une question de rappel obtient jusqu’à six places, jamais toutes', () => {
    expect(recallSlots(10)).toBe(6);
    expect(recallSlots(20)).toBe(6);
    expect(recallSlots(5)).toBe(4);
    expect(recallSlots(2)).toBe(1);
    // Une seule place : elle va à la question posée.
    expect(recallSlots(1)).toBe(1);
    expect(recallSlots(0)).toBe(0);
  });

  it('l’arrière-plan se contente d’une ou deux places', () => {
    expect(backgroundSlots(10)).toBe(2);
    expect(backgroundSlots(20)).toBe(2);
    expect(backgroundSlots(5)).toBe(1);
    expect(backgroundSlots(1)).toBe(0);
  });
});

describe('shouldIncludeManuscript — le manuscrit sort d’une recherche cadrée', () => {
  it('entre dans une recherche ouverte, sort quand l’utilisateur a dit de quoi il parle', () => {
    expect(shouldIncludeManuscript({ enabled: true, sourceType: 'both' })).toBe(true);
    expect(shouldIncludeManuscript({ enabled: true, sourceType: 'both', documentIds: [] })).toBe(
      true
    );
    expect(shouldIncludeManuscript({ enabled: false, sourceType: 'both' })).toBe(false);
    expect(shouldIncludeManuscript({ enabled: true, sourceType: 'vault' })).toBe(false);
    expect(shouldIncludeManuscript({ enabled: true, sourceType: 'readingNotes' })).toBe(false);
    expect(
      shouldIncludeManuscript({ enabled: true, sourceType: 'both', documentIds: ['d1'] })
    ).toBe(false);
    expect(
      shouldIncludeManuscript({ enabled: true, sourceType: 'both', collectionKeys: ['ABC'] })
    ).toBe(false);
  });
});

describe('resolveManuscriptPolicy — préséance', () => {
  it('sans index, rien, quoi qu’on demande', () => {
    const p = resolveManuscriptPolicy(open({ enabled: false, recallIntent: true }));
    expect(p).toMatchObject({ include: false, slots: 0, reason: 'disabled' });
  });

  it('la portée « manuscrit seul » lui donne toutes les places et sa propre consigne', () => {
    const p = resolveManuscriptPolicy(open({ sourceType: 'manuscript', requested: false }));
    expect(p).toMatchObject({ include: true, slots: 10, wording: 'only', reason: 'scope-only' });
  });

  it('une question de rappel l’emporte sur la case décochée et sur la posture du mode', () => {
    const p = resolveManuscriptPolicy(
      open({ recallIntent: true, requested: false, stance: 'off' })
    );
    expect(p).toMatchObject({
      include: true,
      slots: 6,
      wording: 'recall',
      reason: 'recall-intent',
      stance: 'off',
    });
  });

  it('une question de rappel l’emporte aussi sur une sélection de documents', () => {
    const p = resolveManuscriptPolicy(open({ recallIntent: true, documentIds: ['d1'] }));
    expect(p.include).toBe(true);
    expect(p.reason).toBe('recall-intent');
  });

  it('une recherche cadrée l’écarte, même case cochée', () => {
    expect(resolveManuscriptPolicy(open({ documentIds: ['d1'], requested: true })).reason).toBe(
      'scope-restricted'
    );
    expect(resolveManuscriptPolicy(open({ collectionKeys: ['K'] })).include).toBe(false);
    expect(resolveManuscriptPolicy(open({ sourceType: 'vault' })).include).toBe(false);
  });

  it('la case décochée l’écarte — c’est le défaut de l’espace Brainstorm', () => {
    const p = resolveManuscriptPolicy(open({ requested: false }));
    expect(p).toMatchObject({ include: false, reason: 'toggle-off' });
  });

  it('un mode « off » l’écarte quand la case ne dit rien', () => {
    expect(resolveManuscriptPolicy(open({ stance: 'off' })).reason).toBe('stance-off');
    expect(resolveManuscriptPolicy(open({ stance: 'off', requested: true })).reason).toBe(
      'stance-off'
    );
  });

  it('un mode « background » le réduit à deux places et change la consigne', () => {
    const p = resolveManuscriptPolicy(open({ stance: 'background', topK: 20 }));
    expect(p).toMatchObject({ include: true, slots: 2, wording: 'background', reason: 'background' });
  });

  it('par défaut, la bande ordinaire et la consigne de rappel', () => {
    const p = resolveManuscriptPolicy(open());
    expect(p).toMatchObject({
      include: true,
      slots: manuscriptSlots(10),
      wording: 'recall',
      stance: 'recall',
      reason: 'default',
    });
    // Un appelant historique n'envoie pas la case : admis.
    expect(resolveManuscriptPolicy(open({ requested: undefined })).include).toBe(true);
    // Une posture inconnue vaut recall.
    expect(resolveManuscriptPolicy(open({ stance: 'loud' })).reason).toBe('default');
  });
});

describe('resolveReadingNotesPolicy — même préséance, sauf la portée restreinte qui cadre au lieu d’écarter', () => {
  const notes = (over: Partial<ReadingNotesPolicyInput> = {}): ReadingNotesPolicyInput => ({
    enabled: true,
    sourceType: 'both',
    recallIntent: false,
    topK: 10,
    ...over,
  });

  it('sans index ou sans consentement (décidé par l’appelant), rien', () => {
    expect(resolveReadingNotesPolicy(notes({ enabled: false, recallIntent: true })).reason).toBe(
      'disabled'
    );
  });

  it('notes seules : toutes les places et la consigne de périmètre', () => {
    expect(resolveReadingNotesPolicy(notes({ sourceType: 'readingNotes', requested: false }))).toMatchObject(
      { include: true, slots: 10, wording: 'only', reason: 'scope-only' }
    );
  });

  it('une question sur les notes l’emporte sur la case et la posture', () => {
    expect(
      resolveReadingNotesPolicy(notes({ recallIntent: true, requested: false, stance: 'off' }))
    ).toMatchObject({ include: true, slots: 6, reason: 'recall-intent' });
  });

  it('la case décochée écarte (défaut de l’espace Brainstorm), puis la posture « off »', () => {
    expect(resolveReadingNotesPolicy(notes({ requested: false })).reason).toBe('toggle-off');
    expect(resolveReadingNotesPolicy(notes({ stance: 'off' })).reason).toBe('stance-off');
  });

  it('« background » : deux places et la consigne d’arrière-plan ; défaut : la bande', () => {
    expect(resolveReadingNotesPolicy(notes({ stance: 'background', topK: 20 }))).toMatchObject({
      slots: 2,
      wording: 'background',
    });
    expect(resolveReadingNotesPolicy(notes())).toMatchObject({
      include: true,
      slots: manuscriptSlots(10),
      reason: 'default',
    });
  });

  it('manuscrit seul avec la case des notes cochée : les notes entrent avec leur bande, posture du mode ou pas', () => {
    expect(resolveReadingNotesPolicy(notes({ sourceType: 'manuscript', requested: true }))).toMatchObject(
      { include: true, slots: manuscriptSlots(10), reason: 'scope-only' }
    );
    // Le texte de l'auteur seul est une portée explicite : elle l'emporte sur
    // « off », comme la ligne de portée du renderer le prédit.
    expect(
      resolveReadingNotesPolicy(notes({ sourceType: 'manuscript', requested: true, stance: 'off' }))
        .include
    ).toBe(true);
    expect(resolveReadingNotesPolicy(notes({ sourceType: 'manuscript', requested: false })).include).toBe(
      false
    );
    // Un appelant historique (« manuscrit seul », rien sur les notes) : le
    // manuscrit seul, vraiment — la revue de la pile avait vu les notes s'y
    // glisser.
    expect(resolveReadingNotesPolicy(notes({ sourceType: 'manuscript' }))).toMatchObject({
      include: false,
      reason: 'scope-restricted',
    });
  });

  it('notes Obsidian seules : écartées comme le manuscrit, sauf question de rappel', () => {
    expect(resolveReadingNotesPolicy(notes({ sourceType: 'vault' })).reason).toBe('scope-restricted');
    expect(resolveReadingNotesPolicy(notes({ sourceType: 'vault', recallIntent: true })).include).toBe(
      true
    );
  });
});
