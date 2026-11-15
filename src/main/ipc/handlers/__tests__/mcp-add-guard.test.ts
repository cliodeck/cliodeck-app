import { describe, it, expect, vi } from 'vitest';
import fs from 'fs/promises';
import { readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  validateMcpAddRequest,
  confirmMcpAdd,
  appendMcpAudit,
  ALLOWED_BARE_COMMANDS,
} from '../mcp-add-guard.js';

const LOCALES = path.resolve(__dirname, '../../../../../public/locales');

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

describe('the command placeholder of Settings → MCP clients', () => {
  // It proposed `cliodeck-mcp-server`, a bare command the whitelist refuses
  // (command_not_in_whitelist): following the example led to a refusal.
  it.each(['fr', 'en', 'de'])('%s: every command it suggests passes the guard', (lang) => {
    const locale = JSON.parse(
      readFileSync(path.join(LOCALES, lang, 'common.json'), 'utf8')
    ) as { mcp: { form: { commandPlaceholder: string } } };
    const commands = locale.mcp.form.commandPlaceholder
      .split(',')
      .map((c) => c.replace(/…$/, '').trim());

    expect(commands.length).toBeGreaterThan(1);
    for (const command of commands) {
      expect(validateMcpAddRequest({ name: 'x', transport: 'stdio', command }), command).toEqual({
        ok: true,
      });
    }
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

  it('says when the process starts: now, not on every project load (A10)', async () => {
    // No MCP client starts when a project opens (A10): the server starts when
    // it is added, and again when the user restarts it.
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
    await confirmMcpAdd(
      { name: 'fs', transport: 'stdio', command: 'npx' },
      { dialog: { showMessageBox } }
    );
    const detail = showMessageBox.mock.calls[0][1].detail as string;
    expect(detail).not.toMatch(/project load/i);
    expect(detail).toMatch(/\bnow\b/);
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
