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

function menuText(lang: string, key: string): string {
  return (JSON.parse(readFileSync(path.join(LOCALES, lang, 'menu.json'), 'utf8')) as Record<string, string>)[key];
}

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

  // A10 : un serveur accepté démarre aussi à chaque ouverture d'un projet qui le déclare, sans
  // nouvelle question. Le dialogue le dit, stdio comme SSE, dans les trois langues.
  it.each([
    ['stdio', { name: 'fs', transport: 'stdio' as const, command: 'npx' }],
    ['sse', { name: 'archives', transport: 'sse' as const, url: 'https://collecte.example/sse' }],
  ])('says when the server starts: now, and on every opening of a project that declares it (%s, A10)', async (_t, req) => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
    await confirmMcpAdd(req, { dialog: { showMessageBox } });
    const detail = showMessageBox.mock.calls[0][1].detail as string;
    expect(detail).toMatch(/\bnow\b/);
    expect(detail).toMatch(/without asking again/);
    expect(detail).toMatch(/whenever a project that declares (it|this server) is opened/);
    for (const [lang, opening] of [
      ['fr', "ouverture d'un projet qui déclare"],
      ['de', 'Öffnen eines Projekts'],
    ]) {
      const key = req.transport === 'stdio' ? 'mcpConfirmStdioWarning' : 'mcpConfirmSseWarning';
      expect(menuText(lang, key)).toContain(opening);
    }
  });

  // À l'ouverture d'un projet, l'historien n'ajoute rien : le projet déclare le serveur (A10).
  it('asks about a server the project declares, not about adding one (A10)', async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 1 });
    const ok = await confirmMcpAdd(
      { name: 'europeana', transport: 'stdio', command: 'npx', args: ['-y', '@cliodeck/mcp-europeana'] },
      { dialog: { showMessageBox }, declaredByProject: true }
    );
    expect(ok).toBe(true);
    const opts = showMessageBox.mock.calls[0][1];
    expect(opts.message).toBe('This project declares the MCP server “europeana”. Start it?');
    expect(opts.buttons).toEqual(['Cancel', 'Start MCP server']);
    expect(opts.defaultId).toBe(0);
    expect(opts.cancelId).toBe(0);
    // Le même détail que pour un ajout : la commande, ses arguments, et ce qui s'ensuit.
    expect(opts.detail).toContain('@cliodeck/mcp-europeana');
    expect(opts.detail).toMatch(/without asking again/);
    setLanguage('fr');
    try {
      await confirmMcpAdd({ name: 'europeana', transport: 'stdio', command: 'npx' }, {
        dialog: { showMessageBox },
        declaredByProject: true,
      });
    } finally {
      setLanguage('en');
    }
    expect(showMessageBox.mock.calls[1][1].message).toBe('Ce projet déclare le serveur MCP « europeana ». Le démarrer ?');
    expect(showMessageBox.mock.calls[1][1].buttons).toEqual(['Annuler', 'Démarrer le serveur MCP']);
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
  // que par son nom. La valeur d'une clé d'API reste masquée.
  it('shows the value of the env keys that redirect the command, never that of an API key', async () => {
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

  // Revue de L04-9 : HOME, XDG_CONFIG_HOME, APPDATA, USERPROFILE redirigent la commande par les
  // fichiers de configuration qu'ils désignent (~/.npmrc, pip.conf, uv.toml) : leur nom seul ne
  // permettait pas de juger. Toute valeur qui n'est pas un secret se montre.
  it('shows the value of every non-sensitive key, and warns about HOME and its kin', async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
    await confirmMcpAdd(
      {
        name: 'europeana',
        transport: 'stdio',
        command: 'npx',
        env: {
          HOME: '/Users/x/Projet recu/.home',
          XDG_CONFIG_HOME: '/Users/x/Projet recu/.config',
          APPDATA: 'C:\\Recu\\AppData',
          LOCALAPPDATA: 'C:\\Recu\\Local',
          USERPROFILE: 'C:\\Recu',
          EUROPEANA_LANG: 'fr',
        },
      },
      { dialog: { showMessageBox } }
    );
    const detail = showMessageBox.mock.calls[0][1].detail as string;
    expect(detail).toContain('HOME=/Users/x/Projet recu/.home');
    expect(detail).toContain('XDG_CONFIG_HOME=/Users/x/Projet recu/.config');
    expect(detail).toContain('APPDATA=C:\\Recu\\AppData');
    expect(detail).toContain('LOCALAPPDATA=C:\\Recu\\Local');
    expect(detail).toContain('USERPROFILE=C:\\Recu');
    expect(detail).toContain('EUROPEANA_LANG=fr');
    // L'avertissement nomme les variables qui redirigent la commande, pas les autres.
    const warning = detail.split('\n').find((line) => line.includes('APPDATA') && !line.includes('='));
    expect(warning).toBeDefined();
    for (const key of ['HOME', 'XDG_CONFIG_HOME', 'LOCALAPPDATA', 'USERPROFILE']) expect(warning).toContain(key);
    expect(warning).not.toContain('EUROPEANA_LANG');
  });

  it('never shows the value of a sensitive key, even one that redirects the command', async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
    await confirmMcpAdd(
      {
        name: 'europeana',
        transport: 'stdio',
        command: 'uvx',
        env: {
          UV_INDEX_PRIVATE_PASSWORD: 's3cret-uv',
          NPM_CONFIG__AUTH_TOKEN: 'npm-tok',
          EUROPEANA_API_KEY: '__cliodeck_secret__',
        },
      },
      { dialog: { showMessageBox } }
    );
    const detail = showMessageBox.mock.calls[0][1].detail as string;
    for (const key of ['UV_INDEX_PRIVATE_PASSWORD', 'NPM_CONFIG__AUTH_TOKEN', 'EUROPEANA_API_KEY']) {
      expect(detail).toContain(key);
    }
    expect(detail).not.toContain('s3cret-uv');
    expect(detail).not.toContain('npm-tok');
    expect(detail).not.toContain('__cliodeck_secret__');
    // Aucune valeur montrée : pas d'avertissement qui demande de les vérifier.
    expect(detail).not.toContain(menuText('en', 'mcpConfirmEnvRedirect').split('{{')[0]);
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

  // A10 : la question d'accord se pose à l'ouverture, et l'historien peut y répondre des minutes
  // plus tard. Le dossier du projet a pu disparaître entre-temps (parent renommé, volume débranché) :
  // l'entrée du journal ne le recrée pas (L03-3b).
  it('never recreates the folder of a project that has disappeared', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-audit-'));
    const gone = path.join(tmp, 'parent-renomme', 'These');
    try {
      await appendMcpAudit(path.join(gone, '.cliodeck', 'mcp-access.jsonl'), {
        ts: '2026-11-17T00:00:00.000Z',
        kind: 'mcp_add',
        decision: 'accepted',
        name: 'europeana',
        transport: 'stdio',
        command: 'npx',
        reason: 'workspace_load',
      });
      await expect(fs.readdir(tmp)).resolves.toEqual([]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
