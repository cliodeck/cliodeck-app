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
  legacySecretKeyFor,
  migrateClientEnvSecrets,
  resolveClientEnvSecrets,
  deleteClientEnvSecrets,
  secretsScopeOf,
  ensureSecretsScope,
} from '../mcp-env-secrets.js';
import type { MCPClientConfig, WorkspaceConfig } from '../../../../backend/core/workspace/config.js';

/** Deux portées, comme deux projets. */
const SCOPE = '0b9f4c1e-6a51-4d1c-9a43-2f0d8f6c7e11';
const OTHER_SCOPE = '7d3a2b90-1c4e-4f8a-b6d2-93e5a0c4f1aa';

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
    const migrated = migrateClientEnvSecrets(SCOPE, client);
    expect(migrated).toBe(true);
    expect(client.env!.GALLICA_API_KEY).toBe(SECRET_SENTINEL);
    expect(client.env!.NODE_ENV).toBe('production');
    expect(memoryStore.get(secretKeyFor(SCOPE, 'gallica', 'GALLICA_API_KEY'))).toBe(
      'super-secret-123'
    );
    // Rien sous la clé globale d'avant : un autre projet n'y lirait que sa propre clé.
    expect(memoryStore.has(legacySecretKeyFor('gallica', 'GALLICA_API_KEY'))).toBe(false);
  });

  it('is idempotent — already-migrated entries are skipped', () => {
    const client: MCPClientConfig = {
      name: 'a',
      transport: 'stdio',
      command: 'x',
      env: { TOKEN: SECRET_SENTINEL },
    };
    const migrated = migrateClientEnvSecrets(SCOPE, client);
    expect(migrated).toBe(false);
    expect(client.env!.TOKEN).toBe(SECRET_SENTINEL);
    // Crucially, we did NOT overwrite the stored secret with the sentinel.
    expect(memoryStore.has(secretKeyFor(SCOPE, 'a', 'TOKEN'))).toBe(false);
  });

  it('returns false when the client has no env block', () => {
    const client: MCPClientConfig = {
      name: 'remote',
      transport: 'sse',
      url: 'https://x.example/mcp',
    };
    expect(migrateClientEnvSecrets(SCOPE, client)).toBe(false);
  });

  it('returns false when no env keys look sensitive', () => {
    const client: MCPClientConfig = {
      name: 'a',
      transport: 'stdio',
      command: 'x',
      env: { PATH: '/usr/bin', NODE_ENV: 'dev' },
    };
    expect(migrateClientEnvSecrets(SCOPE, client)).toBe(false);
    expect(memoryStore.size).toBe(0);
  });
});

describe('resolveClientEnvSecrets', () => {
  it('replaces sentinels with the real value from secureStorage', () => {
    memoryStore.set(secretKeyFor(SCOPE, 'gallica', 'KEY'), 'real-value');
    const out = resolveClientEnvSecrets(SCOPE, 'gallica', {
      KEY: SECRET_SENTINEL,
      NODE_ENV: 'production',
    });
    expect(out).toEqual({ KEY: 'real-value', NODE_ENV: 'production' });
  });

  it('drops env vars whose secret is missing rather than passing empty', () => {
    // No entry in the memory store — secret is gone (deleted secret store?
    // first run before migration?). Dropping the env var lets the spawned
    // MCP server fail loudly rather than silently authenticating as nobody.
    const out = resolveClientEnvSecrets(SCOPE, 'gallica', {
      KEY: SECRET_SENTINEL,
      NODE_ENV: 'production',
    });
    expect(out).toEqual({ NODE_ENV: 'production' });
  });

  it('returns undefined for an undefined env block', () => {
    expect(resolveClientEnvSecrets(SCOPE, 'any', undefined)).toBeUndefined();
  });

  it('passes plain values through unchanged', () => {
    expect(
      resolveClientEnvSecrets(SCOPE, 'any', { FOO: 'bar', BAZ: 'qux' })
    ).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });
});

