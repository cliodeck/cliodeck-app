/**
 * Déclaration du projet auprès des clients MCP.
 *
 * Deux pièges sont épinglés ici parce qu'ils coûteraient cher en vrai :
 * écraser le fichier de configuration d'une autre application (qui contient
 * déjà les serveurs de l'utilisateur), et proposer Claude Desktop sous Linux,
 * où il n'existe pas.
 */

import { describe, it, expect } from 'vitest';
import {
  claudeDesktopConfigPath,
  claudeCodeCommand,
  mergeServerEntry,
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

describe('claudeCodeCommand', () => {
  it('quotes paths containing spaces', () => {
    // Cas réel : les projets vivent souvent sous OneDrive, dont les dossiers
    // ont des espaces. Sans guillemets la commande découpe le chemin.
    const cmd = claudeCodeCommand('mon projet', {
      command: '/Applications/ClioDeck.app/Contents/Resources/bin/cliodeck-mcp',
      args: ['/Users/h/OneDrive/Ma recherche/projet'],
    });
    expect(cmd).toContain('"mon projet"');
    expect(cmd).toContain('"/Users/h/OneDrive/Ma recherche/projet"');
  });

  it('leaves simple arguments bare', () => {
    const cmd = claudeCodeCommand('thesis', { command: '/bin/x', args: ['/p'] });
    expect(cmd).toBe('claude mcp add thesis -- /bin/x /p');
  });
});
