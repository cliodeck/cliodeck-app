/**
 * L'accord retiré s'applique au prochain appel (S10-1-23).
 *
 * Claude Desktop garde le serveur vivant des jours durant. Il lisait la
 * configuration une fois, au démarrage : décocher l'interrupteur, ou retirer
 * la lecture du manuscrit, affichait « off » dans l'app sans rien couper.
 * Ici, un vrai client du SDK, branché en mémoire, appelle le serveur avant
 * et après le changement écrit sur disque — sans relance.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ensureWorkspaceDirectories, workspaceFiles } from '../../core/workspace/layout.js';
import { defaultWorkspaceConfig, writeWorkspaceConfig } from '../../core/workspace/config.js';
import { loadMCPConfig, type MCPServerSettings } from '../config.js';
import { createMcpServer, type ClioDeckMcpServer } from '../server.js';

const SECRET = 'Le chapitre inédit sur la grève de 1906, mot pour mot.';
const GRANTED: MCPServerSettings = {
  enabled: true,
  tools: { list_manuscript: true, read_manuscript: true },
};

let tmp = '';
let outside = '';
let running: ClioDeckMcpServer | null = null;
let client: Client | null = null;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cliodeck-mcp-call-gate-'));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cliodeck-mcp-call-gate-outside-'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  await client?.close();
  running?.logger.close();
  client = null;
  running = null;
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function writeSettings(mcp: MCPServerSettings): Promise<void> {
  const cfg = defaultWorkspaceConfig('demo') as Record<string, unknown>;
  cfg.mcpServer = mcp;
  await writeWorkspaceConfig(tmp, cfg as never);
}

/** Un projet article dont le manuscrit est lisible, et un client connecté. */
async function connect(): Promise<Client> {
  await ensureWorkspaceDirectories(tmp);
  await fs.writeFile(path.join(tmp, 'document.md'), SECRET, 'utf8');
  await writeSettings(GRANTED);

  running = createMcpServer(loadMCPConfig(tmp));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await running.server.connect(serverSide);
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

type CallResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

async function readManuscript(c: Client): Promise<CallResult> {
  return (await c.callTool({
    name: 'read_manuscript',
    arguments: { path: 'document.md' },
  })) as CallResult;
}

const textOf = (r: CallResult): string => r.content.map((p) => p.text ?? '').join('\n');

async function accessLog(): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(workspaceFiles(tmp).mcpAccessLog, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('serveur MCP — accord relu à chaque appel', () => {
  it('refuses the next call once the server toggle is off, without a restart', async () => {
    const c = await connect();
    expect(textOf(await readManuscript(c))).toContain(SECRET);

    await writeSettings({ ...GRANTED, enabled: false });
    const refused = await readManuscript(c);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).not.toContain(SECRET);
    expect(JSON.parse(textOf(refused))).toMatchObject({ error: 'tool_refused' });
  });

  it('refuses a tool whose grant was withdrawn, and resumes once it is granted again', async () => {
    const c = await connect();

    await writeSettings({ enabled: true, tools: { list_manuscript: true, read_manuscript: false } });
    const refused = await readManuscript(c);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).not.toContain(SECRET);

    await writeSettings(GRANTED);
    const again = await readManuscript(c);
    expect(again.isError).toBeFalsy();
    expect(textOf(again)).toContain(SECRET);
  });

  it('keeps one grant for both manuscript tools, as at registration', async () => {
    const c = await connect();
    await writeSettings({ enabled: true, tools: { list_manuscript: false, read_manuscript: true } });
    const refused = await readManuscript(c);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).not.toContain(SECRET);
  });

  it('refuses when config.json is truncated: an unreadable grant is no grant', async () => {
    const c = await connect();
    const file = workspaceFiles(tmp).config;
    const full = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, full.slice(0, Math.floor(full.length / 2)), 'utf8');

    const refused = await readManuscript(c);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).not.toContain(SECRET);
  });

  it('logs the refusal without the client arguments', async () => {
    const c = await connect();
    await writeSettings({ ...GRANTED, enabled: false });
    await readManuscript(c);

    const refusal = (await accessLog()).filter((e) => e.kind === 'tool_call').pop();
    expect(refusal).toMatchObject({ name: 'read_manuscript', input: {} });
    expect(String((refusal?.output as Record<string, unknown>).error)).toContain('tool_refused');
    expect(JSON.stringify(refusal)).not.toContain('document.md');
    expect(JSON.stringify(refusal)).not.toContain(SECRET);
  });

  it('refuses when config.json is a link leading outside the project, and writes nothing through it', async () => {
    const c = await connect();
    // Une configuration qui accorde tout, mais hors du projet : la garde de lien (D18) la refuse.
    const file = workspaceFiles(tmp).config;
    const elsewhere = path.join(outside, 'config.json');
    await fs.copyFile(file, elsewhere);
    await fs.rm(file);
    await fs.symlink(elsewhere, file);
    const log = workspaceFiles(tmp).mcpAccessLog;
    const logElsewhere = path.join(outside, 'mcp-access.jsonl');
    await fs.writeFile(logElsewhere, '', 'utf8');
    await fs.rm(log);
    await fs.symlink(logElsewhere, log);

    const refused = await readManuscript(c);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).not.toContain(SECRET);
    expect(await fs.readFile(logElsewhere, 'utf8')).toBe('');
  });
});
