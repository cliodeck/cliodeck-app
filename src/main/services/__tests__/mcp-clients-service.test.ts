import { describe, it, expect } from 'vitest';
import { toManagerConfig } from '../mcp-clients-service.js';

describe('toManagerConfig — WorkspaceMCPClient → MCPClientConfig', () => {
  it('maps a stdio client with args + env', () => {
    const out = toManagerConfig({
      name: 'fs',
      transport: 'stdio',
      command: '/usr/bin/python',
      args: ['-m', 'mcp.fs'],
      env: { FOO: 'bar' },
    });
    expect(out).toEqual({
      name: 'fs',
      config: {
        transport: 'stdio',
        command: '/usr/bin/python',
        args: ['-m', 'mcp.fs'],
        env: { FOO: 'bar' },
      },
    });
  });

  it('maps a minimal stdio client (no args, no env)', () => {
    const out = toManagerConfig({
      name: 'bare',
      transport: 'stdio',
      command: 'cliodeck-mcp',
    });
    expect(out.config.transport).toBe('stdio');
    expect((out.config as { command: string }).command).toBe('cliodeck-mcp');
  });

  it('maps an sse client', () => {
    const out = toManagerConfig({
      name: 'remote',
      transport: 'sse',
      url: 'https://example.com/mcp/sse',
    });
    expect(out).toEqual({
      name: 'remote',
      config: { transport: 'sse', url: 'https://example.com/mcp/sse' },
    });
  });

  it('throws when stdio config has no command', () => {
    expect(() =>
      toManagerConfig({ name: 'broken', transport: 'stdio' })
    ).toThrowError(/requires a command/);
  });

  it('throws when sse config has no url', () => {
    expect(() =>
      toManagerConfig({ name: 'broken', transport: 'sse' })
    ).toThrowError(/requires a url/);
  });
});
