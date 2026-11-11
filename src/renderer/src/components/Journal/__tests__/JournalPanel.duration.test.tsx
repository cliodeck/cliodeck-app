// @vitest-environment jsdom
/**
 * « Active » veut dire « sans fin », pas « durée nulle » (L03-9). Une session restée ouverte par une
 * sortie d'avant le correctif se ferme à la réouverture, à son dernier événement : sans événement
 * daté après son début, sa durée est nulle, et elle s'affichait « Active » comme la séance en cours.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { JournalPanel } from '../JournalPanel';
import { useJournalStore } from '../../../stores/journalStore';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('une session close de durée nulle affiche « 0 min » ; seule la session sans fin est « Active »', () => {
  useJournalStore.setState({
    sessions: [
      {
        id: 'reparee',
        projectPath: '/projet',
        startedAt: new Date('2026-11-10T09:00:00Z'),
        endedAt: new Date('2026-11-10T09:00:00Z'),
        totalDurationMs: 0,
        eventCount: 1,
      },
      { id: 'en-cours', projectPath: '/projet', startedAt: new Date('2026-11-11T09:00:00Z'), eventCount: 1 },
    ],
    loading: false,
    hideEmptySessions: false,
  });

  const { container } = render(<JournalPanel />);

  const durations = [...container.querySelectorAll('.session-duration')].map((node) => node.textContent);
  expect(durations).toEqual(['0 min', 'journal.active']);
});
