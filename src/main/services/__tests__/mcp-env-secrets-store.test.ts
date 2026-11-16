/**
 * Les secrets des serveurs MCP dans le vrai magasin (`electron-store`, dossier temporaire) : seul
 * `safeStorage` est simulé. Le magasin lit les clés comme des chemins à points, si bien que
 * `mcp.project.<portée>.client.<nom>.env.<VAR>` y devient un objet imbriqué : ces tests vérifient
 * que la portée par projet (S09-1-6) s'y range, s'y relit, et que « Révoquer toutes les clés »
 * l'efface comme le reste, plutôt que de le supposer.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

// Le dossier de l'app : un dossier temporaire, posé avant `init`. Jamais celui de l'auteur.
const place = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron', () => {
  const app = { getPath: () => place.dir, getVersion: () => '0.0.0' };
  const ipcMain = { on: () => undefined };
  // Chiffrement factice mais réversible, comme dans secure-storage.test.ts. Un chiffré qui n'est
  // pas le sien (`v10…`, écrit par l'autre identité de l'app) est refusé, comme par Chromium.
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b: Buffer) => {
      const s = b.toString('utf8');
      if (!s.startsWith('enc:')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      return s.slice(4);
    },
  };
  return { default: { app, ipcMain, safeStorage }, app, ipcMain, safeStorage };
});

place.dir = mkdtempSync(path.join(os.tmpdir(), 'cliodeck-secrets-'));

const { secureStorage } = await import('../secure-storage.js');
const { SECRET_SENTINEL, deleteClientEnvSecrets, legacySecretKeyFor, migrateClientEnvSecrets, resolveClientEnvSecrets, secretKeyFor } =
  await import('../mcp-env-secrets.js');

const SCOPE_A = '0b9f4c1e-6a51-4d1c-9a43-2f0d8f6c7e11';
const SCOPE_B = '7d3a2b90-1c4e-4f8a-b6d2-93e5a0c4f1aa';
const storeFile = path.join(place.dir, 'cliodeck-secrets.json');
const onDisk = (): Record<string, unknown> => JSON.parse(readFileSync(storeFile, 'utf8')) as Record<string, unknown>;

afterAll(() => {
  rmSync(place.dir, { recursive: true, force: true });
});

describe('secrets MCP dans le vrai magasin', () => {
  it('deux portées, une ancienne clé, une clé de fournisseur : chacune à sa place, puis toutes révoquées', async () => {
    await secureStorage.init();
    secureStorage.setKey('llm.claudeAPIKey', 'cle-test-fournisseur');
    secureStorage.setKey(legacySecretKeyFor('europeana', 'EUROPEANA_API_KEY'), 'cle-test-ancienne');
    const a = { name: 'europeana', transport: 'stdio' as const, command: 'x', env: { EUROPEANA_API_KEY: 'cle-test-A' } };
    const b = { name: 'europeana', transport: 'stdio' as const, command: 'x', env: { EUROPEANA_API_KEY: 'cle-test-B' } };
    migrateClientEnvSecrets(SCOPE_A, a);
    migrateClientEnvSecrets(SCOPE_B, b);

    expect(resolveClientEnvSecrets(SCOPE_A, 'europeana', a.env)).toEqual({ EUROPEANA_API_KEY: 'cle-test-A' });
    expect(resolveClientEnvSecrets(SCOPE_B, 'europeana', b.env)).toEqual({ EUROPEANA_API_KEY: 'cle-test-B' });
    // Rien en clair sur le disque.
    expect(readFileSync(storeFile, 'utf8')).not.toContain('cle-test-');

    // Supprimer dans B laisse A, l'ancienne clé et la clé du fournisseur.
    deleteClientEnvSecrets(SCOPE_B, b);
    expect(secureStorage.getKey(secretKeyFor(SCOPE_B, 'europeana', 'EUROPEANA_API_KEY'))).toBe('');
    expect(secureStorage.getKey(secretKeyFor(SCOPE_A, 'europeana', 'EUROPEANA_API_KEY'))).toBe('cle-test-A');
    expect(secureStorage.getKey(legacySecretKeyFor('europeana', 'EUROPEANA_API_KEY'))).toBe('cle-test-ancienne');
    expect(secureStorage.getKey('llm.claudeAPIKey')).toBe('cle-test-fournisseur');

    // Une troisième portée, sans clé à elle : l'ancienne est recopiée sous elle.
    const scopeC = '11111111-2222-4333-8444-555555555555';
    expect(resolveClientEnvSecrets(scopeC, 'europeana', { EUROPEANA_API_KEY: SECRET_SENTINEL })).toEqual({
      EUROPEANA_API_KEY: 'cle-test-ancienne',
    });
    expect(secureStorage.getKey(secretKeyFor(scopeC, 'europeana', 'EUROPEANA_API_KEY'))).toBe('cle-test-ancienne');

    // Les chemins à points sont imbriqués : au premier niveau, deux entrées, que la révocation efface.
    expect(Object.keys(onDisk()).sort()).toEqual(['llm', 'mcp']);
    expect(Object.keys((onDisk().mcp as Record<string, unknown>)).sort()).toEqual(['client', 'project']);

    secureStorage.revokeAll();

    expect(onDisk()).toEqual({});
    for (const key of [
      secretKeyFor(SCOPE_A, 'europeana', 'EUROPEANA_API_KEY'),
      secretKeyFor(scopeC, 'europeana', 'EUROPEANA_API_KEY'),
      legacySecretKeyFor('europeana', 'EUROPEANA_API_KEY'),
      'llm.claudeAPIKey',
    ]) {
      expect(secureStorage.getKey(key)).toBe('');
    }
  });

  it('clé du projet présente mais illisible à ce lancement : ni remplacée par l’ancienne clé, ni servie à sa place', async () => {
    await secureStorage.init();
    // La clé du projet, chiffrée par l'autre identité de l'app (app empaquetée contre `npx electron .`),
    // et une ancienne clé globale lisible ici, écrite pour un autre projet.
    const own = Buffer.from('v10cle-propre-A', 'latin1').toString('base64');
    const legacy = Buffer.from('enc:cle-ancienne-B', 'utf8').toString('base64');
    writeFileSync(
      storeFile,
      JSON.stringify({
        mcp: {
          project: { [SCOPE_A]: { client: { europeana: { env: { EUROPEANA_API_KEY: own } } } } },
          client: { europeana: { env: { EUROPEANA_API_KEY: legacy } } },
        },
      })
    );
    const before = readFileSync(storeFile);

    // Comme une clé illisible d'avant la portée : absente pour ce lancement, et rien d'effacé.
    expect(resolveClientEnvSecrets(SCOPE_A, 'europeana', { EUROPEANA_API_KEY: SECRET_SENTINEL, LANG: 'fr' })).toEqual({
      LANG: 'fr',
    });
    expect(readFileSync(storeFile).equals(before)).toBe(true);
    expect(secureStorage.unreadableKeys()).toContain(secretKeyFor(SCOPE_A, 'europeana', 'EUROPEANA_API_KEY'));

    // Une portée sans clé à elle reçoit toujours l'ancienne : seul le cas d'une clé présente change.
    expect(resolveClientEnvSecrets(SCOPE_B, 'europeana', { EUROPEANA_API_KEY: SECRET_SENTINEL })).toEqual({
      EUROPEANA_API_KEY: 'cle-ancienne-B',
    });

    secureStorage.revokeAll();
  });
});
