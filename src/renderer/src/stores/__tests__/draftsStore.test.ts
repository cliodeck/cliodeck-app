// @vitest-environment jsdom
/**
 * La file de brouillons, par projet (S16-2-5, décision Q12 de l'auteur).
 *
 * Elle était commune à tous les projets : une réponse mise de côté dans A, faite des sources de A,
 * était proposée à l'insertion dans le manuscrit de B. Un brouillon porte désormais son projet et
 * ne se montre que dans lui ; ceux d'avant cette règle, sans projet connu, restent visibles partout
 * jusqu'à ce qu'ils soient insérés ou jetés, et aucun ne se perd à la mise à jour.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { draftsForProject, useDraftsStore } from '../draftsStore';

const A = '/projets/A';
const B = '/projets/B';
const STORAGE_KEY = 'cliodeck-drafts';

const drafts = () => useDraftsStore.getState();
const shownIn = (projectPath: string | null) => draftsForProject(drafts().drafts, projectPath).map((d) => d.content);

beforeEach(() => {
  localStorage.clear();
  useDraftsStore.setState({ drafts: [], isPanelOpen: false, proposedIds: [] });
});

describe('un brouillon porte son projet', () => {
  it('un brouillon de A n’est pas listé dans B, et l’est dans A', () => {
    drafts().enqueue({ content: 'Réponse de A', projectPath: A });

    expect(shownIn(B)).toEqual([]);
    expect(shownIn(A)).toEqual(['Réponse de A']);
    expect(drafts().drafts[0].projectPath).toBe(A);
  });

  it('sans projet ouvert à sa création : il n’en porte aucun, et se voit partout, comme ceux d’avant', () => {
    drafts().enqueue({ content: 'Sans projet', projectPath: null });

    expect(drafts().drafts[0]).not.toHaveProperty('projectPath');
    expect(shownIn(A)).toEqual(['Sans projet']);
    expect(shownIn(B)).toEqual(['Sans projet']);
    expect(shownIn(null)).toEqual(['Sans projet']);
  });

  it('sans projet à l’écran, ceux d’un projet ne se montrent pas', () => {
    drafts().enqueue({ content: 'Réponse de A', projectPath: A });

    expect(shownIn(null)).toEqual([]);
  });

  it('le chemin se compare tel quel : un projet déplacé ne voit plus les siens, qui restent dans la file', () => {
    drafts().enqueue({ content: 'Réponse de A', projectPath: A });

    expect(shownIn('/ailleurs/A')).toEqual([]);
    expect(drafts().drafts).toHaveLength(1);
  });
});

describe('vider la file ne vide que ce qui est affiché', () => {
  it('dans B : ceux de B et ceux sans projet partent, ceux de A restent', () => {
    drafts().enqueue({ content: 'Réponse de A', projectPath: A });
    drafts().enqueue({ content: 'Réponse de B', projectPath: B });
    drafts().enqueue({ content: 'Sans projet', projectPath: null });

    drafts().clear(B);

    expect(drafts().drafts.map((d) => d.content)).toEqual(['Réponse de A']);
  });

  it('jeter et proposer gardent leur sens : par identifiant, quel que soit le projet', () => {
    drafts().enqueue({ content: 'Réponse de A', projectPath: A });
    const id = drafts().drafts[0].id;

    drafts().setProposed(id, true);
    expect(drafts().proposedIds).toEqual([id]);
    drafts().remove(id);
    expect(drafts().drafts).toEqual([]);
  });
});

describe('la file persistée d’avant la mise à jour', () => {
  /** La file telle que l'écrivait la version d'avant : aucun champ de projet. */
  const BEFORE = {
    state: {
      drafts: [
        {
          id: 'ancien-1',
          content: 'Brouillon d’avant la mise à jour',
          createdAt: '2026-11-01T10:00:00.000Z',
          source: { model: 'qwen3:8b', task: 'brainstorm' },
        },
      ],
      isPanelOpen: true,
    },
    version: 0,
  };

  it('se relit sans rien perdre : visible dans A comme dans B, avec sa source', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(BEFORE));

    await useDraftsStore.persist.rehydrate();

    expect(drafts().drafts).toEqual(BEFORE.state.drafts);
    expect(drafts().isPanelOpen).toBe(true);
    expect(shownIn(A)).toEqual(['Brouillon d’avant la mise à jour']);
    expect(shownIn(B)).toEqual(['Brouillon d’avant la mise à jour']);
  });

  const persisted = () =>
    (JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { state: { drafts: Array<{ content: string }> } }).state
      .drafts;

  it('jeté dans B, il ne revient pas, pas même au redémarrage', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(BEFORE));
    await useDraftsStore.persist.rehydrate();

    drafts().remove('ancien-1');
    await useDraftsStore.persist.rehydrate();

    expect(persisted()).toEqual([]);
    expect(shownIn(A)).toEqual([]);
  });

  it('les nouveaux brouillons gardent leur projet d’un redémarrage à l’autre', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(BEFORE));
    await useDraftsStore.persist.rehydrate();

    drafts().enqueue({ content: 'Réponse de A', projectPath: A });
    await useDraftsStore.persist.rehydrate();

    expect(persisted()).toMatchObject([{ content: 'Réponse de A', projectPath: A }, BEFORE.state.drafts[0]]);
    expect(shownIn(A)).toEqual(['Réponse de A', 'Brouillon d’avant la mise à jour']);
    expect(shownIn(B)).toEqual(['Brouillon d’avant la mise à jour']);
  });
});
