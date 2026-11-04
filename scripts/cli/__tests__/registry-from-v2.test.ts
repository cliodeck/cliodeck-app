/**
 * La CLI lit `config.json` sans jamais l'écrire. Le nouveau type d'erreur remonte tel quel, avec
 * son message, et un schéma inférieur s'accepte désormais comme dans l'app.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { buildRegistryFromWorkspace } from '../registry-from-v2.js';

let root: string;
let configFile: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'cliodeck-cli-'));
  mkdirSync(path.join(root, '.cliodeck'), { recursive: true });
  configFile = path.join(root, '.cliodeck', 'config.json');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('buildRegistryFromWorkspace', () => {
  it.each<[string, string, string]>([
    ['virgule en trop', '{"schema_version":2,}', 'invalid_json'],
    ['format plus récent', '{"schema_version":3}', 'newer_schema'],
  ])('%s : rejette avec le bon motif, fichier intact', async (_label, content, kind) => {
    writeFileSync(configFile, content);
    await expect(buildRegistryFromWorkspace(root)).rejects.toMatchObject({ kind });
    expect(readFileSync(configFile, 'utf8')).toBe(content);
  });

  it('schéma inférieur : accepté', async () => {
    writeFileSync(configFile, '{"schema_version":1}');
    const registry = await buildRegistryFromWorkspace(root);
    expect(registry).toBeTruthy();
    await registry.dispose();
    expect(readFileSync(configFile, 'utf8')).toBe('{"schema_version":1}');
  });
});
