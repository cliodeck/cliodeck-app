import { describe, it, expect, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  validateMcpAddRequest,
  confirmMcpAdd,
  appendMcpAudit,
  ALLOWED_BARE_COMMANDS,
} from '../mcp-add-guard.js';

describe('validateMcpAddRequest — command whitelist', () => {
  it('accepts whitelisted bare interpreters', () => {
    for (const cmd of ALLOWED_BARE_COMMANDS) {
      const r = validateMcpAddRequest({
        name: 'x',
        transport: 'stdio',
        command: cmd,
      });
      expect(r).toEqual({ ok: true });
    }
  });

  it('rejects a non-whitelisted bare command', () => {
    const r = validateMcpAddRequest({
      name: 'x',
      transport: 'stdio',
      command: 'rm',
    });
    expect(r).toEqual({ ok: false, reason: 'command_not_in_whitelist' });
  });

  it('rejects a relative path like ./evil.sh', () => {
    const r = validateMcpAddRequest({
      name: 'x',
      transport: 'stdio',
      command: './evil.sh',
    });
    expect(r).toEqual({ ok: false, reason: 'relative_path_not_allowed' });
  });

  it('accepts an absolute path without shell metachars', () => {
    const r = validateMcpAddRequest({
      name: 'x',
      transport: 'stdio',
      command: '/usr/local/bin/my-mcp-server',
    });
    expect(r.ok).toBe(true);
  });

  it('rejects an absolute path with shell metachars', () => {
    const r = validateMcpAddRequest({
      name: 'x',
      transport: 'stdio',
      command: '/tmp/foo;rm -rf /',
    });
    expect(r).toEqual({ ok: false, reason: 'command_contains_shell_metachars' });
  });

  it('rejects env keys with lowercase / bad shape', () => {
    const r = validateMcpAddRequest({
      name: 'x',
      transport: 'stdio',
      command: 'node',
      env: { 'Bad-Key': 'v' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^env_key_invalid:/);
  });

  it('rejects env values containing control chars', () => {
    const r = validateMcpAddRequest({
      name: 'x',
      transport: 'stdio',
      command: 'node',
      env: { FOO: 'bar\nbaz' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^env_value_control_chars:/);
  });

  it('passes through sse requests (no command to validate)', () => {
    const r = validateMcpAddRequest({
      name: 'remote',
      transport: 'sse',
      url: 'https://example.com/mcp',
    });
    expect(r).toEqual({ ok: true });
  });
});

describe('confirmMcpAdd — native dialog gate', () => {
  it('returns true only when the user clicks the non-default "Add" button', async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 1 });
    const ok = await confirmMcpAdd(
      {
        name: 'fs',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      },
      { dialog: { showMessageBox } }
    );
    expect(ok).toBe(true);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    const opts = showMessageBox.mock.calls[0][1];
    // Must be a warning dialog with "Cancel" as the default/cancel button so
    // the renderer cannot trick the user into auto-accepting via Enter.
    expect(opts.type).toBe('warning');
    expect(opts.defaultId).toBe(0);
    expect(opts.cancelId).toBe(0);
    expect(opts.buttons[0]).toBe('Cancel');
  });

  it('returns false when the user cancels (response 0)', async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
    const ok = await confirmMcpAdd(
      { name: 'fs', transport: 'stdio', command: 'npx' },
      { dialog: { showMessageBox } }
    );
    expect(ok).toBe(false);
  });
});

describe('appendMcpAudit', () => {
  it('appends a JSONL line with the decision + reason', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-audit-'));
    const logPath = path.join(tmp, 'sub', 'mcp-access.jsonl');
    await appendMcpAudit(logPath, {
      ts: '2026-04-15T00:00:00.000Z',
      kind: 'mcp_add',
      decision: 'rejected',
      name: 'evil',
      transport: 'stdio',
      command: 'rm',
      reason: 'command_not_in_whitelist',
    });
    const content = await fs.readFile(logPath, 'utf8');
    const line = JSON.parse(content.trim());
    expect(line.decision).toBe('rejected');
    expect(line.reason).toBe('command_not_in_whitelist');
    expect(line.kind).toBe('mcp_add');
  });
});
