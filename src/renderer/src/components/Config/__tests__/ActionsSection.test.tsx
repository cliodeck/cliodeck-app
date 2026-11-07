// @vitest-environment jsdom
/**
 * « Purger Sources Primaires » (panneau Projet, section « Actions ») : après une
 * purge réussie, le panneau Sources primaires dit vrai (S08-2-9).
 *
 * La purge ne rechargeait que les statistiques de la section : le store des
 * sources primaires gardait le projet Tropy, son chemin et toutes ses sources,
 * qui n'existaient plus en base, et le panneau proposait encore de les
 * synchroniser. C'est aussi le chemin que donne L06-3 pour changer de projet
 * Tropy : après la purge, rien de l'ancien ne doit rester.
 *
 * Vrais section et store ; le pont `window.electron` et les confirmations sont simulés.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ActionsSection } from '../ActionsSection';
import { usePrimarySourcesStore } from '../../../stores/primarySourcesStore';
import { useDialogStore } from '../../../stores/dialogStore';

const INITIAL_STORE = usePrimarySourcesStore.getState();

let tropy: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  tropy = {
    getStatistics: vi.fn(async () => ({
      success: true,
      statistics: { sourceCount: 2, chunkCount: 6 },
      databasePath: '/projets/A/.cliodeck/brain.db',
    })),
    purge: vi.fn(async () => ({ success: true })),
  };
  const electron = (window as unknown as { electron: Record<string, unknown> }).electron;
  electron.tropy = tropy;
  electron.pdf = { getStatistics: vi.fn(async () => ({ success: false })) };
  vi.spyOn(useDialogStore.getState(), 'showConfirm').mockResolvedValue(true);
  vi.spyOn(useDialogStore.getState(), 'showAlert').mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  usePrimarySourcesStore.setState({
    tpyPath: '/archives/Danzig.tpy',
    projectInfo: {
      name: 'Archives Danzig',
      itemCount: 2,
      lastModified: '',
      isWatching: true,
      tpyPath: '/archives/Danzig.tpy',
    },
    sources: [
      {
        id: 'src-a',
        tropyId: 10,
        title: 'Rapport du préfet',
        tags: [],
        photoCount: 1,
        lastModified: '',
        indexedAt: '',
      },
    ],
    selectedSourceId: 'src-a',
    selectedCollection: 'Carton 12',
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  usePrimarySourcesStore.setState(INITIAL_STORE, true);
});

async function purgePrimarySources(): Promise<void> {
  render(<ActionsSection />);
  fireEvent.click(screen.getByText('actions.title'));
  const button = screen.getByRole('button', { name: 'Purge Primary Sources' });
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
  await waitFor(() => expect(tropy.purge).toHaveBeenCalledTimes(1));
}

describe('ActionsSection — purge des sources primaires', () => {
  it('purge réussie : le store des sources primaires est vidé', async () => {
    await purgePrimarySources();

    await waitFor(() => expect(usePrimarySourcesStore.getState().projectInfo).toBeNull());
    const state = usePrimarySourcesStore.getState();
    expect(state.tpyPath).toBeNull();
    expect(state.sources).toEqual([]);
    expect(state.selectedSourceId).toBeNull();
    expect(state.selectedCollection).toBeNull();
  });

  it('purge refusée : rien n’a été supprimé, le panneau garde ce qu’il montrait', async () => {
    tropy.purge.mockResolvedValue({ success: false, error: 'Service not initialized' });
    await purgePrimarySources();
    await waitFor(() => expect(useDialogStore.getState().showAlert).toHaveBeenCalled());

    expect(usePrimarySourcesStore.getState().projectInfo?.name).toBe('Archives Danzig');
    expect(usePrimarySourcesStore.getState().sources).toHaveLength(1);
  });
});
