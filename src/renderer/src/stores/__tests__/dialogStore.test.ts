/**
 * Régression : `showAlert` et `showConfirm` écrasaient le résolveur en place.
 * Le dialogue déjà ouvert disparaissait sans avoir été lu, et sa promesse
 * n'était plus jamais résolue — or des appelants l'attendent en tenant un
 * verrou (voir manuscript-lock.test.ts). Les demandes passent désormais par
 * une file : une seule à l'écran, chacune résolue par sa propre fermeture.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { useDialogStore } from '../dialogStore';

const dialogs = () => useDialogStore.getState();

/** Laisse s'exécuter les suites des promesses résolues. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Observe une promesse sans l'attendre : une promesse orpheline ne doit pas figer le test. */
function watch<T>(promise: Promise<T>): { done: boolean; value?: T } {
  const state: { done: boolean; value?: T } = { done: false };
  void promise.then((value) => {
    state.done = true;
    state.value = value;
  });
  return state;
}

describe('file des dialogues', () => {
  beforeEach(() => {
    // Vide ce qu'un test précédent aurait laissé ouvert.
    for (let i = 0; i < 20 && (dialogs().alertOpen || dialogs().confirmOpen); i += 1) {
      dialogs().closeAlert();
      dialogs().resolveConfirm(false);
    }
  });

  it('une seconde alerte attend la première au lieu de l’orpheliner', async () => {
    const first = watch(dialogs().showAlert('a'));
    const second = watch(dialogs().showAlert('b', 'Titre b'));

    // La première reste à l'écran : elle n'a pas encore été lue.
    expect(dialogs().alertMessage).toBe('a');
    expect(dialogs().alertTitle).toBeUndefined();

    dialogs().closeAlert();
    await flush();
    expect(first.done).toBe(true);
    expect(second.done).toBe(false);
    expect(dialogs().alertOpen).toBe(true);
    expect(dialogs().alertMessage).toBe('b');
    expect(dialogs().alertTitle).toBe('Titre b');

    dialogs().closeAlert();
    await flush();
    expect(second.done).toBe(true);
    expect(dialogs().alertOpen).toBe(false);
    expect(dialogs().alertMessage).toBe('');
    expect(dialogs().alertTitle).toBeUndefined();
  });

  it('chaque confirmation reçoit sa propre réponse', async () => {
    const first = watch(dialogs().showConfirm('supprimer a ?'));
    const second = watch(dialogs().showConfirm('supprimer b ?'));

    expect(dialogs().confirmMessage).toBe('supprimer a ?');

    dialogs().resolveConfirm(true);
    await flush();
    expect(first).toEqual({ done: true, value: true });
    expect(second.done).toBe(false);
    expect(dialogs().confirmMessage).toBe('supprimer b ?');

    dialogs().resolveConfirm(false);
    await flush();
    expect(second).toEqual({ done: true, value: false });
    expect(dialogs().confirmOpen).toBe(false);
  });

  it('alertes et confirmations passent une à une, dans l’ordre d’arrivée', async () => {
    const alert = watch(dialogs().showAlert('alerte'));
    const confirm = watch(dialogs().showConfirm('confirmation ?'));
    const lastAlert = watch(dialogs().showAlert('dernière'));

    expect(dialogs().alertOpen).toBe(true);
    expect(dialogs().confirmOpen).toBe(false);

    dialogs().closeAlert();
    await flush();
    expect(alert.done).toBe(true);
    expect(dialogs().alertOpen).toBe(false);
    expect(dialogs().confirmOpen).toBe(true);
    expect(dialogs().confirmMessage).toBe('confirmation ?');

    dialogs().resolveConfirm(true);
    await flush();
    expect(confirm).toEqual({ done: true, value: true });
    expect(dialogs().confirmOpen).toBe(false);
    expect(dialogs().alertMessage).toBe('dernière');

    dialogs().closeAlert();
    await flush();
    expect(lastAlert.done).toBe(true);
    expect(dialogs().alertOpen).toBe(false);
  });

  it('fermer une alerte ne répond pas à la confirmation en tête, et inversement', async () => {
    const confirm = watch(dialogs().showConfirm('confirmation ?'));
    dialogs().closeAlert();
    await flush();
    expect(confirm.done).toBe(false);
    expect(dialogs().confirmOpen).toBe(true);
    dialogs().resolveConfirm(false);
    await flush();
    expect(confirm).toEqual({ done: true, value: false });

    const alert = watch(dialogs().showAlert('alerte'));
    dialogs().resolveConfirm(true);
    await flush();
    expect(alert.done).toBe(false);
    expect(dialogs().alertOpen).toBe(true);
  });

  it('une fermeture sans dialogue ouvert est sans effet', () => {
    dialogs().closeAlert();
    dialogs().resolveConfirm(true);

    expect(dialogs().alertOpen).toBe(false);
    expect(dialogs().confirmOpen).toBe(false);
  });

  it('une demande faite après la fermeture de la dernière s’ouvre aussitôt', async () => {
    const first = watch(dialogs().showConfirm('une'));
    dialogs().resolveConfirm(true);
    await flush();
    expect(first.done).toBe(true);

    void dialogs().showConfirm('deux');
    expect(dialogs().confirmOpen).toBe(true);
    expect(dialogs().confirmMessage).toBe('deux');
  });
});