describe('deleteClientEnvSecrets', () => {
  it('clears every secret-shaped entry the client owned', () => {
    memoryStore.set(secretKeyFor(SCOPE, 'gallica', 'API_KEY'), 'v1');
    memoryStore.set(secretKeyFor(SCOPE, 'gallica', 'TOKEN'), 'v2');
    memoryStore.set(secretKeyFor(SCOPE, 'OTHER', 'API_KEY'), 'untouched');

    const client: MCPClientConfig = {
      name: 'gallica',
      transport: 'stdio',
      command: 'x',
      env: { API_KEY: SECRET_SENTINEL, TOKEN: SECRET_SENTINEL, NODE_ENV: 'p' },
    };
    deleteClientEnvSecrets(SCOPE, client);

    expect(memoryStore.has(secretKeyFor(SCOPE, 'gallica', 'API_KEY'))).toBe(false);
    expect(memoryStore.has(secretKeyFor(SCOPE, 'gallica', 'TOKEN'))).toBe(false);
    // Other clients' secrets are untouched.
    expect(memoryStore.get(secretKeyFor(SCOPE, 'OTHER', 'API_KEY'))).toBe('untouched');
  });

  it('is a no-op for clients with no env block', () => {
    deleteClientEnvSecrets(SCOPE, {
      name: 'remote',
      transport: 'sse',
      url: 'https://x.example/mcp',
    });
    // Nothing thrown, nothing deleted.
    expect(memoryStore.size).toBe(0);
  });
});

/**
 * Les secrets étaient rangés sous le seul nom du client, dans un magasin commun à toute l'app :
 * deux projets avec un client `europeana` partageaient leur clé, et supprimer le client dans l'un
 * effaçait celle de l'autre (S09-1-6). Chaque projet a désormais sa portée (`secrets_scope`).
 */
