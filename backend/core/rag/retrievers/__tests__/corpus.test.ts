/**
 * Interface commune des corpus (Path A′) : table de vérité de la portée et
 * parcours des corpus avec succès partiel.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CORPUS_ORDER,
  corporaInScope,
  fanOutCorpora,
  type CorpusId,
  type CorpusRetriever,
} from '../corpus.js';

interface Hit {
  id: string;
  similarity: number;
}

const options = { topK: 5, threshold: 0.12 };

function retriever(corpus: CorpusId, result: Hit[] | Error): CorpusRetriever<Hit> {
  return {
    corpus,
    search: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

describe('corporaInScope', () => {
  const cases: Array<[Parameters<typeof corporaInScope>[0], CorpusId[]]> = [
    [{}, ['secondary', 'primary']],
    [{ sourceType: 'both' }, ['secondary', 'primary']],
    [{ sourceType: 'secondary' }, ['secondary']],
    [{ sourceType: 'primary' }, ['primary']],
    [{ sourceType: 'vault' }, ['vault']],
    // Le mode « notes seules » implique les notes, drapeau ou pas.
    [{ sourceType: 'vault', includeVault: false }, ['vault']],
    [{ sourceType: 'manuscript' }, ['manuscript']],
    [{ sourceType: 'both', includeVault: true }, ['secondary', 'primary', 'vault']],
    [{ sourceType: 'secondary', includeManuscript: true }, ['secondary', 'manuscript']],
    [
      { sourceType: 'both', includeVault: true, includeManuscript: true },
      ['secondary', 'primary', 'vault', 'manuscript'],
    ],
    // Les notes de lecture n'ont pas de mode « seules » : elles s'ajoutent.
    [{ sourceType: 'secondary', includeReadingNotes: true }, ['secondary', 'readingNotes']],
    [{ sourceType: 'manuscript', includeReadingNotes: true }, ['manuscript', 'readingNotes']],
  ];

  it.each(cases)('%j → %j', (query, expected) => {
    expect([...corporaInScope(query)].sort()).toEqual([...expected].sort());
  });
});

describe('fanOutCorpora', () => {
  it('rapporte toujours une issue par corpus, dans l’ordre canonique', async () => {
    const { outcomes } = await fanOutCorpora(
      [retriever('primary', [])],
      new Set<CorpusId>(['primary']),
      'q',
      options
    );
    expect(outcomes.map((o) => o.source)).toEqual([...CORPUS_ORDER]);
  });

  it('n’interroge pas un corpus hors portée', async () => {
    const vault = retriever('vault', [{ id: 'v', similarity: 0.5 }]);
    const { hits, outcomes } = await fanOutCorpora(
      [retriever('secondary', [{ id: 's', similarity: 0.5 }]), vault],
      new Set<CorpusId>(['secondary']),
      'q',
      options
    );
    expect(vault.search).not.toHaveBeenCalled();
    expect(hits.map((h) => h.id)).toEqual(['s']);
    expect(outcomes.find((o) => o.source === 'vault')?.attempted).toBe(false);
  });

  it('garde les autres corpus quand l’un échoue (succès partiel)', async () => {
    const onError = vi.fn();
    const { hits, outcomes } = await fanOutCorpora(
      [
        retriever('secondary', [{ id: 's1', similarity: 0.6 }, { id: 's2', similarity: 0.4 }]),
        retriever('primary', new Error('Tropy not initialised')),
      ],
      new Set<CorpusId>(['secondary', 'primary']),
      'q',
      options,
      onError
    );
    expect(hits).toHaveLength(2);
    const primary = outcomes.find((o) => o.source === 'primary')!;
    expect(primary).toMatchObject({ attempted: true, ok: false, error: 'Tropy not initialised' });
    expect(outcomes.find((o) => o.source === 'secondary')).toMatchObject({
      attempted: true,
      ok: true,
      hitCount: 2,
    });
    expect(onError).toHaveBeenCalledWith('primary', expect.any(Error));
  });

  it('transmet la requête et les options à chaque corpus', async () => {
    const manuscript = retriever('manuscript', []);
    await fanOutCorpora([manuscript], new Set<CorpusId>(['manuscript']), 'Vichy', options);
    expect(manuscript.search).toHaveBeenCalledWith('Vichy', options);
  });

  it('mesure la durée de chaque corpus interrogé', async () => {
    const { outcomes } = await fanOutCorpora(
      [retriever('secondary', [])],
      new Set<CorpusId>(['secondary']),
      'q',
      options
    );
    expect(typeof outcomes[0].durationMs).toBe('number');
    expect(outcomes[1].durationMs).toBeUndefined();
  });
});
