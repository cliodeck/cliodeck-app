/**
 * La garde de D18 : quel chemin de `.cliodeck` mène hors du projet. Ses deux formes, asynchrone
 * (ouverture, configuration) et synchrone (ouverture d'une base), rendent le même verdict.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { workspaceLinkOutside, workspaceLinkOutsideSync } from '../link-guard.js';
import { symlinkAvailable } from '../../../__tests__/helpers/native-guards.js';

let workDir: string;
let root: string;
let outside: string;

const both = async (): Promise<[string | null, string | null]> => [
  await workspaceLinkOutside(root),
  workspaceLinkOutsideSync(root),
];

beforeEach(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), 'cliodeck-garde-lien-'));
  root = path.join(workDir, 'Thèse');
  outside = path.join(workDir, 'ailleurs');
  mkdirSync(root);
  mkdirSync(outside);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('workspaceLinkOutside', () => {
  it('pas de .cliodeck, ou un vrai dossier : rien à refuser', async () => {
    expect(await both()).toEqual([null, null]);
    mkdirSync(path.join(root, '.cliodeck'));
    writeFileSync(path.join(root, '.cliodeck', 'brain.db'), '');
    expect(await both()).toEqual([null, null]);
  });

  it.skipIf(!symlinkAvailable)('.cliodeck lié dehors : c’est lui qui est nommé, pas ses fichiers', async () => {
    writeFileSync(path.join(outside, 'brain.db'), '');
    const link = path.join(root, '.cliodeck');
    symlinkSync(outside, link);
    expect(await both()).toEqual([link, link]);
  });

  it.skipIf(!symlinkAvailable)('un lien qui reste dans le projet passe', async () => {
    mkdirSync(path.join(root, 'donnees'));
    writeFileSync(path.join(root, 'donnees', 'brain.db'), '');
    mkdirSync(path.join(root, '.cliodeck'));
    symlinkSync(path.join(root, 'donnees', 'brain.db'), path.join(root, '.cliodeck', 'brain.db'));
    expect(await both()).toEqual([null, null]);
  });

  it.skipIf(!symlinkAvailable)('une racine ouverte par un lien ne refuse rien à tort', async () => {
    mkdirSync(path.join(root, '.cliodeck'));
    const alias = path.join(workDir, 'alias');
    symlinkSync(root, alias);
    expect([await workspaceLinkOutside(alias), workspaceLinkOutsideSync(alias)]).toEqual([null, null]);
  });

  it.skipIf(!symlinkAvailable)('une boucle de liens compte comme dehors (limite assumée)', async () => {
    mkdirSync(path.join(root, '.cliodeck'));
    const a = path.join(root, '.cliodeck', 'brain.db');
    const b = path.join(root, '.cliodeck', 'boucle');
    symlinkSync(b, a);
    symlinkSync(a, b);
    expect(await both()).toEqual([a, a]);
  });

  it.skipIf(!symlinkAvailable)('un lien cassé dehors est refusé, un lien cassé dedans laissé à config.ts', async () => {
    mkdirSync(path.join(root, '.cliodeck'));
    const config = path.join(root, '.cliodeck', 'config.json');
    symlinkSync(path.join(root, 'volume-absent', 'config.json'), config);
    expect(await both()).toEqual([null, null]);
    const journal = path.join(root, '.cliodeck', 'journal.db');
    symlinkSync(path.join(outside, 'absent', 'journal.db'), journal);
    expect(await both()).toEqual([journal, journal]);
  });
});
