import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { MCPAccessLogger } from '../logger.js';
import type { MCPAccessEvent } from '../events.js';

let tmp = '';
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cliodeck-mcp-log-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('MCPAccessLogger (2.5)', () => {
  it('appends typed events as JSONL, creating dirs', async () => {
    const logPath = path.join(tmp, 'nested', 'mcp-access.jsonl');
    const logger = new MCPAccessLogger(logPath);
    logger.open();
    logger.log({
      kind: 'server_started',
      at: '2026-04-13T00:00:00Z',
      transport: 'stdio',
      workspace: tmp,
    });
    logger.log({
      kind: 'tool_call',
      at: '2026-04-13T00:00:01Z',
      name: 'search_obsidian',
      input: { query: 'vichy', topK: 5 },
      output: { itemCount: 5, totalChars: 1234 },
    });
    logger.log({
      kind: 'server_stopped',
      at: '2026-04-13T00:00:02Z',
      reason: 'requested',
    });
    logger.close();

    const raw = await fs.readFile(logPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    const parsed = lines.map((l) => JSON.parse(l) as MCPAccessEvent);
    expect(parsed.map((e) => e.kind)).toEqual([
      'server_started',
      'tool_call',
      'server_stopped',
    ]);
  });

  it('exposes its own log path', async () => {
    const p = path.join(tmp, 'log.jsonl');
    const logger = new MCPAccessLogger(p);
    expect(logger.path).toBe(p);
  });

  it('exhaustive narrowing across MCPAccessEvent variants', () => {
    const events: MCPAccessEvent[] = [
      { kind: 'tool_call', at: 't', name: 'n', input: {}, output: {} },
      { kind: 'resource_read', at: 't', uri: 'u', output: {} },
      { kind: 'prompt_get', at: 't', name: 'n', args: {} },
      { kind: 'server_started', at: 't', transport: 'stdio', workspace: 'w' },
      { kind: 'server_stopped', at: 't', reason: 'requested' },
    ];
    const labels: string[] = [];
    for (const e of events) {
      switch (e.kind) {
        case 'tool_call':
        case 'resource_read':
        case 'prompt_get':
        case 'server_started':
        case 'server_stopped':
          labels.push(e.kind);
          break;
      }
    }
    expect(labels).toHaveLength(events.length);
  });
});
