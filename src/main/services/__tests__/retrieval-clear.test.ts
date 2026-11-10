/**
 * Fermer le projet rend toutes ses bases (S02-1-17). `retrievalService.clear()` fermait le coffre,
 * le manuscrit côté recherche et les notes de lecture, mais pas le store du service d'indexation du
 * manuscrit : sa connexion à `brain.db` survivait au projet, et son `workspaceRoot` le visait encore.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { retrievalService } from '../retrieval-service.js';
import { manuscriptIndexService } from '../manuscript-index-service.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('retrievalService.clear', () => {
  it('oublie aussi le projet du corpus manuscrit', () => {
    const clear = vi.spyOn(manuscriptIndexService, 'clear');

    retrievalService.clear();

    expect(clear).toHaveBeenCalled();
  });
});
