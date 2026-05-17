import { describe, it, expect, beforeEach } from 'vitest';
import {
  useWorkspaceModeStore,
  WORKSPACE_MODES,
} from '../workspaceModeStore';

beforeEach(() => {
  // Reset to default; persist middleware writes to localStorage but in vitest
  // the global is undefined, so the store falls back to memory.
  useWorkspaceModeStore.setState({ active: 'write' });
});

describe('workspaceModeStore (3.1a)', () => {
  it('exposes the four canonical modes in correct order', () => {
    expect(WORKSPACE_MODES).toEqual([
      'explore',
      'brainstorm',
      'write',
      'export',
    ]);
  });

  it('defaults to write so existing UX is unchanged on first run', () => {
    expect(useWorkspaceModeStore.getState().active).toBe('write');
  });

  it('switches active mode via setActive', () => {
    useWorkspaceModeStore.getState().setActive('brainstorm');
    expect(useWorkspaceModeStore.getState().active).toBe('brainstorm');
    useWorkspaceModeStore.getState().setActive('explore');
    expect(useWorkspaceModeStore.getState().active).toBe('explore');
  });
});
