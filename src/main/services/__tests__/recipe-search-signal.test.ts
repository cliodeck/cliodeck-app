/**
 * L'étape `search` d'une recette reçoit le signal de la recette (J9).
 *
 * Une recette est une opération annulable (L08-3) : fermer sa fenêtre l'arrête. Son étape de recherche
 * ne transmettait pas ce signal : l'embedding de la requête, sans réponse, gardait sa requête ouverte
 * après l'arrêt de la recette.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../retrieval-service.js', () => ({
  retrievalService: { search: vi.fn(async () => ({ hits: [] })) },
}));

const { recipeStepHandlers } = await import('../recipe-step-handlers');
const { retrievalService } = await import('../retrieval-service.js');

describe('recette : étape de recherche (J9)', () => {
  it('la recherche reçoit le signal de la recette', async () => {
    const controller = new AbortController();

    await recipeStepHandlers.search(
      { id: 's', kind: 'search', with: { source: 'both', query: 'grève des dockers de Nantes' } } as never,
      { workspaceRoot: '/projet', signal: controller.signal } as never
    );

    expect(vi.mocked(retrievalService.search).mock.calls.at(-1)?.[0]).toMatchObject({
      query: 'grève des dockers de Nantes',
      signal: controller.signal,
    });
  });
});
