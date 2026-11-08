// @vitest-environment jsdom
/**
 * La double confirmation des purges (journal, base PDF, sources primaires) : deux `showConfirm`
 * enchaînés par `await`, la seconde question arrivant avant que React ait vu la première se
 * fermer. Si le focus restait sur le Confirmer qui vient de servir, un appui sur Entrée purgerait
 * tout sans que personne ait lu la seconde question (S17-2-5).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConfirmDialog } from '../ConfirmDialog';
import { useDialogStore } from '../../../stores/dialogStore';

const dialogs = () => useDialogStore.getState();
const cancelButton = () => screen.getByText('dialog.cancel');
const confirmButton = () => screen.getByText('dialog.confirm');

/** Comme JournalPanel : la seconde question n'est posée que si la première a dit oui. */
async function purge(first: string, second: string): Promise<boolean> {
  if (!(await dialogs().showConfirm(first))) return false;
  return dialogs().showConfirm(second);
}

afterEach(() => {
  act(() => {
    while (dialogs().confirmOpen) dialogs().resolveConfirm(false);
  });
  cleanup();
});

describe('ConfirmDialog : deux questions enchaînées', () => {
  it.each([
    ['deux messages différents', 'Purger le journal ?', 'Les exports n’existent que si vous les avez faits. Purger ?'],
    ['deux fois le même message', 'Purger ?', 'Purger ?'],
  ])('%s : après un clic sur Confirmer, le focus est sur Annuler', async (_cas, first, second) => {
    render(<ConfirmDialog />);
    let answer: boolean | undefined;
    await act(async () => {
      void purge(first, second).then((value) => {
        answer = value;
      });
    });
    expect(document.activeElement).toBe(cancelButton());

    // Le clic donne le focus au bouton, comme une vraie souris.
    confirmButton().focus();
    await act(async () => {
      fireEvent.click(confirmButton());
    });

    expect(dialogs().confirmOpen).toBe(true);
    expect(screen.getByText(second)).toBeTruthy();
    expect(document.activeElement).toBe(cancelButton());

    // Entrée sur le bouton qui a le focus : Annuler. Rien n'est purgé.
    await act(async () => {
      fireEvent.click(document.activeElement as HTMLElement);
    });
    expect(answer).toBe(false);
  });
});

/**
 * Confirmer avait toujours l'aspect du bouton principal, même quand le focus était sur Annuler :
 * au second dialogue de la purge, l'auteur a cru que Confirmer était le bouton actif (BT1-7).
 */
describe('ConfirmDialog : une confirmation destructrice', () => {
  it('Confirmer porte is-danger, Annuler garde le focus ; la question suivante, ordinaire, ne le porte pas', async () => {
    render(<ConfirmDialog />);
    await act(async () => {
      void dialogs().showConfirm('Purger le journal ?', undefined, { danger: true });
      void dialogs().showConfirm('Ouvrir un document vide ?');
    });
    expect(confirmButton().classList.contains('is-danger')).toBe(true);
    expect(document.activeElement).toBe(cancelButton());

    confirmButton().focus();
    await act(async () => {
      fireEvent.click(confirmButton());
    });

    expect(screen.getByText('Ouvrir un document vide ?')).toBeTruthy();
    expect(confirmButton().classList.contains('is-danger')).toBe(false);
    expect(document.activeElement).toBe(cancelButton());
  });
});
