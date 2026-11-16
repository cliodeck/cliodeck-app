/**
 * Déclaration du projet auprès des clients MCP.
 *
 * Deux pièges sont épinglés ici parce qu'ils coûteraient cher en vrai :
 * écraser le fichier de configuration d'une autre application (qui contient
 * déjà les serveurs de l'utilisateur), et proposer Claude Desktop sous Linux,
 * où il n'existe pas.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  claudeDesktopConfigPath,
  claudeCodeCommand,
  installClaudeDesktopEntry,
  launchCommand,
  mcpServerName,
  mergeServerEntry,
  resolveServerName,
  shellQuote,
} from '../client-install.js';

describe('claudeDesktopConfigPath', () => {
  it('locates the config under Application Support on macOS', () => {
    expect(claudeDesktopConfigPath('darwin', { home: '/Users/h' })).toBe(
      '/Users/h/Library/Application Support/Claude/claude_desktop_config.json'
    );
  });

  it('uses APPDATA on Windows', () => {
    expect(claudeDesktopConfigPath('win32', { appData: 'C:\\Users\\h\\AppData\\Roaming' })).toContain(
      'Claude'
    );
  });

  it('returns null on Linux, where Claude Desktop does not exist', () => {
    // Le but n'est pas d'être prudent : c'est qu'un bouton « configurer
    // Claude Desktop » sous Linux écrirait un fichier que rien ne lit.
    expect(claudeDesktopConfigPath('linux', { home: '/home/h' })).toBeNull();
  });
});

describe('mergeServerEntry', () => {
  const entry = { command: '/apps/ClioDeck.app/bin/cliodeck-mcp', args: ['/projects/thesis'] };

  it('keeps the other servers and the other top-level keys', () => {
    const existing = {
      mcpServers: { jdh: { command: 'node', args: ['x.js'] } },
      preferences: { theme: 'dark' },
    };
    const { config, status } = mergeServerEntry(existing, 'thesis', entry);
    expect(status).toBe('added');
    expect(config.preferences).toEqual({ theme: 'dark' });
    expect((config.mcpServers as Record<string, unknown>).jdh).toEqual({
      command: 'node',
      args: ['x.js'],
    });
    expect((config.mcpServers as Record<string, unknown>).thesis).toEqual(entry);
  });

  it('reports a replacement when the name is already taken', () => {
    const existing = { mcpServers: { thesis: { command: '/old/path', args: [] } } };
    expect(mergeServerEntry(existing, 'thesis', entry).status).toBe('replaced');
  });

  it('reports no change when the entry is already identical', () => {
    const existing = { mcpServers: { thesis: entry } };
    expect(mergeServerEntry(existing, 'thesis', entry).status).toBe('unchanged');
  });

  it('starts from scratch when there is no config yet', () => {
    const { config, status } = mergeServerEntry(null, 'thesis', entry);
    expect(status).toBe('added');
    expect(config.mcpServers).toEqual({ thesis: entry });
  });
});

describe('mergeServerEntry — même serveur sous un ancien nom', () => {
  const entry = {
    command: '/Applications/ClioDeck.app/Contents/Resources/bin/cliodeck-mcp',
    args: ['/Users/h/OneDrive/2026_JGH Arena/ARTICLE_Building our forge'],
  };

  it('retire l’entrée identique déclarée sous le nom invalide', () => {
    // Cas réel : Claude Desktop connaissait le projet sous « ARTICLE_Building
    // our forge ». Sans ce ménage, il lancerait deux fois le même serveur.
    const existing = {
      mcpServers: {
        'ARTICLE_Building our forge': entry,
        jdh: { command: 'node', args: ['x.js'] },
      },
    };
    const { config, status } = mergeServerEntry(existing, 'ARTICLE_Building-our-forge', entry);

    expect(status).toBe('replaced');
    expect(Object.keys(config.mcpServers as object).sort()).toEqual(['ARTICLE_Building-our-forge', 'jdh']);
  });

  it('ne touche pas à un autre projet servi par le même binaire', () => {
    const autre = { command: entry.command, args: ['/Users/h/These'] };
    const { config } = mergeServerEntry({ mcpServers: { These: autre } }, 'ARTICLE_Building-our-forge', entry);
    expect((config.mcpServers as Record<string, unknown>).These).toEqual(autre);
  });
});

/**
 * L'interface demande d'ajouter `EUROPEANA_API_KEY` dans l'entrée du projet (`mcpHint`) : c'est le
 * seul endroit où Claude Desktop la lit. Reconfigurer remplaçait l'entrée par `{ command, args }`
 * et l'effaçait (S10-1-36).
 */
