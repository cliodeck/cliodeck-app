// @vitest-environment jsdom
/**
 * Ce qui s'ouvre par-dessus les Réglages : Échap ne ferme que le dessus (S17-1-6).
 *
 * Les Réglages n'enregistrent qu'au clic sur Enregistrer, et les fermer démonte ConfigPanel : tout
 * ce qui n'était pas enregistré était perdu quand on refusait une confirmation à Échap.
 * Vrais Réglages, vrais dialogues, même ordre de montage qu'App.tsx ; seul le contenu du panneau
 * est remplacé.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RebuildProgressEvent } from '@backend/types/rebuild-progress';

vi.mock('../ConfigPanel', () => ({
  ConfigPanel: () => (
    <>
      <input aria-label="champ" />
      <button>reinitialiser</button>
    </>
  ),
}));

import { SettingsModal } from '../SettingsModal';
import { AlertDialog } from '../../common/AlertDialog';
import { ConfirmDialog } from '../../common/ConfirmDialog';
import { HelpModal } from '../../common/HelpModal';
import { RebuildProgressModal } from '../../Project/RebuildProgressModal';
import { useDialogStore } from '../../../stores/dialogStore';
import { useRebuildStore } from '../../../stores/rebuildStore';

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

const dialogs = () => useDialogStore.getState();
const closeSettings = vi.fn();

const pressEscape = () =>
  act(async () => {
    fireEvent.keyDown(document, { key: 'Escape' });
  });

function renderApp(extra?: React.ReactElement): void {
  render(
    <>
      <SettingsModal isOpen onClose={closeSettings} />
      {extra}
      <RebuildProgressModal />
      <AlertDialog />
      <ConfirmDialog />
    </>
  );
}

beforeEach(() => {
  closeSettings.mockClear();
  useRebuildStore.getState().resetProgress();
});

afterEach(() => {
  act(() => {
    for (let i = 0; i < 20 && (dialogs().alertOpen || dialogs().confirmOpen); i += 1) {
      dialogs().closeAlert();
      dialogs().resolveConfirm(false);
    }
    useRebuildStore.getState().resetProgress();
  });
  cleanup();
});

describe('par-dessus les Réglages', () => {
  it('une confirmation : Échap dit non, les Réglages restent, et le focus revient sur son déclencheur', async () => {
    renderApp();
    const trigger = screen.getByText('reinitialiser');
    trigger.focus();

    let answer: boolean | undefined;
    await act(async () => {
      void dialogs()
        .showConfirm('Réinitialiser ?')
        .then((value) => {
          answer = value;
        });
    });
    expect(document.activeElement?.className).toBe('confirm-dialog-btn-cancel');

    await pressEscape();

    expect(answer).toBe(false);
    expect(dialogs().confirmOpen).toBe(false);
    expect(closeSettings).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);

    await pressEscape();
    expect(closeSettings).toHaveBeenCalledTimes(1);
  });

  it('deux dialogues en file : chaque Échap en ferme un, et les Réglages restent', async () => {
    renderApp();
    await act(async () => {
      void dialogs().showAlert('Première alerte.');
      void dialogs().showConfirm('Puis une question ?');
    });

    await pressEscape();
    expect(dialogs().alertOpen).toBe(false);
    expect(dialogs().confirmOpen).toBe(true);
    expect(closeSettings).not.toHaveBeenCalled();

    await pressEscape();
    expect(dialogs().confirmOpen).toBe(false);
    expect(closeSettings).not.toHaveBeenCalled();
  });

  it('l’aide de la section Sécurité : Échap ne ferme qu’elle', async () => {
    const closeHelp = vi.fn();
    renderApp(
      <HelpModal isOpen onClose={closeHelp} title="Aide">
        <p>Inspection de sécurité</p>
      </HelpModal>
    );

    await pressEscape();

    expect(closeHelp).toHaveBeenCalledTimes(1);
    expect(closeSettings).not.toHaveBeenCalled();
  });

  it('le message d’échec d’une reconstruction : Échap ne ferme que le message', async () => {
    renderApp();
    await act(async () => {
      useRebuildStore.getState().setRebuildProgress(failed);
    });

    await pressEscape();

    expect(useRebuildStore.getState().failure).toBeNull();
    expect(closeSettings).not.toHaveBeenCalled();
  });

  it('le voile d’une reconstruction en cours : il n’a pas d’Échap, et les Réglages ne se ferment pas derrière lui', async () => {
    renderApp();
    await act(async () => {
      useRebuildStore.getState().setRebuildProgress(running);
    });

    await pressEscape();

    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(closeSettings).not.toHaveBeenCalled();
  });

  it('un dialogue arrive sur le voile en cours : Échap lui revient, et les Réglages restent', async () => {
    renderApp();
    await act(async () => {
      useRebuildStore.getState().setRebuildProgress(running);
    });
    let answer: boolean | undefined;
    await act(async () => {
      void dialogs()
        .showConfirm('Abandonner ?')
        .then((value) => {
          answer = value;
        });
    });

    await pressEscape();

    expect(answer).toBe(false);
    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(closeSettings).not.toHaveBeenCalled();
  });

  it('la reconstruction démarre sous un dialogue : Échap reste au dialogue, puis le voile le garde', async () => {
    renderApp();
    let answer: boolean | undefined;
    await act(async () => {
      void dialogs()
        .showConfirm('Abandonner ?')
        .then((value) => {
          answer = value;
        });
    });
    await act(async () => {
      useRebuildStore.getState().setRebuildProgress(running);
    });

    await pressEscape();
    expect(answer).toBe(false);
    expect(closeSettings).not.toHaveBeenCalled();

    await pressEscape();
    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(closeSettings).not.toHaveBeenCalled();
  });

  it('le voile n’a plus lieu d’être : Échap retrouve les Réglages', async () => {
    renderApp();
    await act(async () => {
      useRebuildStore.getState().setRebuildProgress(running);
    });
    await act(async () => {
      useRebuildStore.getState().resetProgress();
    });

    await pressEscape();

    expect(closeSettings).toHaveBeenCalledTimes(1);
  });
});
