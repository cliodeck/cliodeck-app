/**
 * Enregistrement conditionnel des outils.
 *
 * Le README promettait depuis l'origine que rien ne part vers un client MCP
 * « sans opt-in par outil ». La garde n'existait pas : les neuf outils
 * étaient enregistrés sans condition. Ces tests l'épinglent, y compris la
 * compatibilité — un projet qui avait déjà activé le serveur ne doit pas se
 * retrouver muet après mise à jour.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ensureWorkspaceDirectories } from '../../core/workspace/layout.js';
import { defaultWorkspaceConfig, writeWorkspaceConfig } from '../../core/workspace/config.js';
import { loadMCPConfig, type MCPServerSettings } from '../config.js';
import { createMcpServer } from '../server.js';

let tmp = '';

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cliodeck-mcp-tools-gate-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Monte un workspace, crée le serveur, et rend la liste d'outils annoncée. */
async function exposedTools(mcpServer: MCPServerSettings): Promise<string[]> {
  await ensureWorkspaceDirectories(tmp);
  const cfg = defaultWorkspaceConfig('demo') as Record<string, unknown>;
  cfg.mcpServer = mcpServer;
  await writeWorkspaceConfig(tmp, cfg as never);

  const lines: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    lines.push(a.join(' '));
  });
  const { logger } = createMcpServer(loadMCPConfig(tmp));
  logger.close();

  const line = lines.find((l) => l.includes('[ClioDeck MCP] Tools:'));
  const list = (line ?? '').split('Tools:')[1]?.trim() ?? '';
  return list === '(aucun)' || list === '' ? [] : list.split(',').map((s) => s.trim());
}

describe('createMcpServer — opt-in par outil', () => {
  it('exposes all nine tools when nothing is refused', async () => {
    const tools = await exposedTools({ enabled: true });
    expect(tools).toHaveLength(9);
    expect(tools).toContain('search_documents');
  });

  it('does not register a refused tool at all', async () => {
    // Pas « refusé à l'appel » : non enregistré. Un outil refusé mais
    // déclaré laisserait fuiter son nom, sa description et son schéma.
    const tools = await exposedTools({
      enabled: true,
      tools: { search_documents: false, search_tropy: false },
    });
    expect(tools).not.toContain('search_documents');
    expect(tools).not.toContain('search_tropy');
    expect(tools).toContain('search_obsidian');
    expect(tools).toHaveLength(7);
  });

  it('withholds the manuscript tools until they are granted', async () => {
    // L'inverse de la règle générale, et c'est le point : lire le manuscrit
    // ne doit pas s'attraper par défaut au fil d'une mise à jour.
    const tools = await exposedTools({ enabled: true });
    expect(tools).not.toContain('read_manuscript');
    expect(tools).not.toContain('list_manuscript');

    const granted = await exposedTools({
      enabled: true,
      tools: { list_manuscript: true, read_manuscript: true },
    });
    expect(granted).toContain('read_manuscript');
    expect(granted).toHaveLength(11);
  });

  it('can withhold every tool', async () => {
    const all = Object.fromEntries(
      [
        'search_obsidian',
        'search_zotero',
        'search_documents',
        'search_tropy',
        'graph_neighbors',
        'entity_context',
        'search_gallica',
        'search_hal',
        'search_europeana',
      ].map((n) => [n, false])
    );
    expect(await exposedTools({ enabled: true, tools: all })).toEqual([]);
  });
});
