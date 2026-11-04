/**
 * `config.json` porte le coffre Obsidian, les serveurs MCP et le mode de sécurité du projet.
 * Illisible n'est pas absent : une virgule en trop ou un projet ouvert par une version plus
 * récente le faisait remplacer en silence par une configuration vide (S11-1-8).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { mkdtemp, readdir, rm, symlink } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  readOrInitWorkspaceConfig,
  readWorkspaceConfig,
  updateWorkspaceConfig,
  workspaceConfigIssue,
  writeWorkspaceConfig,
  WorkspaceConfigError,
} from '../config.js';
import { symlinkAvailable } from '../../../__tests__/helpers/native-guards.js';

const IS_ROOT = process.getuid?.() === 0;
const BOM = '﻿';

let root: string;
let configFile: string;

const REALISTIC = {
  schema_version: 2,
  name: 'Thèse',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  vault: { path: '/Volumes/Notes/Obsidian' },
  mcpClients: [{ name: 'europeana', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-europeana'] }],
  mcpServer: { enabled: true, serverName: 'these' },
  security: { sourceInspectorMode: 'block' },
  champ_de_demain: { garde: 'moi' },
};

const writeConfig = (content: string | Buffer) => writeFileSync(configFile, content);
const bytes = () => readFileSync(configFile);

async function kindOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof WorkspaceConfigError) return error.kind;
    throw error;
  }
  return 'aucune erreur';
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'cliodeck-config-'));
  mkdirSync(path.join(root, '.cliodeck'), { recursive: true });
  configFile = path.join(root, '.cliodeck', 'config.json');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('un config.json illisible n’est jamais réécrit', () => {
  const trailingComma = '{\n  "schema_version": 2,\n  "vault": { "path": "/Notes" },\n}\n';

  it.each<[string, string, string]>([
    ['virgule en trop', trailingComma, 'invalid_json'],
    ['tronqué', '{"schema_version": 2, "vault": {"pa', 'invalid_json'],
    ['un tableau', '[]', 'invalid_json'],
    ['null', 'null', 'invalid_json'],
    ['un nombre', '42', 'invalid_json'],
    ['un texte', '"config"', 'invalid_json'],
    ['schema_version qui n’est pas un nombre', '{"schema_version":"abc","vault":{"path":"/Notes"}}', 'invalid_json'],
    ['schema_version objet', '{"schema_version":{"major":2},"vault":{"path":"/Notes"}}', 'invalid_json'],
    ['schema_version 3', '{"schema_version":3,"vault":{"path":"/Notes"}}', 'newer_schema'],
    ['schema_version "3" en texte', '{"schema_version":"3","vault":{"path":"/Notes"}}', 'newer_schema'],
  ])('%s : read, readOrInit et update lèvent, et le fichier reste identique à l’octet', async (_label, content, kind) => {
    writeConfig(content);
    const before = bytes();

    expect(await kindOf(() => readWorkspaceConfig(root))).toBe(kind);
    expect(await kindOf(() => readOrInitWorkspaceConfig(root))).toBe(kind);
    let called = false;
    expect(
      await kindOf(() =>
        updateWorkspaceConfig(root, () => {
          called = true;
        })
      )
    ).toBe(kind);

    expect(called).toBe(false);
    expect(bytes().equals(before)).toBe(true);
    expect(await workspaceConfigIssue(root)).toEqual({ kind, path: configFile });
  });

  it('un message qui nomme le fichier et dit que rien n’a changé, sans le code', async () => {
    writeConfig(trailingComma);
    const error = await readWorkspaceConfig(root).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceConfigError);
    const { message, filePath } = error as WorkspaceConfigError;
    expect(filePath).toBe(configFile);
    expect(message).toContain('.cliodeck/config.json');
    expect(message).toContain("n'a pas été modifié");
    expect(message).not.toContain('invalid_json');
  });

  it('newer_schema : le message demande de mettre ClioDeck à jour, pas de corriger le fichier', async () => {
    writeConfig('{"schema_version":3}');
    const error = (await readWorkspaceConfig(root).catch((e: unknown) => e)) as WorkspaceConfigError;
    expect(error.message).toContain('Mettez ClioDeck à jour');
    expect(error.message).not.toContain('Corrigez');
  });

  it('pas en UTF-8 : illisible, intact', async () => {
    writeConfig(Buffer.from([0x7b, 0x22, 0xc9, 0x22, 0x3a, 0x31, 0x7d]));
    const before = bytes();
    expect(await kindOf(() => readOrInitWorkspaceConfig(root))).toBe('unreadable');
    expect(bytes().equals(before)).toBe(true);
  });

  it('un dossier à la place du fichier : illisible, jamais « absent »', async () => {
    mkdirSync(configFile);
    expect(await kindOf(() => readOrInitWorkspaceConfig(root))).toBe('unreadable');
    expect(await readdir(configFile)).toEqual([]);
  });

  it.skipIf(IS_ROOT)('droits de lecture retirés : illisible, intact', async () => {
    writeConfig(JSON.stringify(REALISTIC));
    const before = bytes();
    chmodSync(configFile, 0o000);
    try {
      expect(await kindOf(() => readOrInitWorkspaceConfig(root))).toBe('unreadable');
      expect(await kindOf(() => updateWorkspaceConfig(root, () => undefined))).toBe('unreadable');
    } finally {
      chmodSync(configFile, 0o644);
    }
    expect(bytes().equals(before)).toBe(true);
  });
});

describe('absent n’est pas pris au mot : on regarde plus haut', () => {
  /** Un projet dans un dossier parent qu'on peut renommer sous ses pieds. */
  function renamedParent(): { parent: string; parked: string; project: string } {
    const parent = path.join(root, 'parent');
    const project = path.join(parent, 'Thèse');
    mkdirSync(path.join(project, '.cliodeck'), { recursive: true });
    writeFileSync(path.join(project, 'document.md'), '# Thèse\n');
    writeFileSync(path.join(project, '.cliodeck', 'config.json'), JSON.stringify(REALISTIC));
    const parked = `${parent}-debranche`;
    renameSync(parent, parked);
    return { parent, parked, project };
  }

  it('dossier parent renommé : tout lève, rien n’est recréé, et le dossier reprend son nom', async () => {
    const { parent, parked, project } = renamedParent();
    let called = false;

    expect(await kindOf(() => readWorkspaceConfig(project))).toBe('unreadable');
    expect(await kindOf(() => readOrInitWorkspaceConfig(project))).toBe('unreadable');
    expect(
      await kindOf(() =>
        updateWorkspaceConfig(project, () => {
          called = true;
        })
      )
    ).toBe('unreadable');
    expect(await workspaceConfigIssue(project)).toEqual({
      kind: 'unreadable',
      path: path.join(project, '.cliodeck', 'config.json'),
    });

    expect(called).toBe(false);
    expect(existsSync(parent)).toBe(false);
    // Un squelette recréé là ferait échouer ce renommage (ENOTEMPTY).
    renameSync(parked, parent);
    expect((await readWorkspaceConfig(project)).vault).toEqual(REALISTIC.vault);
  });

  it('le message nomme le dossier disparu, pour un historien', async () => {
    const { project } = renamedParent();
    const error = (await readOrInitWorkspaceConfig(project).catch((e: unknown) => e)) as WorkspaceConfigError;
    expect(error).toBeInstanceOf(WorkspaceConfigError);
    expect(error.message).toContain('.cliodeck/config.json');
    expect(error.message).toContain("n'a pas été modifié");
    expect(error.message).toContain('dossier du projet est introuvable');
    expect(error.message).toContain(project);
  });

  it.skipIf(!symlinkAvailable)('config.json lien cassé, volume absent : illisible, rien d’écrit', async () => {
    const target = path.join(root, 'volume-absent', 'config.json');
    await symlink(target, configFile);
    let called = false;

    expect(await kindOf(() => readWorkspaceConfig(root))).toBe('unreadable');
    expect(await kindOf(() => readOrInitWorkspaceConfig(root))).toBe('unreadable');
    expect(
      await kindOf(() =>
        updateWorkspaceConfig(root, () => {
          called = true;
        })
      )
    ).toBe('unreadable');
    expect(await workspaceConfigIssue(root)).toEqual({ kind: 'unreadable', path: configFile });

    expect(called).toBe(false);
    expect(lstatSync(configFile).isSymbolicLink()).toBe(true);
    expect(existsSync(path.dirname(target))).toBe(false);
  });

  it.skipIf(!symlinkAvailable)('config.json lien cassé, dossier présent : aucun défaut à l’autre bout du lien', async () => {
    const target = path.join(root, 'autre-dossier', 'config.json');
    mkdirSync(path.dirname(target));
    await symlink(target, configFile);

    expect(await kindOf(() => readOrInitWorkspaceConfig(root))).toBe('unreadable');
    expect(await kindOf(() => updateWorkspaceConfig(root, () => undefined))).toBe('unreadable');

    expect(existsSync(target)).toBe(false);
  });

  it.skipIf(!symlinkAvailable)('.cliodeck lien cassé : illisible, le lien reste', async () => {
    await rm(path.join(root, '.cliodeck'), { recursive: true });
    await symlink(path.join(root, 'volume-absent'), path.join(root, '.cliodeck'));

    expect(await kindOf(() => readWorkspaceConfig(root))).toBe('unreadable');
    expect(await kindOf(() => readOrInitWorkspaceConfig(root))).toBe('unreadable');
    expect(await kindOf(() => updateWorkspaceConfig(root, () => undefined))).toBe('unreadable');
    expect(lstatSync(path.join(root, '.cliodeck')).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(root, 'volume-absent'))).toBe(false);
  });

  it('.cliodeck est un fichier (ENOTDIR) : illisible, intact', async () => {
    await rm(path.join(root, '.cliodeck'), { recursive: true });
    writeFileSync(path.join(root, '.cliodeck'), 'pas un dossier');

    expect(await kindOf(() => readWorkspaceConfig(root))).toBe('unreadable');
    expect(await kindOf(() => readOrInitWorkspaceConfig(root))).toBe('unreadable');
    expect(await kindOf(() => updateWorkspaceConfig(root, () => undefined))).toBe('unreadable');
    expect(readFileSync(path.join(root, '.cliodeck'), 'utf8')).toBe('pas un dossier');
  });

  it('lire un projet sain ne crée aucun dossier', async () => {
    writeConfig(JSON.stringify(REALISTIC));
    await readOrInitWorkspaceConfig(root);
    expect(await readdir(path.join(root, '.cliodeck'))).toEqual(['config.json']);
  });
});

