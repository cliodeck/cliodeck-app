/**
 * Tests for the MCP tool kind classifier (fusion 2.5).
 *
 * The whitelist behaviour matters in two directions:
 *   - every cliodeck builtin tool must classify as `'read'` so it
 *     auto-enables in Brainstorm;
 *   - common write-class verbs (`create_*`, `delete_*`, `send_*`) must
 *     classify as `'write'` so they require an explicit opt-in.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyMcpTool,
  classifyNamespacedMcpTool,
} from '../tool-classifier.js';

describe('classifyMcpTool — cliodeck builtin tools', () => {
  it.each([
    ['search_obsidian'],
    ['search_zotero'],
    ['search_documents'],
    ['search_tropy'],
    ['search_gallica'],
    ['search_hal'],
    ['search_europeana'],
    ['entity_context'],
    ['graph_neighbors'],
  ])('classifies %s as read (auto-enable)', (name) => {
    expect(classifyMcpTool(name)).toBe('read');
  });
});

describe('classifyMcpTool — common verb prefixes', () => {
  it.each([
    ['get_user'],
    ['list_files'],
    ['find_email'],
    ['fetch_url'],
    ['view_document'],
    ['show_table'],
    ['lookup_isbn'],
    ['query_database'],
    ['count_results'],
    ['describe_entity'],
    ['inspect_payload'],
    ['analyze_text'],
    ['analyse_text'],
    ['read_file'],
  ])('classifies %s as read', (name) => {
    expect(classifyMcpTool(name)).toBe('read');
  });

  it.each([
    ['create_issue'],
    ['delete_record'],
    ['send_email'],
    ['post_message'],
    ['update_config'],
    ['put_object'],
    ['patch_branch'],
    ['save_draft'],
    ['add_comment'],
    ['remove_label'],
    ['execute_query'],
    ['run_script'],
    ['eval'],
    ['write_file'],
  ])('classifies %s as write (opt-in)', (name) => {
    expect(classifyMcpTool(name)).toBe('write');
  });
});

describe('classifyMcpTool — exact-match reads', () => {
  it.each([['ping'], ['health'], ['healthcheck'], ['whoami'], ['version']])(
    'classifies %s as read',
    (name) => {
      expect(classifyMcpTool(name)).toBe('read');
    }
  );

  it('is case-insensitive for the exact-match reads', () => {
    expect(classifyMcpTool('Health')).toBe('read');
    expect(classifyMcpTool('VERSION')).toBe('read');
  });
});

describe('classifyMcpTool — defaults to write when uncertain', () => {
  it.each([
    [''],
    ['unknown_tool'],
    ['xyz'],
    // A name that looks superficially like a search but starts with a
    // non-read verb — the default-to-write rule keeps the user safe.
    ['searchify_then_delete'],
  ])('classifies %s as write', (name) => {
    expect(classifyMcpTool(name)).toBe('write');
  });
});

describe('classifyNamespacedMcpTool — strips the `clientName__` prefix', () => {
  it('classifies the bare name behind the namespace', () => {
    expect(classifyNamespacedMcpTool('cliodeck__search_obsidian')).toBe('read');
    expect(classifyNamespacedMcpTool('gallica__search_gallica')).toBe('read');
    expect(classifyNamespacedMcpTool('myserver__create_issue')).toBe('write');
  });

  it('falls back to classifying the whole string when no `__` separator is present', () => {
    expect(classifyNamespacedMcpTool('search_obsidian')).toBe('read');
    expect(classifyNamespacedMcpTool('eval')).toBe('write');
  });
});
