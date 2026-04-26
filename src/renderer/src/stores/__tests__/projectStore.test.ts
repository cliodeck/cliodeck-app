/**
 * @vitest-environment jsdom
 *
 * Tests for the typed projectStore.loadState machine (fusion 3.10).
 *
 * The transitions matter for downstream UX: a toast that wants to
 * show the failure reason needs `failed.error`; a Brainstorm panel
 * that wants to defer rendering until ready can read `kind === 'ready'`
 * instead of guessing from `currentProject != null && !isLoading`.
 *
 * The IPC layer (`window.electron.project.*`) is replaced wholesale
 * with stubs so the store's behaviour is exercised in isolation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useProjectStore } from '../projectStore';

interface ElectronStub {
  project: {
    load: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    getRecent: ReturnType<typeof vi.fn>;
    getMetadata: ReturnType<typeof vi.fn>;
    removeRecent: ReturnType<typeof vi.fn>;
    getChapters: ReturnType<typeof vi.fn>;
  };
  fs: { writeFile: ReturnType<typeof vi.fn> };
}

let originalElectron: unknown;
let stub: ElectronStub;

const fakeProject = {
  id: 'p1',
  name: 'Demo',
  path: '/tmp/p1',
  type: 'article' as const,
  createdAt: new Date('2026-01-01').toISOString(),
  lastOpenedAt: new Date('2026-01-02').toISOString(),
};

beforeEach(() => {
  originalElectron = (window as unknown as { electron?: unknown }).electron;
  stub = {
    project: {
      load: vi.fn(),
      create: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      getRecent: vi.fn().mockResolvedValue([]),
      getMetadata: vi.fn(),
      removeRecent: vi.fn().mockResolvedValue(undefined),
      getChapters: vi.fn().mockResolvedValue({ success: true, chapters: [] }),
    },
    fs: { writeFile: vi.fn().mockResolvedValue(undefined) },
  };
  (window as unknown as { electron: ElectronStub }).electron = stub;
  // Reset store to a clean slate for every test.
  useProjectStore.setState({
    currentProject: null,
    chapters: [],
    currentChapterId: null,
    loadState: { kind: 'idle' },
    recentProjects: [],
  });
});

afterEach(() => {
  (window as unknown as { electron?: unknown }).electron = originalElectron;
});

describe('projectStore.loadState — initial state', () => {
  it('starts in `idle`', () => {
    expect(useProjectStore.getState().loadState).toEqual({ kind: 'idle' });
  });
});

describe('projectStore.loadProject — happy path', () => {
  it('transitions idle → loading → ready and exposes the loaded path', async () => {
    stub.project.load.mockResolvedValue({
      success: true,
      project: fakeProject,
    });

    const transitions: string[] = [];
    const unsubscribe = useProjectStore.subscribe((s) =>
      transitions.push(s.loadState.kind)
    );

    await useProjectStore.getState().loadProject('/tmp/p1');
    unsubscribe();

    expect(transitions).toContain('loading');
    expect(transitions[transitions.length - 1]).toBe('ready');
    const finalState = useProjectStore.getState().loadState;
    expect(finalState.kind).toBe('ready');
    if (finalState.kind === 'ready') {
      expect(finalState.path).toBe('/tmp/p1');
      expect(typeof finalState.loadedAt).toBe('string');
    }
    expect(useProjectStore.getState().currentProject?.id).toBe('p1');
  });
});

describe('projectStore.loadProject — failure path', () => {
  it('captures the error message in `failed` and re-throws', async () => {
    stub.project.load.mockResolvedValue({
      success: false,
      error: 'Workspace v3 not supported',
    });

    await expect(
      useProjectStore.getState().loadProject('/tmp/bad')
    ).rejects.toThrow(/Workspace v3 not supported/);

    const finalState = useProjectStore.getState().loadState;
    expect(finalState.kind).toBe('failed');
    if (finalState.kind === 'failed') {
      expect(finalState.path).toBe('/tmp/bad');
      expect(finalState.error).toMatch(/Workspace v3 not supported/);
      expect(typeof finalState.at).toBe('string');
    }
  });

  it('captures a thrown Error instance verbatim', async () => {
    stub.project.load.mockRejectedValue(new Error('Network down'));
    await expect(
      useProjectStore.getState().loadProject('/tmp/x')
    ).rejects.toThrow(/Network down/);
    const s = useProjectStore.getState().loadState;
    expect(s.kind).toBe('failed');
    if (s.kind === 'failed') expect(s.error).toBe('Network down');
  });

  it('allows a retry from failed (failed → loading → ready)', async () => {
    stub.project.load
      .mockResolvedValueOnce({ success: false, error: 'transient' })
      .mockResolvedValueOnce({ success: true, project: fakeProject });

    await expect(
      useProjectStore.getState().loadProject('/tmp/p1')
    ).rejects.toThrow();
    expect(useProjectStore.getState().loadState.kind).toBe('failed');

    await useProjectStore.getState().loadProject('/tmp/p1');
    expect(useProjectStore.getState().loadState.kind).toBe('ready');
  });
});

describe('projectStore.closeProject — resets to idle', () => {
  it('transitions ready → idle and clears the project', async () => {
    stub.project.load.mockResolvedValue({
      success: true,
      project: fakeProject,
    });
    await useProjectStore.getState().loadProject('/tmp/p1');
    expect(useProjectStore.getState().loadState.kind).toBe('ready');

    await useProjectStore.getState().closeProject();
    expect(useProjectStore.getState().loadState).toEqual({ kind: 'idle' });
    expect(useProjectStore.getState().currentProject).toBeNull();
  });

  it('still resets to idle even when the IPC close fails', async () => {
    stub.project.load.mockResolvedValue({
      success: true,
      project: fakeProject,
    });
    await useProjectStore.getState().loadProject('/tmp/p1');

    stub.project.close.mockRejectedValueOnce(new Error('handle leak'));
    await useProjectStore.getState().closeProject();
    expect(useProjectStore.getState().loadState).toEqual({ kind: 'idle' });
  });
});

describe('projectStore.createProject — same machine', () => {
  it('transitions idle → loading → ready on success', async () => {
    stub.project.create.mockResolvedValue({
      success: true,
      project: fakeProject,
    });
    await useProjectStore.getState().createProject('Demo', 'article', '/tmp/p1');
    const s = useProjectStore.getState().loadState;
    expect(s.kind).toBe('ready');
    if (s.kind === 'ready') expect(s.path).toBe('/tmp/p1');
  });

  it('transitions idle → loading → failed on error', async () => {
    stub.project.create.mockRejectedValue(new Error('disk full'));
    await expect(
      useProjectStore.getState().createProject('Demo', 'article', '/tmp/p1')
    ).rejects.toThrow(/disk full/);
    const s = useProjectStore.getState().loadState;
    expect(s.kind).toBe('failed');
    if (s.kind === 'failed') expect(s.error).toBe('disk full');
  });
});
