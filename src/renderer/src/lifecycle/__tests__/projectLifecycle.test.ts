/**
 * Le registre du projet à l'écran, côté renderer (L03-4).
 *
 * Ce que les stores et les chargeurs en attendent : une remise à zéro par store quand l'écran passe
 * à un autre projet, et aucune pour le même ; un handle qui cesse d'être courant dès que la demande
 * part au main, et qui ne le redevient pas quand le projet d'avant revient.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Lifecycle = typeof import('../projectLifecycle')['projectLifecycle'];

let lifecycle: Lifecycle;

beforeEach(async () => {
  // Un registre neuf à chaque test : il vit au niveau du module, comme dans l'app.
  vi.resetModules();
  ({ projectLifecycle: lifecycle } = await import('../projectLifecycle'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('le handle des chargeurs', () => {
  it('un handle capturé devient non courant dès beginTransition', () => {
    lifecycle.enter('/projets/A');
    const handle = lifecycle.capture();
    expect(handle?.path).toBe('/projets/A');
    expect(handle?.isCurrent()).toBe(true);

    lifecycle.beginTransition();

    expect(handle?.isCurrent()).toBe(false);
    expect(handle?.signal.aborted).toBe(true);
    expect(() => handle?.assertCurrent()).toThrow('project-changed');
    // Pendant la demande, aucun projet n'est sûr : le main sert peut-être déjà l'autre.
    expect(lifecycle.capture()).toBeNull();
  });

  it('enter(B) : un handle courant pour B, celui de A reste périmé', () => {
    lifecycle.enter('/projets/A');
    const ofA = lifecycle.capture();
    lifecycle.beginTransition();
    lifecycle.enter('/projets/B');

    const ofB = lifecycle.capture();
    expect(ofB?.path).toBe('/projets/B');
    expect(ofB?.isCurrent()).toBe(true);
    expect(ofA?.isCurrent()).toBe(false);
    expect(ofB?.epoch).toBeGreaterThan(ofA?.epoch ?? Infinity);
  });

  it('A revient (abortTransition) : un nouveau handle, et celui d’avant la demande reste périmé', () => {
    lifecycle.enter('/projets/A');
    const before = lifecycle.capture();
    lifecycle.beginTransition();

    lifecycle.abortTransition();

    const after = lifecycle.capture();
    expect(after?.path).toBe('/projets/A');
    expect(after?.isCurrent()).toBe(true);
    // Sa réponse, peut-être servie par les services de B pendant la tentative, ne s'inscrit pas.
    expect(before?.isCurrent()).toBe(false);
  });

  it('sans projet, aucun handle ; enter(null) périme celui du projet fermé', () => {
    expect(lifecycle.capture()).toBeNull();
    lifecycle.enter('/projets/A');
    const ofA = lifecycle.capture();

    lifecycle.enter(null);

    expect(lifecycle.capture()).toBeNull();
    expect(ofA?.isCurrent()).toBe(false);
  });

  it('abortTransition sans demande en cours ne change rien', () => {
    lifecycle.enter('/projets/A');
    const handle = lifecycle.capture();

    lifecycle.abortTransition();

    expect(lifecycle.capture()).toBe(handle);
    expect(handle?.isCurrent()).toBe(true);
  });
});

describe('les remises à zéro', () => {
  it('passer à un autre projet les appelle toutes, dans l’ordre d’inscription, avec le projet entrant', () => {
    const calls: string[] = [];
    lifecycle.onReset('premier', ({ to }) => calls.push(`premier:${to}`));
    lifecycle.onReset('second', ({ to }) => calls.push(`second:${to}`));
    lifecycle.enter('/projets/A');
    calls.length = 0;

    lifecycle.beginTransition();
    expect(calls).toEqual([]);
    lifecycle.enter('/projets/B');

    expect(calls).toEqual(['premier:/projets/B', 'second:/projets/B']);
  });

  it('fermer le projet (enter(null)) les appelle aussi', () => {
    const reset = vi.fn();
    lifecycle.onReset('store', reset);
    lifecycle.enter('/projets/A');
    reset.mockClear();

    lifecycle.enter(null);

    expect(reset).toHaveBeenCalledWith({ to: null });
  });

  it('le même projet rouvert : aucune remise à zéro', () => {
    const reset = vi.fn();
    lifecycle.onReset('store', reset);
    lifecycle.enter('/projets/A');
    reset.mockClear();

    lifecycle.beginTransition();
    lifecycle.enter('/projets/A');

    expect(reset).not.toHaveBeenCalled();
    expect(lifecycle.capture()?.isCurrent()).toBe(true);
  });

  it('le projet d’avant revient : aucune remise à zéro, ses stores n’ont rien perdu', () => {
    const reset = vi.fn();
    lifecycle.onReset('store', reset);
    lifecycle.enter('/projets/A');
    reset.mockClear();

    lifecycle.beginTransition();
    lifecycle.abortTransition();

    expect(reset).not.toHaveBeenCalled();
  });

  it('un reset qui lève n’empêche pas les suivants, et il est journalisé', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const after = vi.fn();
    lifecycle.onReset('en-panne', () => {
      throw new Error('boum');
    });
    lifecycle.onReset('suivant', after);

    lifecycle.enter('/projets/B');

    expect(after).toHaveBeenCalledWith({ to: '/projets/B' });
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('en-panne');
    // Le projet entrant a quand même son handle.
    expect(lifecycle.capture()?.path).toBe('/projets/B');
  });

  it('une inscription retirée n’est plus appelée ; réinscrire un nom remplace la remise à zéro', () => {
    const first = vi.fn();
    const replaced = vi.fn();
    const removed = vi.fn();
    lifecycle.onReset('store', first);
    lifecycle.onReset('store', replaced);
    const unsubscribe = lifecycle.onReset('retiré', removed);
    unsubscribe();

    lifecycle.enter('/projets/B');

    expect(first).not.toHaveBeenCalled();
    expect(replaced).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
  });
});
