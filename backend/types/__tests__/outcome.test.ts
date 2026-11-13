/**
 * `Outcome<T>` sur l'IPC (L09-2) : ce que `outcomeResponse` écrit côté main, `readOutcome` le
 * relit à l'identique côté renderer, et un appelant qui ne lit que `success` lit toujours juste.
 */
import { describe, expect, it } from 'vitest';
import { failed, ok, partial, UNEXPECTED_ISSUE_CODE, type Outcome } from '../outcome';
import { errorResponse, outcomeResponse } from '../../../src/main/ipc/utils/error-handler';
import { readOutcome } from '../../../src/renderer/src/utils/ipc-outcome';

function roundTrip<T extends Record<string, unknown>>(o: Outcome<T>): Outcome<T> {
  return readOutcome<T>(outcomeResponse(o));
}

describe('outcomeResponse puis readOutcome : aller-retour', () => {
  it('ok : la valeur étalée à côté de success: true, relue telle quelle', () => {
    const o = ok({ saved: 3, path: '/projet/document.md' });

    expect(outcomeResponse(o)).toEqual({ success: true, saved: 3, path: '/projet/document.md' });
    expect(roundTrip(o)).toEqual(o);
  });

  it('partial : success: true pour les appelants existants, et les avertissements à côté', () => {
    const o = partial({ results: [1, 2] }, [
      { code: 'similarity.segmentsFailed', params: { failed: 2, total: 9 } },
      { code: 'settings.servicesNotReloaded', message: 'ENOENT: brain.db' },
    ]);

    const response = outcomeResponse(o);
    expect(response.success).toBe(true);
    expect(response).toMatchObject({ results: [1, 2] });
    expect(roundTrip(o)).toEqual(o);
  });

  it('partial sans avertissement rend ok, et la réponse ne porte pas de warnings', () => {
    const o = partial({ saved: 1 }, []);

    expect(o).toEqual({ status: 'ok', value: { saved: 1 } });
    expect(outcomeResponse(o)).not.toHaveProperty('warnings');
    expect(roundTrip(o)).toEqual(o);
  });

  it('failed : success: false, la cause dans error, le code et ses paramètres à part', () => {
    const o = failed(new Error('EACCES: permission denied'), 'settings.saveRefused', { section: 'llm' });

    expect(outcomeResponse(o)).toEqual({
      success: false,
      error: 'EACCES: permission denied',
      errorCode: 'settings.saveRefused',
      errorParams: { section: 'llm' },
    });
    expect(roundTrip(o)).toEqual(o);
  });

  it('failed sans cause : error porte le code pour les anciens lecteurs, relu sans cause inventée', () => {
    const o = failed(undefined, 'settings.saveRefused');

    expect(outcomeResponse(o)).toMatchObject({ success: false, error: 'settings.saveRefused' });
    expect(roundTrip(o)).toEqual({ status: 'failed', error: { code: 'settings.saveRefused' } });
  });

  it('failed sans code : la cause brute, sous le code qui ne qualifie rien', () => {
    expect(roundTrip(failed(new Error('disque plein')))).toEqual({
      status: 'failed',
      error: { code: UNEXPECTED_ISSUE_CODE, message: 'disque plein' },
    });
  });
});

describe('readOutcome : les réponses écrites sans outcomeResponse', () => {
  it('errorResponse : un échec, cause brute, sans code qualifié', () => {
    expect(readOutcome(errorResponse(new Error('No project open')))).toEqual({
      status: 'failed',
      error: { code: UNEXPECTED_ISSUE_CODE, message: 'No project open' },
    });
  });

  it('une réponse sans enveloppe est sa propre valeur', () => {
    expect(readOutcome<string[]>(['a', 'b'])).toEqual({ status: 'ok', value: ['a', 'b'] });
  });

  it("des warnings qui ne sont pas des problèmes restent dans la valeur (project:load, services non ouverts)", () => {
    // `project:load` et `project:create` répondent `warnings: string[]` : les noms des services
    // best-effort qui ne se sont pas ouverts. Ce n'est pas l'enveloppe : rien ne doit s'en perdre.
    expect(readOutcome({ success: true, project: { name: 'x' }, warnings: ['tropy', 'obsidian'] })).toEqual({
      status: 'ok',
      value: { project: { name: 'x' }, warnings: ['tropy', 'obsidian'] },
    });
    // `outcomeResponse` n'écrit jamais de `warnings` vide : un tableau vide est une valeur.
    expect(readOutcome({ success: true, project: { name: 'x' }, warnings: [] })).toEqual({
      status: 'ok',
      value: { project: { name: 'x' }, warnings: [] },
    });
  });

  it('des warnings mêlés (un problème, une chaîne) restent entiers dans la valeur', () => {
    expect(readOutcome({ success: true, warnings: [{ code: 'similarity.segmentsFailed' }, 'tropy'] })).toEqual({
      status: 'ok',
      value: { warnings: [{ code: 'similarity.segmentsFailed' }, 'tropy'] },
    });
  });
});

describe("outcomeResponse : l'enveloppe ne se laisse pas écraser", () => {
  it.each(['success', 'error', 'warnings', 'errorCode', 'errorParams'])(
    'refuse une valeur qui porte la clé %s',
    (key) => {
      expect(() => outcomeResponse(ok({ [key]: false }))).toThrow(key);
      expect(() => outcomeResponse(partial({ [key]: false }, [{ code: 'x' }]))).toThrow(key);
    }
  );
});
