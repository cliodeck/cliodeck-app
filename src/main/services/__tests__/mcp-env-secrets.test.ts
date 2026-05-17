/**
 * Tests for the MCP env-secret routing helpers (fusion 1.5).
 *
 * `secureStorage` lives behind Electron's `safeStorage`, which can't be
 * spun up under Vitest. We replace it with an in-memory backing map so
 * the helpers can be exercised without an Electron host.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Replace the secure-storage singleton with an in-memory shim *before*
// the module under test is imported. The shim mirrors the surface used
// by `mcp-env-secrets.ts` (`setKey`, `getKey`, `deleteKey`, `hasKey`).
const memoryStore = new Map<string, string>();
vi.mock('../secure-storage.js', () => ({
  secureStorage: {
    setKey: (k: string, v: string) => {
      if (!v) memoryStore.delete(k);
      else memoryStore.set(k, v);
    },
    getKey: (k: string) => memoryStore.get(k) ?? '',
    deleteKey: (k: string) => {
      memoryStore.delete(k);
    },
    hasKey: (k: string) => memoryStore.has(k),
  },
  // The real module also exports SENSITIVE_KEYS; the helper doesn't
  // touch it, but re-exporting keeps the mock shape honest.
  SENSITIVE_KEYS: [] as const,
  isSensitiveKey: () => false,
}));

import {
  SECRET_SENTINEL,
  isSensitiveEnvVarName,
  secretKeyFor,
  migrateClientEnvSecrets,
  resolveClientEnvSecrets,
  deleteClientEnvSecrets,
} from '../mcp-env-secrets.js';
import type { MCPClientConfig } from '../../../../backend/core/workspace/config.js';

beforeEach(() => {
  memoryStore.clear();
});

describe('isSensitiveEnvVarName', () => {
  it('flags the obvious suffixes', () => {
    expect(isSensitiveEnvVarName('OPENAI_API_KEY')).toBe(true);
    expect(isSensitiveEnvVarName('GITHUB_TOKEN')).toBe(true);
    expect(isSensitiveEnvVarName('DB_PASSWORD')).toBe(true);
    expect(isSensitiveEnvVarName('STRIPE_SECRET')).toBe(true);
    expect(isSensitiveEnvVarName('AWS_CREDENTIALS')).toBe(true);
    expect(isSensitiveEnvVarName('USER_PASS')).toBe(true);
  });

  it('leaves benign names alone', () => {
    expect(isSensitiveEnvVarName('PATH')).toBe(false);
    expect(isSensitiveEnvVarName('NODE_ENV')).toBe(false);
    expect(isSensitiveEnvVarName('LANG')).toBe(false);
    expect(isSensitiveEnvVarName('HOME')).toBe(false);
  });
});

describe('migrateClientEnvSecrets', () => {
  it('moves sensitive values to secureStorage and writes a sentinel back', () => {
    const client: MCPClientConfig = {
      name: 'gallica',
      transport: 'stdio',
      command: 'gallica-mcp',
      env: {
        GALLICA_API_KEY: 'super-secret-123',
        NODE_ENV: 'production',
      },
    };
    const migrated = migrateClientEnvSecrets(client);
    expect(migrated).toBe(true);
    expect(client.env!.GALLICA_API_KEY).toBe(SECRET_SENTINEL);
    expect(client.env!.NODE_ENV).toBe('production');
    expect(memoryStore.get(secretKeyFor('gallica', 'GALLICA_API_KEY'))).toBe(
      'super-secret-123'
    );
  });

  it('is idempotent — already-migrated entries are skipped', () => {
    const client: MCPClientConfig = {
      name: 'a',
      transport: 'stdio',
      command: 'x',
      env: { TOKEN: SECRET_SENTINEL },
    };
    const migrated = migrateClientEnvSecrets(client);
    expect(migrated).toBe(false);
    expect(client.env!.TOKEN).toBe(SECRET_SENTINEL);
    // Crucially, we did NOT overwrite the stored secret with the sentinel.
    expect(memoryStore.has(secretKeyFor('a', 'TOKEN'))).toBe(false);
  });

  it('returns false when the client has no env block', () => {
    const client: MCPClientConfig = {
      name: 'remote',
      transport: 'sse',
      url: 'https://x.example/mcp',
    };
    expect(migrateClientEnvSecrets(client)).toBe(false);
  });

  it('returns false when no env keys look sensitive', () => {
    const client: MCPClientConfig = {
      name: 'a',
      transport: 'stdio',
      command: 'x',
      env: { PATH: '/usr/bin', NODE_ENV: 'dev' },
    };
    expect(migrateClientEnvSecrets(client)).toBe(false);
    expect(memoryStore.size).toBe(0);
  });
});

describe('resolveClientEnvSecrets', () => {
  it('replaces sentinels with the real value from secureStorage', () => {
    memoryStore.set(secretKeyFor('gallica', 'KEY'), 'real-value');
    const out = resolveClientEnvSecrets('gallica', {
      KEY: SECRET_SENTINEL,
      NODE_ENV: 'production',
    });
    expect(out).toEqual({ KEY: 'real-value', NODE_ENV: 'production' });
  });

  it('drops env vars whose secret is missing rather than passing empty', () => {
    // No entry in the memory store — secret is gone (deleted secret store?
    // first run before migration?). Dropping the env var lets the spawned
    // MCP server fail loudly rather than silently authenticating as nobody.
    const out = resolveClientEnvSecrets('gallica', {
      KEY: SECRET_SENTINEL,
      NODE_ENV: 'production',
    });
    expect(out).toEqual({ NODE_ENV: 'production' });
  });

  it('returns undefined for an undefined env block', () => {
    expect(resolveClientEnvSecrets('any', undefined)).toBeUndefined();
  });

  it('passes plain values through unchanged', () => {
    expect(
      resolveClientEnvSecrets('any', { FOO: 'bar', BAZ: 'qux' })
    ).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });
});

describe('deleteClientEnvSecrets', () => {
  it('clears every secret-shaped entry the client owned', () => {
    memoryStore.set(secretKeyFor('gallica', 'API_KEY'), 'v1');
    memoryStore.set(secretKeyFor('gallica', 'TOKEN'), 'v2');
    memoryStore.set(secretKeyFor('OTHER', 'API_KEY'), 'untouched');

    const client: MCPClientConfig = {
      name: 'gallica',
      transport: 'stdio',
      command: 'x',
      env: { API_KEY: SECRET_SENTINEL, TOKEN: SECRET_SENTINEL, NODE_ENV: 'p' },
    };
    deleteClientEnvSecrets(client);

    expect(memoryStore.has(secretKeyFor('gallica', 'API_KEY'))).toBe(false);
    expect(memoryStore.has(secretKeyFor('gallica', 'TOKEN'))).toBe(false);
    // Other clients' secrets are untouched.
    expect(memoryStore.get(secretKeyFor('OTHER', 'API_KEY'))).toBe('untouched');
  });

  it('is a no-op for clients with no env block', () => {
    deleteClientEnvSecrets({
      name: 'remote',
      transport: 'sse',
      url: 'https://x.example/mcp',
    });
    // Nothing thrown, nothing deleted.
    expect(memoryStore.size).toBe(0);
  });
});
