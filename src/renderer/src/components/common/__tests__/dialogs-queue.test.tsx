// @vitest-environment jsdom
/**
 * Les dialogues réels sur la file du magasin. Deux demandes en attente se
 * succèdent sans que le dialogue passe par « fermé » : un effet qui ne
 * regarderait que `confirmOpen` laisserait le focus sur le bouton qui vient
 * de servir. Sur une confirmation, c'est le piège que ConfirmDialog ferme :
 * une seconde Entrée validerait une action destructrice que personne n'a lue.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AlertDialog } from '../AlertDialog';
import { ConfirmDialog } from '../ConfirmDialog';
import { useDialogStore } from '../../../stores/dialogStore';

const dialogs = () => useDialogStore.getState();

function renderDialogs(): void {
  render(
    <>
      <AlertDialog />
      <ConfirmDialog />
    </>
  );
}

afterEach(() => {
  act(() => {
    for (let i = 0; i < 20 && (dialogs().alertOpen || dialogs().confirmOpen); i += 1) {
      dialogs().closeAlert();
      dialogs().resolveConfirm(false);
    }
  });
  cleanup();
});

describe('dialogues en file', () => {
  it('la confirmation suivante reprend le focus sur Annuler, pas sur Confirmer', () => {
    renderDialogs();
    act(() => {
      void dialogs().showConfirm('Purger le journal ?');
      void dialogs().showConfirm('Détacher le vault ?');
    });
    expect(screen.getByText('Purger le journal ?')).toBeInTheDocument();

    // Geste au clavier : Tab jusqu'à Confirmer, puis Entrée.
    const confirm = screen.getByRole('button', { name: 'dialog.confirm' });
    act(() => confirm.focus());
    fireEvent.click(confirm);

    expect(screen.getByText('Détacher le vault ?')).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'dialog.cancel' }));
  });

  it('l’alerte suivante reprend le focus sur OK', () => {
    renderDialogs();
    act(() => {
      void dialogs().showAlert('première');
      void dialogs().showAlert('seconde');
    });

    // Fermeture par un clic sur le fond : le focus quitte le bouton OK.
    const ok = screen.getByRole('button', { name: 'dialog.ok' });
    act(() => ok.blur());
    act(() => dialogs().closeAlert());

    expect(screen.getByText('seconde')).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'dialog.ok' }));
  });

  it('Échap ne ferme que le dialogue à l’écran', () => {
    renderDialogs();
    act(() => {
      void dialogs().showAlert('alerte en tête');
      void dialogs().showConfirm('confirmation qui attend');
    });
    expect(screen.queryByText('confirmation qui attend')).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByText('alerte en tête')).not.toBeInTheDocument();
    expect(screen.getByText('confirmation qui attend')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByText('confirmation qui attend')).not.toBeInTheDocument();
  });
});
