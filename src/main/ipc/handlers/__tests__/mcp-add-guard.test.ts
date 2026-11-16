import { describe, it, expect, vi, beforeAll } from 'vitest';
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
import { loadMenuTranslations, setLanguage } from '../../../i18n.js';

const LOCALES = path.resolve(__dirname, '../../../../../public/locales');

// Les vrais textes de `menu.json` : seul le dossier de l'app est simulé.
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => path.resolve(__dirname, '../../../../..') },
}));

beforeAll(() => {
  loadMenuTranslations();
  setLanguage('en');
});

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

  it('accepts an http(s) sse url (no command to validate)', () => {
    const r = validateMcpAddRequest({
      name: 'remote',
      transport: 'sse',
      url: 'https://example.com/mcp',
    });
    expect(r).toEqual({ ok: true });
    expect(
      validateMcpAddRequest({ name: 'local', transport: 'sse', url: 'http://127.0.0.1:9/sse' })
    ).toEqual({ ok: true });
  });

  // S09-2-3 : l'URL d'un serveur SSE n'était pas regardée. Ce n'est pas l'adresse d'un serveur.
  it('rejects an sse url that is not http(s), or missing', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.com/sse', 'pas une url']) {
      const r = validateMcpAddRequest({ name: 'remote', transport: 'sse', url });
      expect(r, url).toEqual({ ok: false, reason: 'sse_url_invalid' });
    }
    expect(validateMcpAddRequest({ name: 'remote', transport: 'sse' })).toEqual({
      ok: false,
      reason: 'sse_url_invalid',
    });
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

  // S09-2-3 : un serveur SSE passait sans dialogue, au motif qu'il ne lance aucun processus. Mais
  // les arguments des appels d'outils partent vers son adresse.
  it('asks for an sse server too, shows its url, and returns false on cancel', async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
    const ok = await confirmMcpAdd(
      { name: 'archives', transport: 'sse', url: 'https://collecte.example/sse' },
      { dialog: { showMessageBox } }
    );
    expect(ok).toBe(false);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    const opts = showMessageBox.mock.calls[0][1];
    expect(opts.detail).toContain('https://collecte.example/sse');
    // Ce qui part : les arguments des appels d'outils, même avec un modèle local.
    expect(opts.detail).toMatch(/arguments/i);
    expect(opts.defaultId).toBe(0);
    expect(opts.cancelId).toBe(0);
  });

  // S09-1-22 : une variable qui redirige la commande (PATH, registre de paquets) n'était montrée
  // que par son nom. Les autres valeurs restent masquées (une clé d'API).
  it('shows the value of the env keys that redirect the command, and only those', async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
    await confirmMcpAdd(
      {
        name: 'europeana',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@cliodeck/mcp-europeana'],
        env: {
          PATH: '/Users/x/piege/bin',
          NPM_CONFIG_REGISTRY: 'https://registre-hostile.example/',
          PIP_INDEX_URL: 'https://pip.example/simple',
          UV_DEFAULT_INDEX: 'https://uv.example/simple',
          YARN_REGISTRY: 'https://yarn.example/',
          EUROPEANA_API_KEY: 'cle-secrete',
        },
      },
      { dialog: { showMessageBox } }
    );
    const detail = showMessageBox.mock.calls[0][1].detail as string;
    expect(detail).toContain('PATH=/Users/x/piege/bin');
    expect(detail).toContain('NPM_CONFIG_REGISTRY=https://registre-hostile.example/');
    expect(detail).toContain('PIP_INDEX_URL=https://pip.example/simple');
    expect(detail).toContain('UV_DEFAULT_INDEX=https://uv.example/simple');
    expect(detail).toContain('YARN_REGISTRY=https://yarn.example/');
    expect(detail).toContain('EUROPEANA_API_KEY');
    expect(detail).not.toContain('cle-secrete');
  });

  // Le dialogue était en anglais quelle que soit la langue de l'app.
  it('speaks the language of the app', async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
    setLanguage('fr');
    try {
      await confirmMcpAdd(
        { name: 'fs', transport: 'stdio', command: 'npx' },
        { dialog: { showMessageBox } }
      );
    } finally {
      setLanguage('en');
    }
    const opts = showMessageBox.mock.calls[0][1];
    expect(opts.buttons[0]).toBe('Annuler');
    expect(opts.message).toContain('« fs »');
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
