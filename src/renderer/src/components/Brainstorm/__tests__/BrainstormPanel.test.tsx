// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, cleanup } from '@testing-library/react';
import { BrainstormPanel } from '../BrainstormPanel';
import { useProjectStore } from '../../../stores/projectStore';

// The real BrainstormChat drags in zustand stores that touch `window.electron`
// in ways unrelated to this test — keep it isolated.
vi.mock('../BrainstormChat', () => ({
  BrainstormChat: () => <div data-testid="brainstorm-chat-stub" />,
}));

const setFusion = (overrides: {
  hintsError?: string;
  hintsOk?: boolean;
}): void => {
  const fusion = {
    hints: {
      read: vi.fn().mockResolvedValue(
        overrides.hintsOk
          ? {
              success: true,
              hints: {
                present: false,
                raw: '',
                normalized: '',
                sourcePath: '.cliodeck/v2/hints.md',
              },
            }
          : { success: false, error: overrides.hintsError ?? 'no_project' }
      ),
    },
    recipes: {
      list: vi.fn().mockResolvedValue({ success: true, builtin: [], user: [] }),
    },
    vault: {
      status: vi.fn().mockResolvedValue({ success: true, indexed: false, dbPath: '' }),
    },
  };
  (window as unknown as { electron: { fusion: typeof fusion } }).electron = {
    ...(window as unknown as { electron: Record<string, unknown> }).electron,
    fusion,
  } as never;
};

describe('BrainstormPanel — project-aware loading', () => {
  beforeEach(() => {
    useProjectStore.setState({ currentProject: null });
  });
  afterEach(() => {
    cleanup();
    useProjectStore.setState({ currentProject: null });
  });

  it('shows a neutral notice (not a red error) when no project is open, then clears it once a project is opened', async () => {
    // Initially: no project. Fusion API doesn't even get called, but set a
    // sensible default in case something probes it.
    setFusion({ hintsOk: true });

    render(<BrainstormPanel />);

    const notice = await screen.findByRole('status');
    expect(notice.textContent).toMatch(/openProjectNotice|Open a project|Ouvrez un projet/i);
    // And crucially: no red error banner.
    expect(screen.queryByRole('alert')).toBeNull();

    // Now a project opens.
    act(() => {
      useProjectStore.setState({
        currentProject: {
          id: 'p1',
          name: 'Test',
          path: '/tmp/test-project',
          type: 'article',
          createdAt: new Date(),
          lastOpenedAt: new Date(),
        },
      });
    });

    await waitFor(() => {
      expect(screen.queryByRole('status')).toBeNull();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
