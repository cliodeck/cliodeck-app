// @vitest-environment jsdom
/**
 * La purge du journal efface tout l'historique de recherche du projet : ses deux questions
 * s'affichent en danger, Confirmer en rouge et non avec l'aspect du bouton par défaut (BT1-7).
 */
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { JournalPanel } from '../JournalPanel';
import { useDialogStore } from '../../../stores/dialogStore';
import { useJournalStore } from '../../../stores/journalStore';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('les deux questions de la purge passent `danger: true`', async () => {
  const showConfirm = vi.spyOn(useDialogStore.getState(), 'showConfirm').mockResolvedValue(true);
  const purgeJournal = vi.fn(async () => ({ success: false }));
  useJournalStore.setState({
    sessions: [{ id: 's1', projectPath: '/projet', startedAt: new Date(), eventCount: 0 }],
    loading: false,
    purgeJournal,
  });
  render(<JournalPanel />);

  fireEvent.click(screen.getByTitle('journal.purgeTitle'));

  await waitFor(() => expect(purgeJournal).toHaveBeenCalledTimes(1));
  expect(showConfirm.mock.calls.map((call) => call[0])).toEqual(['journal.purgeConfirm1', 'journal.purgeConfirm2']);
  expect(showConfirm.mock.calls.map((call) => call[2])).toEqual([{ danger: true }, { danger: true }]);
});
