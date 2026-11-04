import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {
  detectWorkspaceVersion,
  workspaceFiles,
  CLIODECK_DIR,
  CLIOBRAIN_DIR,
  LEGACY_V2_SUBDIR,
} from '../layout.js';
import { migrateWorkspaceToFlat, type MigrationReport } from '../migrator.js';
import { readWorkspaceConfig } from '../config.js';
import { loadWorkspaceHints } from '../../hints/loader.js';
import { sqliteAvailable, symlinkAvailable } from '../../../__tests__/helpers/native-guards.js';

let tmpRoot = '';

async function makeTmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cliodeck-ws-'));
}

async function write(p: string, content = 'x'): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf8');
}

/**
 * Écrit une VRAIE base SQLite minimale, marquée pour être reconnaissable
 * après migration.
 *
 * Les fixtures écrivaient auparavant un fichier texte nommé `history.db` :
 * le migrateur l'ouvrait pour de bon et échouait sur « file is not a
 * database ». Ces quatre tests dormaient rouges derrière les gardes ABI.
 */
async function writeDb(p: string, marker: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const db = new Database(p);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS fixture_marker (tag TEXT)');
    db.prepare('INSERT INTO fixture_marker (tag) VALUES (?)').run(marker);
  } finally {
    db.close();
  }
}