describe('ce que le contrat accepte', () => {
  it.each<[string, Record<string, unknown>]>([
    ['schema_version 1', { schema_version: 1, vault: { path: '/Notes' }, mcpClients: [{ name: 'a' }], autre: true }],
    ['sans schema_version', { vault: { path: '/Notes' }, mcpClients: [{ name: 'a' }], autre: true }],
    ['schema_version "2" en texte', { schema_version: '2', vault: { path: '/Notes' }, mcpClients: [{ name: 'a' }], autre: true }],
  ])('%s : accepté, champs conservés, à la lecture comme à l’écriture', async (_label, stored) => {
    writeConfig(JSON.stringify(stored));
    const before = bytes();

    const cfg = await readOrInitWorkspaceConfig(root);
    expect(cfg.vault).toEqual({ path: '/Notes' });
    expect(cfg.mcpClients).toEqual([{ name: 'a' }]);
    expect(cfg.autre).toBe(true);
    // Lire ne réécrit rien.
    expect(bytes().equals(before)).toBe(true);

    await updateWorkspaceConfig(root, (current) => {
      current.mcpServer = { enabled: true };
    });
    const disk = JSON.parse(bytes().toString('utf8')) as Record<string, unknown>;
    expect(disk.schema_version).toBe(2);
    expect(disk.vault).toEqual({ path: '/Notes' });
    expect(disk.mcpClients).toEqual([{ name: 'a' }]);
    expect(disk.autre).toBe(true);
    expect(disk.mcpServer).toEqual({ enabled: true });
  });

  it('BOM en tête (un éditeur Windows) : lisible, et il reste à l’écriture', async () => {
    writeConfig(`${BOM}${JSON.stringify(REALISTIC, null, 2)}`);
    const before = bytes();

    const cfg = await readOrInitWorkspaceConfig(root);
    expect(cfg.vault).toEqual(REALISTIC.vault);
    expect(bytes().equals(before)).toBe(true);
    expect(await workspaceConfigIssue(root)).toBeNull();

    await updateWorkspaceConfig(root, (current) => {
      current.mcpServer = { enabled: false };
    });
    const after = bytes();
    expect(after.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
    expect(after.subarray(3, 6).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    const disk = JSON.parse(after.toString('utf8').slice(1)) as Record<string, unknown>;
    expect(disk.vault).toEqual(REALISTIC.vault);
    expect(disk.mcpServer).toEqual({ enabled: false });
  });

  it.each<[string, string]>([
    ['0 octet', ''],
    ['des blancs', '  \n\t\r\n '],
    ['un BOM seul', BOM],
  ])('%s : comme absent, il ne porte rien à préserver', async (_label, content) => {
    writeConfig(content);

    expect(await kindOf(() => readWorkspaceConfig(root))).toBe('absent');
    expect(await workspaceConfigIssue(root)).toBeNull();
    const cfg = await readOrInitWorkspaceConfig(root);
    expect(cfg.schema_version).toBe(2);
    expect(cfg.name).toBe(path.basename(root));
    expect(JSON.parse(bytes().toString('utf8')).schema_version).toBe(2);
  });

  it('fichier vide puis update : part des valeurs par défaut, et le changement est écrit', async () => {
    writeConfig('');
    await updateWorkspaceConfig(root, (current) => {
      current.vault = { path: '/Notes' };
    });
    const disk = JSON.parse(bytes().toString('utf8')) as Record<string, unknown>;
    expect(disk.schema_version).toBe(2);
    expect(disk.name).toBe(path.basename(root));
    expect(disk.vault).toEqual({ path: '/Notes' });
  });
});

describe('fichier absent', () => {
  it('readWorkspaceConfig lève `absent`, sans rien créer', async () => {
    expect(await kindOf(() => readWorkspaceConfig(root))).toBe('absent');
    expect(existsSync(configFile)).toBe(false);
    expect(await workspaceConfigIssue(root)).toBeNull();
  });

  it('readOrInit crée le fichier et le dossier, au nom demandé ou à celui du projet', async () => {
    await rm(path.join(root, '.cliodeck'), { recursive: true });
    const cfg = await readOrInitWorkspaceConfig(root, 'Ma thèse');
    expect(cfg.name).toBe('Ma thèse');
    expect(JSON.parse(bytes().toString('utf8')).name).toBe('Ma thèse');
  });

  it('update crée le fichier, et rien si le mutateur rend `false`', async () => {
    const untouched = await updateWorkspaceConfig(root, () => false);
    expect(untouched.schema_version).toBe(2);
    expect(existsSync(configFile)).toBe(false);

    await updateWorkspaceConfig(root, (current) => {
      current.vault = { path: '/Notes' };
    });
    expect(JSON.parse(bytes().toString('utf8')).vault).toEqual({ path: '/Notes' });
  });
});

describe('écriture', () => {
  it('même format d’octets, champs inconnus conservés, seul updated_at bouge', async () => {
    writeConfig(JSON.stringify(REALISTIC, null, 2));
    await updateWorkspaceConfig(root, () => undefined);
    const text = bytes().toString('utf8');
    expect(text.endsWith('}')).toBe(true);
    const disk = JSON.parse(text) as Record<string, unknown>;
    expect(disk.updated_at).not.toBe(REALISTIC.updated_at);
    expect(text).toBe(JSON.stringify({ ...REALISTIC, updated_at: disk.updated_at }, null, 2));
  });

  it('mutateur qui rend `false` : aucune écriture, le fichier reste identique', async () => {
    writeConfig(JSON.stringify(REALISTIC));
    const before = bytes();
    const cfg = await updateWorkspaceConfig(root, () => false);
    expect(cfg.vault).toEqual(REALISTIC.vault);
    expect(bytes().equals(before)).toBe(true);
  });

  it('mutateur qui lève : rejet, rien d’écrit', async () => {
    writeConfig(JSON.stringify(REALISTIC));
    const before = bytes();
    await expect(
      updateWorkspaceConfig(root, () => {
        throw new Error('doublon');
      })
    ).rejects.toThrow('doublon');
    expect(bytes().equals(before)).toBe(true);
  });

  it('30 mises à jour concurrentes : aucune ne perd celle d’à côté', async () => {
    writeConfig(JSON.stringify(REALISTIC));
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        updateWorkspaceConfig(root, (current) => {
          current[`cle${i}`] = i;
        })
      )
    );
    const disk = JSON.parse(bytes().toString('utf8')) as Record<string, unknown>;
    for (let i = 0; i < 30; i += 1) expect(disk[`cle${i}`]).toBe(i);
    expect(disk.vault).toEqual(REALISTIC.vault);
  });

  it('une lecture demandée après une écriture lit ce que celle-ci a écrit', async () => {
    writeConfig(JSON.stringify(REALISTIC));
    const writing = updateWorkspaceConfig(root, async (current) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      current.vault = { path: '/Ailleurs' };
    });
    const read = await readWorkspaceConfig(root);
    await writing;
    expect(read.vault).toEqual({ path: '/Ailleurs' });
  });

  it('writeWorkspaceConfig ne laisse aucun temporaire, et ses écritures concurrentes restent du JSON', async () => {
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => writeWorkspaceConfig(root, { schema_version: 2, name: `n${i}` }))
    );
    expect(JSON.parse(bytes().toString('utf8')).schema_version).toBe(2);
    expect((await readdir(path.join(root, '.cliodeck'))).sort()).toEqual(['config.json']);
  });

  it.skipIf(!symlinkAvailable)('config.json lien symbolique : le lien reste, sa cible reçoit le texte', async () => {
    const target = path.join(root, 'cible.json');
    writeFileSync(target, JSON.stringify(REALISTIC));
    await symlink(target, configFile);

    await updateWorkspaceConfig(root, (current) => {
      current.vault = { path: '/Ailleurs' };
    });

    expect(lstatSync(configFile).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, 'utf8')).vault).toEqual({ path: '/Ailleurs' });
  });
});
