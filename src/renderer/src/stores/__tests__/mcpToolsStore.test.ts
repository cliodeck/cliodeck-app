/**
 * Tests for the MCP tools store and its pure selectors (fusion 2.5).
 *
 * Covers the auto-enable-by-kind defaults, the override layering, and
 * the two helpers (`selectEnabledToolNames`, `groupToolsByKind`) that
 * BrainstormChat consumes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  useMcpToolsStore,
  computeEffectiveEnabled,
  selectEnabledToolNames,
  groupToolsByKind,
  type MCPToolDescriptor,
} from '../mcpToolsStore';

const TOOLS: readonly MCPToolDescriptor[] = [
  {
    namespaced: 'cliodeck__search_obsidian',
    clientName: 'cliodeck',
    bareName: 'search_obsidian',
  },
  {
    namespaced: 'cliodeck__entity_context',
    clientName: 'cliodeck',
    bareName: 'entity_context',
  },
  {
    namespaced: 'gallica__search_gallica',
    clientName: 'gallica',
    bareName: 'search_gallica',
  },
  // Hypothetical write-class tool from a third-party MCP server.
  {
    namespaced: 'wiki__create_page',
    clientName: 'wiki',
    bareName: 'create_page',
  },
];

beforeEach(() => {
  useMcpToolsStore.getState().resetAll();
});

describe('computeEffectiveEnabled', () => {
  it('defaults read-class tools to enabled', () => {
    expect(computeEffectiveEnabled('search_obsidian', undefined)).toBe(true);
  });

  it('defaults write-class tools to disabled', () => {
    expect(computeEffectiveEnabled('create_page', undefined)).toBe(false);
  });

  it('respects an explicit override over the kind default', () => {
    expect(computeEffectiveEnabled('search_obsidian', false)).toBe(false);
    expect(computeEffectiveEnabled('create_page', true)).toBe(true);
  });
});

describe('selectEnabledToolNames', () => {
  it('returns only read tools when no overrides are set', () => {
    const enabled = selectEnabledToolNames(TOOLS, {});
    expect(enabled).toEqual([
      'cliodeck__search_obsidian',
      'cliodeck__entity_context',
      'gallica__search_gallica',
    ]);
  });

  it('an opt-out drops a read tool from the enabled list', () => {
    const enabled = selectEnabledToolNames(TOOLS, {
      'cliodeck__search_obsidian': false,
    });
    expect(enabled).not.toContain('cliodeck__search_obsidian');
    expect(enabled).toContain('cliodeck__entity_context');
  });

  it('an opt-in adds a write tool to the enabled list', () => {
    const enabled = selectEnabledToolNames(TOOLS, {
      'wiki__create_page': true,
    });
    expect(enabled).toContain('wiki__create_page');
  });
});

describe('groupToolsByKind', () => {
  it('partitions tools into read and write buckets', () => {
    const groups = groupToolsByKind(TOOLS);
    expect(groups.read.map((t) => t.namespaced)).toEqual([
      'cliodeck__search_obsidian',
      'cliodeck__entity_context',
      'gallica__search_gallica',
    ]);
    expect(groups.write.map((t) => t.namespaced)).toEqual(['wiki__create_page']);
  });
});

describe('useMcpToolsStore — actions', () => {
  it('setEnabled persists the override', () => {
    useMcpToolsStore.getState().setEnabled('wiki__create_page', true);
    expect(useMcpToolsStore.getState().overrides['wiki__create_page']).toBe(true);
  });

  it('resetTool removes a single override (falling back to kind default)', () => {
    const s = useMcpToolsStore.getState();
    s.setEnabled('wiki__create_page', true);
    s.setEnabled('cliodeck__search_obsidian', false);
    s.resetTool('cliodeck__search_obsidian');
    const overrides = useMcpToolsStore.getState().overrides;
    expect(overrides['wiki__create_page']).toBe(true);
    expect('cliodeck__search_obsidian' in overrides).toBe(false);
  });

  it('resetAll clears every override', () => {
    const s = useMcpToolsStore.getState();
    s.setEnabled('wiki__create_page', true);
    s.setEnabled('cliodeck__search_obsidian', false);
    s.resetAll();
    expect(useMcpToolsStore.getState().overrides).toEqual({});
  });
});