describe('mergeServerEntry — ce que l’utilisateur a ajouté à l’entrée reste', () => {
  const entry = { command: '/Applications/ClioDeck.app/Contents/Resources/bin/cliodeck-mcp', args: ['/Users/h/These'] };
  const env = { EUROPEANA_API_KEY: 'cle-test-A' };

  it('même commande, même projet : rien ne change, env compris', () => {
    const existing = { mcpServers: { These: { ...entry, env } } };
    const { config, status } = mergeServerEntry(existing, 'These', entry);

    expect(status).toBe('unchanged');
    expect((config.mcpServers as Record<string, unknown>).These).toEqual({ ...entry, env });
  });

  it('projet déplacé : l’entrée est remplacée, son env reste', () => {
    const existing = { mcpServers: { These: { command: entry.command, args: ['/Volumes/Ancien/These'], env } } };
    const { config, status } = mergeServerEntry(existing, 'These', entry);

    expect(status).toBe('replaced');
    expect((config.mcpServers as Record<string, unknown>).These).toEqual({ ...entry, env });
  });

  it('jumeau sous un autre nom : retiré, et son env passe à l’entrée du projet', () => {
    const existing = {
      mcpServers: { 'These (ancien nom)': { ...entry, env }, jdh: { command: 'node', args: ['x.js'] } },
    };
    const { config, status } = mergeServerEntry(existing, 'These', entry);

    expect(status).toBe('replaced');
    expect(config.mcpServers).toEqual({ jdh: { command: 'node', args: ['x.js'] }, These: { ...entry, env } });
  });
});

/**
 * L'écriture de `claude_desktop_config.json` : le fichier d'une autre application, où l'utilisateur
 * a ses propres serveurs. La copie `.bak` était réécrite à chaque clic, même sans changement : au
 * deuxième clic, la version qui portait la clé était perdue (S10-1-36).
 */
describe('installClaudeDesktopEntry', () => {
  const entry = { command: '/Applications/ClioDeck.app/Contents/Resources/bin/cliodeck-mcp', args: ['/Users/h/These'] };
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cliodeck-claude-desktop-'));
    target = path.join(dir, 'Claude', 'claude_desktop_config.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const backups = (): string[] =>
    readdirSync(path.dirname(target))
      .filter((f) => f !== path.basename(target))
      .sort();

  it('deux écritures qui changent l’entrée : deux copies distinctes, la première garde la clé', async () => {
    const first = { mcpServers: { These: { command: entry.command, args: ['/Volumes/A/These'], env: { EUROPEANA_API_KEY: 'cle-test-A' } } } };
    mkdirSync(path.dirname(target), { recursive: true });
    const original = `${JSON.stringify(first, null, 2)}\n`;
    writeFileSync(target, original);

    const r1 = await installClaudeDesktopEntry(target, 'These', { command: entry.command, args: ['/Volumes/B/These'] });
    const r2 = await installClaudeDesktopEntry(target, 'These', entry);

    expect(r1.status).toBe('replaced');
    expect(r2.status).toBe('replaced');
    const copies = backups();
    expect(copies).toHaveLength(2);
    expect(copies.every((f) => /^claude_desktop_config\.json\..+\.bak$/.test(f))).toBe(true);
    // La copie d'avant le premier clic est intacte, octet pour octet, et lisible du seul utilisateur.
    expect(copies.map((f) => readFileSync(path.join(path.dirname(target), f), 'utf8'))).toContain(original);
    if (process.platform !== 'win32') {
      expect(copies.map((f) => statSync(path.join(path.dirname(target), f)).mode & 0o777)).toEqual([0o600, 0o600]);
    }
    const written = JSON.parse(readFileSync(target, 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(written.mcpServers.These).toEqual({ ...entry, env: { EUROPEANA_API_KEY: 'cle-test-A' } });
  });

  it('sans changement : ni écriture, ni copie', async () => {
    mkdirSync(path.dirname(target), { recursive: true });
    const content = `${JSON.stringify({ mcpServers: { These: { ...entry, env: { EUROPEANA_API_KEY: 'cle-test-A' } } } }, null, 2)}\n`;
    writeFileSync(target, content);
    const before = statSync(target);

    const result = await installClaudeDesktopEntry(target, 'These', entry);

    expect(result).toEqual({ status: 'unchanged', backupPath: null });
    expect(backups()).toEqual([]);
    expect(readFileSync(target, 'utf8')).toBe(content);
    expect(statSync(target).mtimeMs).toBe(before.mtimeMs);
    expect(statSync(target).ino).toBe(before.ino);
  });

  it('deux copies au même instant ne s’écrasent pas', async () => {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ mcpServers: { These: { command: entry.command, args: ['/A'] } } }));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T10:30:00.000Z'));
    try {
      const r1 = await installClaudeDesktopEntry(target, 'These', { command: entry.command, args: ['/B'] });
      const r2 = await installClaudeDesktopEntry(target, 'These', { command: entry.command, args: ['/C'] });

      expect(r1.backupPath).not.toBeNull();
      expect(r2.backupPath).not.toBeNull();
      expect(r1.backupPath).not.toBe(r2.backupPath);
    } finally {
      vi.useRealTimers();
    }
    const copies = backups().map((f) => JSON.parse(readFileSync(path.join(path.dirname(target), f), 'utf8')));
    expect(copies.map((c) => c.mcpServers.These.args[0]).sort()).toEqual(['/A', '/B']);
  });

  it('fichier absent : dossier créé, entrée ajoutée, aucune copie', async () => {
    const result = await installClaudeDesktopEntry(target, 'These', entry);

    expect(result).toEqual({ status: 'added', backupPath: null });
    expect(backups()).toEqual([]);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ mcpServers: { These: entry } });
  });

  it.each([
    ['JSON invalide', Buffer.from('{ "mcpServers": { , }')],
    ['pas un objet', Buffer.from('[1, 2]')],
    ['mcpServers qui n’est pas un objet', Buffer.from('{ "mcpServers": [{ "command": "node" }] }')],
    ['pas en UTF-8', Buffer.from([0x7b, 0x22, 0xe9, 0x22, 0x3a, 0x31, 0x7d])],
  ])('%s : refusé, fichier intact, aucune copie', async (_label, bytes) => {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);

    await expect(installClaudeDesktopEntry(target, 'These', entry)).rejects.toThrow(target);

    expect(readFileSync(target).equals(bytes)).toBe(true);
    expect(backups()).toEqual([]);
  });
});

