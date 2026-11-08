// @vitest-environment jsdom
/**
 * « Tout réindexer » les notes de lecture, fournisseur arrêté (S04-1-18). Le main n'écrit plus
 * rien et garde l'index d'avant ; la section doit le dire, et non « 0 note indexée » suivi de
 * « 1 note(s) n'ont pas pu être indexées ; le reste l'a été ».
 *
 * Vraie section ; le main est imité.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => {
  const t = (key: string, params?: Record<string, unknown>) =>
    params ? `${key} ${JSON.stringify(params)}` : key;
  return {
    useTranslation: () => ({ t, i18n: { language: 'fr', changeLanguage: async () => undefined } }),
    Trans: ({ children }: { children?: unknown }) => children ?? null,
    initReactI18next: { type: '3rdParty', init: () => undefined },
  };
});

import { ReadingNotesCorpusSection } from '../ReadingNotesCorpusSection';
import { useProjectStore } from '../../../stores/projectStore';

let originalElectron: unknown;

beforeEach(() => {
  originalElectron = (window as unknown as { electron?: unknown }).electron;
  (window as unknown as { electron: unknown }).electron = {
    readingNotesCorpus: {
      index: vi.fn(),
      stats: vi.fn(async () => ({ success: true, stats: { noteCount: 3, chunkCount: 9, lastIndexedAt: null } })),
      reindexAll: vi.fn(async () => ({
        success: true,
        report: {
          indexed: 0,
          unchanged: 0,
          removed: 0,
          chunks: 0,
          failures: [{ relativePath: 'reading-notes/Bloch_1949.md', reason: 'fetch failed' }],
          durationMs: 4,
          abandoned: 'fetch failed',
        },
      })),
    },
  };
  useProjectStore.setState({
    currentProject: { id: 'p', name: 'Danzig', path: '/tmp/danzig', type: 'article', createdAt: new Date(), lastOpenedAt: new Date() },
  });
});

afterEach(() => {
  cleanup();
  (window as unknown as { electron: unknown }).electron = originalElectron;
  useProjectStore.setState({ currentProject: null });
});

describe('« Tout réindexer » abandonné', () => {
  it('dit que rien n’a changé et pourquoi, sans annoncer de note indexée', async () => {
    render(
      <ReadingNotesCorpusSection enabled onEnabledChange={() => undefined} cloudConsent={false} onCloudConsentChange={async () => undefined} />
    );
    fireEvent.click(screen.getByText('readingNotesCorpus.title'));
    await waitFor(() => expect(screen.getByText(/readingNotesCorpus.notes/)).toBeTruthy());

    fireEvent.click(screen.getByTitle('readingNotesCorpus.reindexTitle'));

    await waitFor(() =>
      expect(screen.getByText('readingNotesCorpus.abandoned {"reason":"fetch failed"}')).toBeTruthy()
    );
    expect(screen.queryByText(/readingNotesCorpus.indexDone/)).toBeNull();
    expect(screen.queryByText(/readingNotesCorpus.partialFailure/)).toBeNull();
    // L'état de l'index, relu après la passe, est celui d'avant.
    expect(screen.getByText(/readingNotesCorpus.notes \{"count":3\}/)).toBeTruthy();
  });
});
