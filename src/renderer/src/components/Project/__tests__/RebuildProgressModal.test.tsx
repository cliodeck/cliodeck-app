// @vitest-environment jsdom
/**
 * Le voile de la reconstruction : non fermable tant qu'elle tourne, fermable dès
 * qu'elle a échoué.
 *
 * Sans bouton ni Échap, un échec laissait l'historien devant une fenêtre morte :
 * le menu natif était sa seule sortie, et « Recharger » perdait le texte non enregistré.
 * Vrai magasin, vrais dialogues, même ordre de montage qu'App.tsx.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RebuildProgressEvent } from '@backend/types/rebuild-progress';

import { RebuildProgressModal } from '../RebuildProgressModal';
import { AlertDialog } from '../../common/AlertDialog';
import { ConfirmDialog } from '../../common/ConfirmDialog';
import { useRebuildStore } from '../../../stores/rebuildStore';
import { useDialogStore } from '../../../stores/dialogStore';

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

const CAUSE = 'Failed to save HNSW index: EISDIR';

const failed: RebuildProgressEvent = {
  current: 90,
  total: 100,
  status: `Error: ${CAUSE}`,
  percentage: 90,
  phase: 'failed',
  error: CAUSE,
};
const running: RebuildProgressEvent = {
  current: 20,
  total: 100,
  status: 'Building HNSW index…',
  percentage: 20,
  phase: 'running',
};
const done: RebuildProgressEvent = {
  current: 100,
  total: 100,
  status: 'Rebuild complete',
  percentage: 100,
  phase: 'done',
};

const receive = (event: RebuildProgressEvent) =>
  act(() => {
    useRebuildStore.getState().setRebuildProgress(event);
  });

const dialogs = () => useDialogStore.getState();
const veil = () => document.querySelector('.rebuild-modal');
const closeButton = () => screen.queryByRole('button', { name: 'actions.close' });
const pressEscape = () => fireEvent.keyDown(document, { key: 'Escape' });

/** Le déclencheur tient le focus, comme l'éditeur quand la reconstruction part. */
function renderApp(): HTMLElement {
  render(
    <>
      <textarea data-testid="editor" />
      <RebuildProgressModal />
      <AlertDialog />
      <ConfirmDialog />
    </>
  );
  const editor = screen.getByTestId('editor');
  editor.focus();
  return editor;
}

beforeEach(() => {
  useRebuildStore.getState().resetProgress();
});

afterEach(() => {
  act(() => {
    for (let i = 0; i < 20 && (dialogs().alertOpen || dialogs().confirmOpen); i += 1) {
      dialogs().closeAlert();
      dialogs().resolveConfirm(false);
    }
  });
  cleanup();
});

describe('RebuildProgressModal', () => {
  it('rien à afficher sans reconstruction', () => {
    renderApp();
    expect(veil()).toBeNull();
  });

  describe('pendant la reconstruction, rien ne change', () => {
    it('aucun élément focalisable, Échap sans effet : le choix du CHANGELOG', () => {
      const editor = renderApp();
      receive(running);

      expect(screen.getByRole('alertdialog')).toBeTruthy();
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('20');
      expect(veil()?.querySelectorAll(FOCUSABLE).length).toBe(0);

      pressEscape();

      expect(screen.getByRole('alertdialog')).toBeTruthy();
      // Le focus reste où il était : la frappe continue d'arriver dans l'éditeur.
      expect(document.activeElement).toBe(editor);
    });

    it('un succès le retire', () => {
      renderApp();
      receive(running);
      receive(done);
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
  });

  describe('après un échec', () => {
    it('dit l’échec et sa cause, avec un bouton Fermer qui a le focus', () => {
      renderApp();
      receive(running);
      receive(failed);

      const dialog = screen.getByRole('alertdialog');
      expect(dialog.textContent).toContain('rebuild.failedTitle');
      expect(dialog.textContent).toContain('rebuild.failedMessage');
      expect(dialog.textContent).toContain(CAUSE);
      expect(screen.queryByRole('progressbar')).toBeNull();
      expect(document.activeElement).toBe(closeButton());
    });

    it('un clic sur Fermer retire le voile et rend le focus à l’éditeur', () => {
      const editor = renderApp();
      receive(failed);

      fireEvent.click(closeButton() as HTMLElement);

      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(document.activeElement).toBe(editor);
      expect(useRebuildStore.getState().failure).toBeNull();
    });

    it('Échap fait de même', () => {
      const editor = renderApp();
      receive(failed);

      pressEscape();

      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(document.activeElement).toBe(editor);
    });

    it('Tab ne sort pas du message', () => {
      renderApp();
      receive(failed);

      fireEvent.keyDown(document, { key: 'Tab' });

      expect(document.activeElement).toBe(closeButton());
    });

    it('la reconstruction repart : plus de bouton, et le nouvel échec reprend le focus', () => {
      const editor = renderApp();
      receive(failed);

      receive(running);
      expect(closeButton()).toBeNull();
      expect(screen.getByRole('progressbar')).toBeTruthy();
      expect(document.activeElement).toBe(editor);

      receive(failed);
      expect(document.activeElement).toBe(closeButton());
    });
  });

  describe('avec un dialogue de la file', () => {
    it('le dialogue arrive sur le message : Échap ne ferme que lui, puis le message', async () => {
      const editor = renderApp();
      receive(failed);

      let answer: boolean | undefined;
      await act(async () => {
        void dialogs()
          .showConfirm('Abandonner le texte ?')
          .then((value) => {
            answer = value;
          });
      });
      expect(document.activeElement?.className).toBe('confirm-dialog-btn-cancel');

      await act(async () => {
        pressEscape();
      });

      expect(answer).toBe(false);
      expect(dialogs().confirmOpen).toBe(false);
      expect(useRebuildStore.getState().failure).toBe(CAUSE);
      expect(veil()).not.toBeNull();
      expect(document.activeElement).toBe(closeButton());

      pressEscape();

      expect(veil()).toBeNull();
      expect(document.activeElement).toBe(editor);
    });

    it('le message arrive sous un dialogue : il ne lui prend pas le focus, et attend son tour', async () => {
      const editor = renderApp();
      await act(async () => {
        void dialogs().showAlert('Une alerte.');
      });
      const ok = document.activeElement;
      expect(ok?.className).toBe('alert-dialog-btn-ok');

      receive(failed);

      expect(document.activeElement).toBe(ok);
      expect(veil()).not.toBeNull();

      await act(async () => {
        fireEvent.click(ok as HTMLElement);
      });

      expect(dialogs().alertOpen).toBe(false);
      expect(document.activeElement).toBe(closeButton());

      fireEvent.click(closeButton() as HTMLElement);

      expect(veil()).toBeNull();
      expect(document.activeElement).toBe(editor);
    });

    it('deux dialogues en file : le message attend que la file soit vide', async () => {
      const editor = renderApp();
      receive(failed);
      await act(async () => {
        void dialogs().showAlert('Première alerte.');
        void dialogs().showAlert('Seconde alerte.');
      });

      await act(async () => {
        pressEscape();
      });
      expect(dialogs().alertOpen).toBe(true);
      expect(veil()).not.toBeNull();

      await act(async () => {
        pressEscape();
      });
      expect(dialogs().alertOpen).toBe(false);
      expect(veil()).not.toBeNull();
      expect(document.activeElement).toBe(closeButton());

      pressEscape();
      expect(veil()).toBeNull();
      expect(document.activeElement).toBe(editor);
    });
  });
});