describe('mcpServerName', () => {
  it('rend valide un nom de dossier OneDrive', () => {
    // Claude Code 2.1 : « Names can only contain letters, numbers,
    // hyphens, and underscores. »
    expect(mcpServerName('ARTICLE_Building our forge')).toBe('ARTICLE_Building-our-forge');
  });

  it('translittère les accents et retire le reste', () => {
    expect(mcpServerName('Thèse — chapitre 3 (v2.1)')).toBe('These-chapitre-3-v2-1');
  });

  it('laisse intact un nom déjà valide', () => {
    expect(mcpServerName('mon-projet_2026')).toBe('mon-projet_2026');
  });

  it('ne rend jamais un nom vide', () => {
    expect(mcpServerName('日本語')).toBe('cliodeck');
  });
});

describe('resolveServerName', () => {
  it('part du dossier du projet quand aucun nom n’est choisi', () => {
    expect(resolveServerName(undefined, '/Users/h/OneDrive/ARTICLE_Building our forge')).toBe(
      'ARTICLE_Building-our-forge'
    );
  });

  it('rend valide aussi un nom choisi dans le panneau', () => {
    expect(resolveServerName('Mon projet', '/p')).toBe('Mon-projet');
  });
});

describe('shellQuote', () => {
  it('laisse nu un argument sans caractère spécial', () => {
    expect(shellQuote('/Applications/ClioDeck.app/bin/cliodeck-mcp', 'darwin')).toBe(
      '/Applications/ClioDeck.app/bin/cliodeck-mcp'
    );
  });

  it('emploie des guillemets simples sous macOS et Linux', () => {
    expect(shellQuote('/Users/h/Ma recherche', 'darwin')).toBe("'/Users/h/Ma recherche'");
    expect(shellQuote("/home/h/l'article", 'linux')).toBe("'/home/h/l'\\''article'");
  });

  it('emploie des guillemets doubles sous Windows', () => {
    expect(shellQuote('C:\\Users\\h\\Ma recherche', 'win32')).toBe('"C:\\Users\\h\\Ma recherche"');
  });
});

/**
 * La seule vérification qui compte : ce qu'un shell fait réellement de la
 * commande. On y remplace `claude` par `printf` pour lire les arguments
 * reçus, un par ligne.
 */
describe.skipIf(process.platform === 'win32')('claudeCodeCommand, découpée par /bin/sh', () => {
  const argvOf = (command: string): string[] =>
    execFileSync('/bin/sh', ['-c', command.replace(/^claude /, "printf '%s\\n' ")], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.length > 0);

  it('garde entier le chemin d’un projet OneDrive', () => {
    // Cas réel. Sans guillemets, le serveur s'enregistrait sous le nom
    // `ARTICLE_Building`, lancé par la commande `our`.
    const root =
      '/Users/h/Library/CloudStorage/OneDrive-UniversityofLuxembourg/2026_JGH Arena on Global History and AI/ARTICLE_Building our forge';
    const binary = '/Applications/ClioDeck.app/Contents/Resources/bin/cliodeck-mcp';

    const command = claudeCodeCommand('ARTICLE_Building our forge', { command: binary, args: [root] }, 'darwin');

    expect(argvOf(command)).toEqual(['mcp', 'add', 'ARTICLE_Building-our-forge', '--', binary, root]);
  });

  it('ne laisse le shell interpréter ni $, ni `, ni !, ni apostrophe', () => {
    const root = "/Users/h/Budget $HOME `id` l'année 2026!";
    const command = claudeCodeCommand('projet', { command: '/bin/cliodeck-mcp', args: [root] }, 'linux');

    expect(argvOf(command)).toEqual(['mcp', 'add', 'projet', '--', '/bin/cliodeck-mcp', root]);
  });

  it('protège aussi la ligne de lancement générique', () => {
    const root = '/Users/h/Ma recherche';
    const line = launchCommand({ command: '/bin/cliodeck-mcp', args: [root] }, 'darwin');
    expect(argvOf(`claude ${line}`)).toEqual(['/bin/cliodeck-mcp', root]);
  });
});