/** Relit le marqueur d'une base de fixture. */
function readDbMarker(p: string): string | null {
  const db = new Database(p, { readonly: true });
  try {
    const row = db.prepare('SELECT tag FROM fixture_marker LIMIT 1').get() as
      | { tag: string }
      | undefined;
    return row?.tag ?? null;
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  tmpRoot = await makeTmp();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('detectWorkspaceVersion', () => {
  it('none for empty dir', async () => {
    expect(await detectWorkspaceVersion(tmpRoot)).toBe('none');
  });

  it('flat when .cliodeck/config.json exists', async () => {
    await write(
      path.join(tmpRoot, CLIODECK_DIR, 'config.json'),
      '{"schema_version":2}',
    );
    expect(await detectWorkspaceVersion(tmpRoot)).toBe('flat');
  });

  it('legacy-subdir when only .cliodeck/v2/config.json exists', async () => {
    await write(
      path.join(tmpRoot, CLIODECK_DIR, LEGACY_V2_SUBDIR, 'config.json'),
      '{"schema_version":2}',
    );
    expect(await detectWorkspaceVersion(tmpRoot)).toBe('legacy-subdir');
  });

  it('legacy-flat when .cliodeck/ exists with no config anywhere', async () => {
    await write(path.join(tmpRoot, CLIODECK_DIR, 'hnsw.index'));
    expect(await detectWorkspaceVersion(tmpRoot)).toBe('legacy-flat');
  });

  it('cliobrain when only .cliobrain/ exists', async () => {
    await write(path.join(tmpRoot, CLIOBRAIN_DIR, 'brain.db'));
    expect(await detectWorkspaceVersion(tmpRoot)).toBe('cliobrain');
  });

  it('flat wins over legacy-subdir when both have a config.json', async () => {
    await write(path.join(tmpRoot, CLIODECK_DIR, 'config.json'), '{"schema_version":2}');
    await write(
      path.join(tmpRoot, CLIODECK_DIR, LEGACY_V2_SUBDIR, 'config.json'),
      '{"schema_version":2}',
    );
    expect(await detectWorkspaceVersion(tmpRoot)).toBe('flat');
  });
});

describe('migrateWorkspaceToFlat — none / flat', () => {
  it('no-op on empty workspace', async () => {
    const r = await migrateWorkspaceToFlat(tmpRoot);
    expect(r.kind).toBe('none');
    expect(r.noop).toBeDefined();
  });

  it('no-op when already flat and nothing to consolidate', async () => {
    await write(
      path.join(tmpRoot, CLIODECK_DIR, 'config.json'),
      '{"schema_version":2}',
    );
    const r = await migrateWorkspaceToFlat(tmpRoot);
    expect(r.kind).toBe('none');
    expect(r.noop).toMatch(/already at flat/);
  });
});

describe('migrateWorkspaceToFlat — un config.json illisible n’est pas remplacé', () => {
  it.each<[string, string]>([
    ['virgule en trop', '{"schema_version":2,"vault":{"path":"/Notes"},}'],
    ['format plus récent', '{"schema_version":3,"vault":{"path":"/Notes"}}'],
    ['un tableau', '[]'],
  ])('%s : à plat, sans demande explicite, identique à l’octet', async (_label, content) => {
    const config = path.join(tmpRoot, CLIODECK_DIR, 'config.json');
    await write(config, content);

    const report = await migrateWorkspaceToFlat(tmpRoot);

    expect(report.copied).toEqual([]);
    expect(await fs.readFile(config, 'utf8')).toBe(content);
  });

  it('--overwrite, la demande explicite : remplacé', async () => {
    const config = path.join(tmpRoot, CLIODECK_DIR, 'config.json');
    await write(config, '{"schema_version":2,}');

    await migrateWorkspaceToFlat(tmpRoot, { overwrite: true });

    expect(JSON.parse(await fs.readFile(config, 'utf8')).schema_version).toBe(2);
  });

  it('ancien sous-dossier v2 au config.json illisible : déplacé tel quel, jamais reformaté', async () => {
    const legacy = path.join(tmpRoot, CLIODECK_DIR, LEGACY_V2_SUBDIR, 'config.json');
    await write(legacy, '{"schema_version":2,}');

    await migrateWorkspaceToFlat(tmpRoot);

    expect(await fs.readFile(path.join(tmpRoot, CLIODECK_DIR, 'config.json'), 'utf8')).toBe('{"schema_version":2,}');
  });

  it('config.json lien cassé : rien d’écrit à l’autre bout du lien, et le lien reste', async () => {
    const config = path.join(tmpRoot, CLIODECK_DIR, 'config.json');
    const target = path.join(tmpRoot, 'autre-dossier', 'config.json');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.mkdir(path.dirname(config), { recursive: true });
    await fs.symlink(target, config);

    const report = await migrateWorkspaceToFlat(tmpRoot);

    expect(report.copied).toEqual([]);
    expect((await fs.lstat(config)).isSymbolicLink()).toBe(true);
    await expect(fs.access(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('dossier sans config.json : le fichier généré est atomique, et lisible', async () => {
    await fs.mkdir(path.join(tmpRoot, CLIODECK_DIR), { recursive: true });
    await migrateWorkspaceToFlat(tmpRoot, { name: 'Thèse' });
    const cfg = await readWorkspaceConfig(tmpRoot);
    expect(cfg.name).toBe('Thèse');
    expect((await fs.readdir(path.join(tmpRoot, CLIODECK_DIR))).filter((n) => n.includes('.tmp'))).toEqual([]);
  });
});

describe('migrateWorkspaceToFlat — db consolidation (history → brain)', () => {
  // Fabrique une vraie base SQLite : exige le binding (cf. native-guards).
  it.skipIf(!sqliteAvailable)('renames history.db to brain.db on a flat workspace', async () => {
    await write(
      path.join(tmpRoot, CLIODECK_DIR, 'config.json'),
      '{"schema_version":2}',
    );
    await writeDb(path.join(tmpRoot, CLIODECK_DIR, 'history.db'), 'HISTORY');

    const r = await migrateWorkspaceToFlat(tmpRoot);
    expect(r.copied.some((c) => c.target.endsWith('brain.db'))).toBe(true);

    const flat = workspaceFiles(tmpRoot);
    expect(readDbMarker(flat.brainDb)).toBe('HISTORY');
    await expect(
      fs.access(path.join(tmpRoot, CLIODECK_DIR, 'history.db')),
    ).rejects.toThrow();
  });

  // Fabrique une vraie base SQLite : exige le binding (cf. native-guards).
  it.skipIf(!sqliteAvailable)('warns and skips when both history.db and brain.db exist', async () => {
    await write(
      path.join(tmpRoot, CLIODECK_DIR, 'config.json'),
      '{"schema_version":2}',
    );
    await writeDb(path.join(tmpRoot, CLIODECK_DIR, 'history.db'), 'HISTORY');
    await writeDb(path.join(tmpRoot, CLIODECK_DIR, 'brain.db'), 'BRAIN');

    const r = await migrateWorkspaceToFlat(tmpRoot);
    expect(r.warnings.some((w) => w.includes('both files exist'))).toBe(true);
    // Both files stay put — the user is the only authority on what to merge.
    expect(readDbMarker(path.join(tmpRoot, CLIODECK_DIR, 'history.db'))).toBe(
      'HISTORY',
    );
    expect(readDbMarker(path.join(tmpRoot, CLIODECK_DIR, 'brain.db'))).toBe(
      'BRAIN',
    );
  });

  // Fabrique une vraie base SQLite : exige le binding (cf. native-guards).
  it.skipIf(!sqliteAvailable)('runs consolidation alongside the legacy-subdir flatten in one pass', async () => {
    const v2 = path.join(tmpRoot, CLIODECK_DIR, LEGACY_V2_SUBDIR);
    await write(path.join(v2, 'config.json'), '{"schema_version":2}');
    // history.db lived flat in pre-fusion v1 — it never moved into v2/.
    await writeDb(path.join(tmpRoot, CLIODECK_DIR, 'history.db'), 'HIST');

    const r = await migrateWorkspaceToFlat(tmpRoot);
    expect(r.kind).toBe('legacy-subdir');
    const flat = workspaceFiles(tmpRoot);
    expect(readDbMarker(flat.brainDb)).toBe('HIST');
  });

  it('skips the obsidian/tropy/vectors consolidation steps when their files are absent', async () => {
    // The actual SQL paths (rename tables, ATTACH+copy) require better-sqlite3
    // native bindings, which fail under Vitest (CLAUDE.md §6). This test
    // covers only the no-op branches — the happy paths are validated at
    // runtime when the user opens a workspace.
    await write(
      path.join(tmpRoot, CLIODECK_DIR, 'config.json'),
      '{"schema_version":2}',
    );
    const r = await migrateWorkspaceToFlat(tmpRoot);
    expect(r.warnings).toHaveLength(0);
  });
});

describe('migrateWorkspaceToFlat — legacy-flat (pre-fusion v1)', () => {
  it('writes a fresh config and leaves v1 data in place', async () => {
    const v1Hnsw = path.join(tmpRoot, CLIODECK_DIR, 'hnsw.index');
    await write(v1Hnsw, 'ORIGINAL');

    const r = await migrateWorkspaceToFlat(tmpRoot, { name: 'my-corpus' });
    expect(r.kind).toBe('legacy-flat');
    expect(r.copied.some((c) => c.target.endsWith('config.json'))).toBe(true);

    const cfg = await readWorkspaceConfig(tmpRoot);
    expect(cfg.schema_version).toBe(2);
    expect(cfg.name).toBe('my-corpus');
    expect(await detectWorkspaceVersion(tmpRoot)).toBe('flat');

    expect(await fs.readFile(v1Hnsw, 'utf8')).toBe('ORIGINAL');
  });
});

describe('migrateWorkspaceToFlat — legacy-subdir (in-flight v2)', () => {
  it('moves every file in .cliodeck/v2/ up one level', async () => {
    const v2 = path.join(tmpRoot, CLIODECK_DIR, LEGACY_V2_SUBDIR);
    await write(path.join(v2, 'config.json'), '{"schema_version":2,"name":"hist"}');
    await write(path.join(v2, 'hints.md'), '# hints');
    await write(path.join(v2, 'mcp-access.jsonl'), '{"t":"hi"}\n');
    await write(path.join(v2, 'recipes', 'one.yaml'), 'name: one\n');

    const r = await migrateWorkspaceToFlat(tmpRoot);
    expect(r.kind).toBe('legacy-subdir');
    expect(r.copied.length).toBeGreaterThanOrEqual(4);

    const flat = workspaceFiles(tmpRoot);
    expect(await fs.readFile(flat.config, 'utf8')).toMatch(/"name":"hist"/);
    expect(await fs.readFile(flat.hints, 'utf8')).toBe('# hints');
    expect(
      await fs.readFile(path.join(flat.recipesDir, 'one.yaml'), 'utf8'),
    ).toBe('name: one\n');

    // The legacy subdir is gone.
    await expect(fs.access(v2)).rejects.toThrow();
    expect(await detectWorkspaceVersion(tmpRoot)).toBe('flat');
  });

  it('keeps the live flat hnsw.index on collision', async () => {
    const v2 = path.join(tmpRoot, CLIODECK_DIR, LEGACY_V2_SUBDIR);
    await write(path.join(tmpRoot, CLIODECK_DIR, 'hnsw.index'), 'LIVE');
    await write(path.join(v2, 'hnsw.index'), 'DEBRIS');
    await write(path.join(v2, 'config.json'), '{"schema_version":2}');

    const r = await migrateWorkspaceToFlat(tmpRoot);
    expect(
      r.skipped.find((s) => s.target.endsWith('hnsw.index'))?.reason,
    ).toBe('flat_already_present');

    expect(
      await fs.readFile(path.join(tmpRoot, CLIODECK_DIR, 'hnsw.index'), 'utf8'),
    ).toBe('LIVE');
  });

  it('writes a default config when the v2 subdir lacked one', async () => {
    // Edge case: legacy-subdir was detected via SOMETHING but config.json is
    // absent — this can happen if a user manually rm-ed it. We still want a
    // working workspace afterwards. (This case won't be detected as
    // legacy-subdir by detectWorkspaceVersion, so simulate via direct call.)
    const v2 = path.join(tmpRoot, CLIODECK_DIR, LEGACY_V2_SUBDIR);
    await write(path.join(v2, 'config.json'), '{"schema_version":2}');
    await write(path.join(v2, 'hints.md'), 'h');

    const r = await migrateWorkspaceToFlat(tmpRoot);
    expect(r.kind).toBe('legacy-subdir');
    const cfg = await readWorkspaceConfig(tmpRoot);
    expect(cfg.schema_version).toBe(2);
  });
});

describe('migrateWorkspaceToFlat — cliobrain', () => {
  // Fabrique une vraie base SQLite : exige le binding (cf. native-guards).
  it.skipIf(!sqliteAvailable)('copies canonical artifacts and merges config', async () => {
    const cb = path.join(tmpRoot, CLIOBRAIN_DIR);
    await writeDb(path.join(cb, 'brain.db'), 'CLIOBRAIN');
    await write(path.join(cb, 'hnsw.index'), 'VEC');
    await write(path.join(cb, 'hints.md'), '# hints');
    await write(
      path.join(cb, 'config.json'),
      JSON.stringify({ name: 'thesis', custom_field: 'preserved' }),
    );

    const r = await migrateWorkspaceToFlat(tmpRoot);
    expect(r.kind).toBe('cliobrain');
    expect(r.copied.map((c) => path.basename(c.target)).sort()).toEqual(
      ['brain.db', 'config.json', 'hints.md', 'hnsw.index'],
    );

    const flat = workspaceFiles(tmpRoot);
    expect(readDbMarker(flat.brainDb)).toBe('CLIOBRAIN');

    const cfg = await readWorkspaceConfig(tmpRoot);
    expect(cfg.schema_version).toBe(2);
    expect(cfg.name).toBe('thesis');
    expect((cfg as Record<string, unknown>).custom_field).toBe('preserved');
  });

  it('warns on malformed ClioBrain config', async () => {
    await write(
      path.join(tmpRoot, CLIOBRAIN_DIR, 'config.json'),
      '{not json',
    );
    const r = await migrateWorkspaceToFlat(tmpRoot);
    expect(r.warnings.some((w) => w.includes('Failed to parse'))).toBe(true);
  });
});

/**
 * Un projet reçu par git ou en zip garde ses liens, et cette migration tourne à son
 * ouverture, avant toute garde de lecture : ce qu'elle copie ou déplace devient un fichier
 * ordinaire du projet, que plus rien ne reconnaît comme venu d'ailleurs.
 */
describe.skipIf(!symlinkAvailable)('migrateWorkspaceToFlat — un lien qui sort du projet', () => {
  const SECRET = 'SECRET-HORS-PROJET';
  let project = '';
  let outside = '';

  beforeEach(async () => {
    project = path.join(tmpRoot, 'recu');
    outside = path.join(tmpRoot, 'dehors');
    await fs.mkdir(project);
    await fs.mkdir(outside);
  });

  const presentIn = async (dir: string): Promise<string[]> => (await fs.readdir(dir)).sort();
  const refused = (report: MigrationReport): string[] =>
    report.skipped.filter((s) => s.reason === 'outside_project').map((s) => path.basename(s.source));

  /** Les tables d'une base, sans passer par le migrateur. */
  function tablesOf(p: string): string[] {
    const db = new Database(p, { readonly: true });
    try {
      return db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .pluck()
        .all() as string[];
    } finally {
      db.close();
    }
  }

  describe('.cliobrain', () => {
    it('un hints.md lié dehors ne devient pas le contexte du projet', async () => {
      await write(path.join(outside, 'journal.md'), `${SECRET} : texte privé.`);
      await fs.mkdir(path.join(project, CLIOBRAIN_DIR));
      await fs.symlink(path.join(outside, 'journal.md'), path.join(project, CLIOBRAIN_DIR, 'hints.md'));

      const r = await migrateWorkspaceToFlat(project);

      expect(r.kind).toBe('cliobrain');
      expect(refused(r)).toEqual(['hints.md']);
      await expect(fs.access(workspaceFiles(project).hints)).rejects.toThrow();
      const hints = await loadWorkspaceHints(project);
      expect(JSON.stringify(hints)).not.toContain(SECRET);
      expect(await fs.readFile(path.join(outside, 'journal.md'), 'utf8')).toContain(SECRET);
    });

    it.each(['brain.db', 'hnsw.index', 'mcp-access.jsonl'])('un %s lié dehors n’est pas copié', async (name) => {
      await write(path.join(outside, name), SECRET);
      await fs.mkdir(path.join(project, CLIOBRAIN_DIR));
      await fs.symlink(path.join(outside, name), path.join(project, CLIOBRAIN_DIR, name));

      const r = await migrateWorkspaceToFlat(project);

      expect(refused(r)).toEqual([name]);
      await expect(fs.access(path.join(project, CLIODECK_DIR, name))).rejects.toThrow();
    });

    // La base d'un autre projet de l'auteur : son manuscrit entrerait dans celui-ci.
    it.skipIf(!sqliteAvailable)('une vraie base liée dehors n’entre pas dans le projet', async () => {
      await writeDb(path.join(outside, 'brain.db'), SECRET);
      await fs.mkdir(path.join(project, CLIOBRAIN_DIR));
      await fs.symlink(path.join(outside, 'brain.db'), path.join(project, CLIOBRAIN_DIR, 'brain.db'));

      await migrateWorkspaceToFlat(project);

      await expect(fs.access(workspaceFiles(project).brainDb)).rejects.toThrow();
      expect(readDbMarker(path.join(outside, 'brain.db'))).toBe(SECRET);
    });

    it('un config.json lié dehors n’est pas fusionné : la configuration est celle par défaut', async () => {
      await write(path.join(outside, 'reglages.json'), JSON.stringify({ name: SECRET, custom: SECRET }));
      await fs.mkdir(path.join(project, CLIOBRAIN_DIR));
      await fs.symlink(path.join(outside, 'reglages.json'), path.join(project, CLIOBRAIN_DIR, 'config.json'));

      const r = await migrateWorkspaceToFlat(project, { name: 'recu' });

      expect(refused(r)).toEqual(['config.json']);
      expect(await fs.readFile(workspaceFiles(project).config, 'utf8')).not.toContain(SECRET);
      expect((await readWorkspaceConfig(project)).name).toBe('recu');
    });

    it('un dossier .cliobrain entier lié dehors ne donne rien', async () => {
      await write(path.join(outside, 'hints.md'), SECRET);
      await write(path.join(outside, 'config.json'), JSON.stringify({ name: SECRET }));
      await fs.symlink(outside, path.join(project, CLIOBRAIN_DIR));

      const r = await migrateWorkspaceToFlat(project);

      expect(refused(r)).toEqual(['hints.md', 'config.json']);
      await expect(fs.access(workspaceFiles(project).hints)).rejects.toThrow();
      expect(await fs.readFile(workspaceFiles(project).config, 'utf8')).not.toContain(SECRET);
      expect(await presentIn(outside)).toEqual(['config.json', 'hints.md']);
    });

    it('témoin : un lien qui reste dans le projet est copié comme avant', async () => {
      await write(path.join(project, 'notes', 'hints.md'), '# dedans');
      await fs.mkdir(path.join(project, CLIOBRAIN_DIR));
      await fs.symlink('../notes/hints.md', path.join(project, CLIOBRAIN_DIR, 'hints.md'));

      const r = await migrateWorkspaceToFlat(project);

      expect(refused(r)).toEqual([]);
      expect(await fs.readFile(workspaceFiles(project).hints, 'utf8')).toBe('# dedans');
    });

    it('témoin : une racine ouverte par un lien ne refuse rien à tort', async () => {
      const alias = path.join(tmpRoot, 'alias');
      await fs.symlink(project, alias);
      await write(path.join(project, CLIOBRAIN_DIR, 'hints.md'), '# dedans');
      await write(path.join(project, CLIOBRAIN_DIR, 'config.json'), JSON.stringify({ name: 'these' }));

      const r = await migrateWorkspaceToFlat(alias);

      expect(refused(r)).toEqual([]);
      expect(r.warnings).toEqual([]);
      expect(await fs.readFile(workspaceFiles(project).hints, 'utf8')).toBe('# dedans');
      expect((await readWorkspaceConfig(project)).name).toBe('these');
    });

    it('une racine ouverte par un lien refuse quand même le lien sortant', async () => {
      const alias = path.join(tmpRoot, 'alias');
      await fs.symlink(project, alias);
      await write(path.join(outside, 'journal.md'), SECRET);
      await fs.mkdir(path.join(project, CLIOBRAIN_DIR));
      await fs.symlink(path.join(outside, 'journal.md'), path.join(project, CLIOBRAIN_DIR, 'hints.md'));

      const r = await migrateWorkspaceToFlat(alias);

      expect(refused(r)).toEqual(['hints.md']);
      await expect(fs.access(workspaceFiles(project).hints)).rejects.toThrow();
    });
  });

  describe('.cliodeck/v2', () => {
    const v2 = (): string => path.join(project, CLIODECK_DIR, LEGACY_V2_SUBDIR);

    it('un v2 lié dehors : rien de déplacé, le dossier de l’auteur reste intact', async () => {
      await write(path.join(outside, 'config.json'), JSON.stringify({ schema_version: 2, name: SECRET }));
      await write(path.join(outside, 'hints.md'), SECRET);
      await write(path.join(outside, 'lettres.md'), 'mes lettres');
      await write(path.join(outside, 'recipes', 'une.yaml'), 'name: une\n');
      await fs.mkdir(path.join(project, CLIODECK_DIR));
      await fs.symlink(outside, v2());

      const r = await migrateWorkspaceToFlat(project, { name: 'recu' });

      expect(r.kind).toBe('legacy-subdir');
      expect(refused(r)).toEqual([LEGACY_V2_SUBDIR]);
      expect(r.copied.filter((c) => c.source.startsWith(v2()))).toEqual([]);
      expect(r.warnings.join('\n')).toContain(LEGACY_V2_SUBDIR);
      expect(await presentIn(outside)).toEqual(['config.json', 'hints.md', 'lettres.md', 'recipes']);
      expect(await presentIn(path.join(outside, 'recipes'))).toEqual(['une.yaml']);

      const flat = workspaceFiles(project);
      await expect(fs.access(flat.hints)).rejects.toThrow();
      await expect(fs.access(path.join(flat.root, 'lettres.md'))).rejects.toThrow();
      expect((await readWorkspaceConfig(project)).name).toBe('recu');
      expect(JSON.stringify(await loadWorkspaceHints(project))).not.toContain(SECRET);

      // Le projet s'ouvre, et la passe suivante ne touche à rien non plus.
      expect(await detectWorkspaceVersion(project)).toBe('flat');
      await migrateWorkspaceToFlat(project);
      expect(await presentIn(outside)).toEqual(['config.json', 'hints.md', 'lettres.md', 'recipes']);
    });

    it('dans un v2 réel, un lien sortant ne monte pas à la place du fichier canonique', async () => {
      await write(path.join(outside, 'journal.md'), SECRET);
      await write(path.join(outside, 'reglages.json'), JSON.stringify({ schema_version: 2, name: SECRET }));
      await write(path.join(outside, 'recettes', 'une.yaml'), SECRET);
      await write(path.join(v2(), 'ordinaire.txt'), 'à déplacer');
      await write(path.join(v2(), 'sous', 'ordinaire.txt'), 'à déplacer aussi');
      await fs.symlink(path.join(outside, 'reglages.json'), path.join(v2(), 'config.json'));
      await fs.symlink(path.join(outside, 'journal.md'), path.join(v2(), 'hints.md'));
      await fs.symlink(path.join(outside, 'journal.md'), path.join(v2(), 'brain.db'));
      await fs.symlink(path.join(outside, 'journal.md'), path.join(v2(), 'sous', 'lien.md'));
      await fs.symlink(path.join(outside, 'recettes'), path.join(v2(), 'recettes-liees'));

      const r = await migrateWorkspaceToFlat(project, { name: 'recu' });

      expect(r.kind).toBe('legacy-subdir');
      expect(refused(r).sort()).toEqual(['brain.db', 'config.json', 'hints.md', 'lien.md', 'recettes-liees']);
      const flat = workspaceFiles(project);
      for (const absent of [flat.hints, flat.brainDb, path.join(flat.root, 'recettes-liees'), path.join(flat.root, 'sous', 'lien.md')]) {
        await expect(fs.lstat(absent)).rejects.toThrow();
      }
      // Ce qui appartient au projet part, comme avant.
      expect(await fs.readFile(path.join(flat.root, 'ordinaire.txt'), 'utf8')).toBe('à déplacer');
      expect(await fs.readFile(path.join(flat.root, 'sous', 'ordinaire.txt'), 'utf8')).toBe('à déplacer aussi');
      // La configuration n'est pas un lien vers l'extérieur.
      expect((await fs.lstat(flat.config)).isSymbolicLink()).toBe(false);
      expect((await readWorkspaceConfig(project)).name).toBe('recu');
    });

    it('témoin : un v2 lié à l’intérieur du projet se déplace comme avant', async () => {
      await write(path.join(project, 'ancien-v2', 'config.json'), JSON.stringify({ schema_version: 2, name: 'dedans' }));
      await write(path.join(project, 'ancien-v2', 'hints.md'), '# dedans');
      await fs.mkdir(path.join(project, CLIODECK_DIR));
      await fs.symlink('../ancien-v2', v2());

      const r = await migrateWorkspaceToFlat(project);

      expect(refused(r)).toEqual([]);
      expect(await fs.readFile(workspaceFiles(project).hints, 'utf8')).toBe('# dedans');
      expect((await readWorkspaceConfig(project)).name).toBe('dedans');
    });

    it('témoin : une racine ouverte par un lien déplace comme avant', async () => {
      const alias = path.join(tmpRoot, 'alias');
      await fs.symlink(project, alias);
      await write(path.join(v2(), 'config.json'), JSON.stringify({ schema_version: 2, name: 'dedans' }));
      await write(path.join(v2(), 'hints.md'), '# dedans');
      await write(path.join(v2(), 'recipes', 'une.yaml'), 'name: une\n');

      const r = await migrateWorkspaceToFlat(alias);

      expect(refused(r)).toEqual([]);
      expect(r.warnings).toEqual([]);
      const flat = workspaceFiles(project);
      expect(await fs.readFile(flat.hints, 'utf8')).toBe('# dedans');
      expect(await fs.readFile(path.join(flat.recipesDir, 'une.yaml'), 'utf8')).toBe('name: une\n');
      await expect(fs.access(v2())).rejects.toThrow();
    });
  });

  // Ces étapes ouvrent la base : sans garde, elles renomment les tables à l'autre bout du lien.
  describe.skipIf(!sqliteAvailable)('les anciennes bases', () => {
    const cliodeck = (name: string): string => path.join(project, CLIODECK_DIR, name);

    /** Les colonnes que la consolidation exige : sans elles, elle s'annule toute seule. */
    const COLUMNS: Record<string, string> = {
      notes:
        'id TEXT PRIMARY KEY, relative_path TEXT, vault_path TEXT, title TEXT, tags TEXT, ' +
        'frontmatter TEXT, wikilinks TEXT, file_hash TEXT, file_mtime INTEGER, indexed_at TEXT',
      chunks:
        'id TEXT PRIMARY KEY, note_id TEXT, chunk_index INTEGER, content TEXT, section_title TEXT, ' +
        'start_position INTEGER, end_position INTEGER, embedding BLOB, dimension INTEGER',
    };

    async function externalDb(name: string, tables: string[]): Promise<string> {
      const file = path.join(outside, name);
      const db = new Database(file);
      try {
        for (const table of tables) db.exec(`CREATE TABLE ${table} (${COLUMNS[table] ?? 'secret TEXT'})`);
      } finally {
        db.close();
      }
      return file;
    }

    beforeEach(async () => {
      await write(cliodeck('config.json'), '{"schema_version":2}');
    });

    it.each([
      ['history.db', ['sessions']],
      ['obsidian-vectors.db', ['notes', 'chunks']],
      ['primary-sources.db', ['primary_sources']],
      ['vectors.db', ['documents']],
    ])('%s lié dehors : la base reste intacte et n’entre pas dans le projet', async (name, tables) => {
      const external = await externalDb(name, tables);
      await fs.symlink(external, cliodeck(name));

      const r = await migrateWorkspaceToFlat(project);

      expect(refused(r)).toEqual([name]);
      expect(r.warnings.join('\n')).toContain(name);
      expect(tablesOf(external).sort()).toEqual([...tables].sort());
      await expect(fs.lstat(workspaceFiles(project).brainDb)).rejects.toThrow();
      expect((await fs.lstat(cliodeck(name))).isSymbolicLink()).toBe(true);
    });

    it.each([
      ['obsidian-vectors.db', ['notes', 'chunks']],
      ['primary-sources.db', ['primary_sources']],
      ['vectors.db', ['documents']],
    ])('%s lié dehors ne se verse pas dans un brain.db existant', async (name, tables) => {
      const external = await externalDb(name, tables);
      await writeDb(workspaceFiles(project).brainDb, 'PROJET');
      await fs.symlink(external, cliodeck(name));

      await migrateWorkspaceToFlat(project);

      expect(tablesOf(workspaceFiles(project).brainDb)).toEqual(['fixture_marker']);
      expect(tablesOf(external).sort()).toEqual([...tables].sort());
    });

    it('une base réelle du projet ne se verse pas dans un brain.db lié dehors', async () => {
      const external = await externalDb('brain.db', ['sans_rapport']);
      await fs.symlink(external, workspaceFiles(project).brainDb);
      const legacy = cliodeck('vectors.db');
      const db = new Database(legacy);
      db.exec('CREATE TABLE documents (texte TEXT)');
      db.close();

      const r = await migrateWorkspaceToFlat(project);

      expect(refused(r)).toEqual(['vectors.db', 'brain.db']);
      expect(tablesOf(external)).toEqual(['sans_rapport']);
      expect(tablesOf(legacy)).toEqual(['documents']);
    });

    it('un brain.db lié dehors n’a pas ses tables renommées', async () => {
      const external = await externalDb('autre-appli.db', ['sessions', 'events']);
      await fs.symlink(external, workspaceFiles(project).brainDb);

      const r = await migrateWorkspaceToFlat(project);

      expect(refused(r)).toEqual(['brain.db']);
      expect(tablesOf(external).sort()).toEqual(['events', 'sessions']);
    });

    it('témoin : une racine ouverte par un lien consolide comme avant', async () => {
      const alias = path.join(tmpRoot, 'alias');
      await fs.symlink(project, alias);
      await writeDb(cliodeck('history.db'), 'HISTOIRE');

      const r = await migrateWorkspaceToFlat(alias);

      expect(refused(r)).toEqual([]);
      expect(readDbMarker(workspaceFiles(project).brainDb)).toBe('HISTOIRE');
    });
  });
});

describe('readWorkspaceConfig', () => {
  it('rejects newer schema_version', async () => {
    await write(
      path.join(tmpRoot, CLIODECK_DIR, 'config.json'),
      JSON.stringify({ schema_version: 99 }),
    );
    await expect(readWorkspaceConfig(tmpRoot)).rejects.toMatchObject({ kind: 'newer_schema' });
  });
});