describe('une portée par projet (S09-1-6)', () => {
  const europeana = (key: string): MCPClientConfig => ({
    name: 'europeana',
    transport: 'stdio',
    command: 'europeana-mcp',
    env: { EUROPEANA_API_KEY: key },
  });

  it('deux portées, même client, deux clés : chacune retrouve la sienne', () => {
    const a = europeana('cle-test-A');
    const b = europeana('cle-test-B');
    migrateClientEnvSecrets(SCOPE, a);
    migrateClientEnvSecrets(OTHER_SCOPE, b);

    expect(resolveClientEnvSecrets(SCOPE, 'europeana', a.env)).toEqual({ EUROPEANA_API_KEY: 'cle-test-A' });
    expect(resolveClientEnvSecrets(OTHER_SCOPE, 'europeana', b.env)).toEqual({ EUROPEANA_API_KEY: 'cle-test-B' });
  });

  it('supprimer le client dans une portée ne touche pas l’autre', () => {
    const a = europeana('cle-test-A');
    const b = europeana('cle-test-B');
    migrateClientEnvSecrets(SCOPE, a);
    migrateClientEnvSecrets(OTHER_SCOPE, b);

    deleteClientEnvSecrets(OTHER_SCOPE, b);

    expect(resolveClientEnvSecrets(SCOPE, 'europeana', a.env)).toEqual({ EUROPEANA_API_KEY: 'cle-test-A' });
    expect(resolveClientEnvSecrets(OTHER_SCOPE, 'europeana', b.env)).toEqual({});
  });

  it('ancienne clé globale : résolue, recopiée sous la portée, jamais supprimée', () => {
    memoryStore.set(legacySecretKeyFor('europeana', 'EUROPEANA_API_KEY'), 'cle-test-A');

    const out = resolveClientEnvSecrets(SCOPE, 'europeana', { EUROPEANA_API_KEY: SECRET_SENTINEL });

    expect(out).toEqual({ EUROPEANA_API_KEY: 'cle-test-A' });
    expect(memoryStore.get(secretKeyFor(SCOPE, 'europeana', 'EUROPEANA_API_KEY'))).toBe('cle-test-A');
    // Un autre projet, pas encore rouvert, en dépend peut-être encore.
    expect(memoryStore.get(legacySecretKeyFor('europeana', 'EUROPEANA_API_KEY'))).toBe('cle-test-A');

    // Supprimer le client dans ce projet efface la copie, pas l'ancienne clé.
    deleteClientEnvSecrets(SCOPE, { ...europeana(SECRET_SENTINEL) });
    expect(memoryStore.has(secretKeyFor(SCOPE, 'europeana', 'EUROPEANA_API_KEY'))).toBe(false);
    expect(memoryStore.get(legacySecretKeyFor('europeana', 'EUROPEANA_API_KEY'))).toBe('cle-test-A');
  });

  it('la clé de la portée l’emporte sur l’ancienne clé globale', () => {
    memoryStore.set(legacySecretKeyFor('europeana', 'EUROPEANA_API_KEY'), 'cle-test-B');
    memoryStore.set(secretKeyFor(SCOPE, 'europeana', 'EUROPEANA_API_KEY'), 'cle-test-A');

    expect(resolveClientEnvSecrets(SCOPE, 'europeana', { EUROPEANA_API_KEY: SECRET_SENTINEL })).toEqual({
      EUROPEANA_API_KEY: 'cle-test-A',
    });
  });

  it('sans portée (config.json qui n’a pas pu s’écrire) : l’ancienne clé sert toujours, rien n’est recopié', () => {
    memoryStore.set(legacySecretKeyFor('europeana', 'EUROPEANA_API_KEY'), 'cle-test-A');

    expect(resolveClientEnvSecrets(null, 'europeana', { EUROPEANA_API_KEY: SECRET_SENTINEL })).toEqual({
      EUROPEANA_API_KEY: 'cle-test-A',
    });
    expect([...memoryStore.keys()]).toEqual([legacySecretKeyFor('europeana', 'EUROPEANA_API_KEY')]);
  });

  it('la recopie qui échoue ne prive pas le serveur de sa clé', async () => {
    memoryStore.set(legacySecretKeyFor('europeana', 'EUROPEANA_API_KEY'), 'cle-test-A');
    const { secureStorage } = await import('../secure-storage.js');
    const setKey = vi.spyOn(secureStorage, 'setKey').mockImplementation(() => {
      throw new Error('EACCES');
    });
    try {
      expect(resolveClientEnvSecrets(SCOPE, 'europeana', { EUROPEANA_API_KEY: SECRET_SENTINEL })).toEqual({
        EUROPEANA_API_KEY: 'cle-test-A',
      });
    } finally {
      setKey.mockRestore();
    }
  });

  it('la clé de stockage porte la portée, et jamais sous le préfixe d’avant', () => {
    expect(secretKeyFor(SCOPE, 'europeana', 'EUROPEANA_API_KEY')).toBe(
      `mcp.project.${SCOPE}.client.europeana.env.EUROPEANA_API_KEY`
    );
    expect(legacySecretKeyFor('europeana', 'EUROPEANA_API_KEY')).toBe('mcp.client.europeana.env.EUROPEANA_API_KEY');
  });
});

describe('secretsScopeOf / ensureSecretsScope', () => {
  const cfg = (extra: Record<string, unknown> = {}): WorkspaceConfig => ({ schema_version: 2, ...extra });

  it('crée une portée une fois, puis la garde', () => {
    const c = cfg();
    expect(secretsScopeOf(c)).toBeNull();
    const scope = ensureSecretsScope(c);
    expect(scope).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(c.secrets_scope).toBe(scope);
    expect(ensureSecretsScope(c)).toBe(scope);
    expect(secretsScopeOf(c)).toBe(scope);
  });

  it.each([
    ['vide', ''],
    ['un nombre', 42],
    ['un chemin de clé', 'x.client.europeana'],
    ['un objet', { a: 1 }],
  ])('une portée qui n’en est pas une (%s) est ignorée, puis remplacée', (_label, value) => {
    const c = cfg({ secrets_scope: value });
    expect(secretsScopeOf(c)).toBeNull();
    const scope = ensureSecretsScope(c);
    expect(scope).not.toBe(value);
    expect(secretsScopeOf(c)).toBe(scope);
  });
});
