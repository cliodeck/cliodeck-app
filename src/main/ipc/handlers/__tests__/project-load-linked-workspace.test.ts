/**
 * `.cliodeck`, ou l'un de ses fichiers, lié hors du projet (D18). Avant, tout s'ouvrait à travers
 * le lien, écritures comprises : un `brain.db` lié vers celui d'un autre projet recevait toutes les
 * tables de celui-ci (mesuré en phase 1), et un `.cliodeck` lié se remplissait à l'autre bout.
 *
 * Le vrai handler `project:load`, sur un vrai disque, avec les vrais services qui ouvrent une base à
 * l'ouverture : historique, journal d'usage, sources primaires, corpus manuscrit. Seul le service PDF
 * est remplacé (il construit des fournisseurs) : le parcours e2e juge le sien dans l'app réelle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { sqliteAvailable, symlinkAvailable } from '../../../../../backend/__tests__/helpers/native-guards.js';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  pdfInit: vi.fn(async () => undefined),
  pdfClose: vi.fn(async () => undefined),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  app: { isPackaged: false, getPath: () => os.tmpdir() },
}));
vi.mock('../../../services/config-manager.js', () => ({
  configManager: {
    addRecentProject: vi.fn(),
    removeRecentProject: vi.fn(),
    getRecentProjects: () => [],
    getLLMConfig: () => ({ backend: 'ollama', ollamaURL: 'http://127.0.0.1:9' }),
    getRAGConfig: () => ({}),
  },
}));
vi.mock('../../../services/pdf-service.js', () => ({
  pdfService: { init: h.pdfInit, close: h.pdfClose, getCurrentProjectPath: () => null },
}));
vi.mock('../../../services/mcp-clients-service.js', () => ({ mcpClientsService: {} }));
// Elle tire tout le service de recherche ; sans fournisseur d'embeddings elle ne fait rien.
vi.mock('../../../services/reading-notes-indexing.js', () => ({ indexReadingNotesInBackground: vi.fn() }));
vi.mock('../../../services/retrieval-service.js', () => ({ retrievalService: { clear: vi.fn() } }));

import { setupProjectHandlers } from '../project-handlers.js';
import { modeService } from '../../../services/mode-service.js';

let workDir: string;
let projectDir: string;
let outside: string;

interface LoadResult {
  success: boolean;
  project?: { name: string };
  configIssue?: { kind: string; path: string };
}

function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`canal non enregistré : ${channel}`);
  return handler({ sender: { send: () => undefined, isDestroyed: () => false } }, ...args) as Promise<T>;
}

/** Tout le dossier : chaque entrée, sa taille, sa date, ses octets. */
function folderState(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = path.join(prefix, name);
    const stat = lstatSync(full);
    if (stat.isDirectory()) {
      out[`${rel}/`] = String(stat.mtimeMs);
      Object.assign(out, folderState(full, rel));
    } else {
      out[rel] = `${stat.size}|${stat.mtimeMs}|${readFileSync(full).toString('base64')}`;
    }
  }
  out['.'] = String(statSync(dir).mtimeMs);
  return out;
}

const VALID_CONFIG = JSON.stringify({ schema_version: 2, name: 'Thèse' }, null, 2);

/** Ouvre, puis ferme comme le fait l'interface : les bases fermées, leurs écritures sont sur le disque. */
async function openThenClose(): Promise<LoadResult> {
  const result = await call<LoadResult>('project:load', path.join(projectDir, 'project.json'));
  await call('project:close');
  return result;
}

beforeEach(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), 'cliodeck-lie-dehors-'));
  projectDir = path.join(workDir, 'Thèse');
  outside = path.join(workDir, 'ailleurs');
  mkdirSync(projectDir);
  mkdirSync(outside);
  writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify({ name: 'Thèse', type: 'article' }));
  writeFileSync(path.join(projectDir, 'document.md'), '# Thèse\n');
  h.pdfInit.mockClear();
  h.handlers.clear();
  setupProjectHandlers();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe.skipIf(!symlinkAvailable || !sqliteAvailable)('project:load — .cliodeck lié hors du projet', () => {
  it('.cliodeck entier lié dehors : rien n’est écrit à l’autre bout, le texte s’ouvre, le motif est rendu', async () => {
    writeFileSync(path.join(outside, 'note.txt'), 'à quelqu’un d’autre');
    const link = path.join(projectDir, '.cliodeck');
    symlinkSync(outside, link);
    const before = folderState(outside);

    const result = await openThenClose();

    expect(result.success).toBe(true);
    expect(result.project?.name).toBe('Thèse');
    expect(result.configIssue).toEqual({ kind: 'linked_outside', path: link });
    expect(folderState(outside)).toEqual(before);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(h.pdfInit).not.toHaveBeenCalled();
  });

  it('brain.db lié vers celui d’un autre projet : aucune table de ce projet n’y arrive', async () => {
    const other = path.join(outside, 'Autre projet', '.cliodeck');
    mkdirSync(other, { recursive: true });
    const otherDb = path.join(other, 'brain.db');
    const db = new Database(otherDb);
    db.exec('CREATE TABLE pdf_documents (id TEXT PRIMARY KEY); INSERT INTO pdf_documents VALUES (\'braudel\');');
    db.close();
    const tablesOf = (file: string): string[] => {
      const reader = new Database(file, { readonly: true });
      const names = (reader.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>).map((row) => row.name);
      reader.close();
      return names.sort();
    };
    const tablesBefore = tablesOf(otherDb);
    mkdirSync(path.join(projectDir, '.cliodeck'));
    writeFileSync(path.join(projectDir, '.cliodeck', 'config.json'), VALID_CONFIG);
    const link = path.join(projectDir, '.cliodeck', 'brain.db');
    symlinkSync(otherDb, link);
    const before = folderState(outside);

    const result = await openThenClose();

    expect(result.configIssue).toEqual({ kind: 'linked_outside', path: link });
    expect(tablesOf(otherDb)).toEqual(tablesBefore);
    expect(folderState(outside)).toEqual(before);
  });

  /** Chaque fichier de `.cliodeck` lié seul, `.cliodeck` restant un vrai dossier. */
  const ENTRIES: Array<[string, 'file' | 'dir']> = [
    ['brain.db', 'file'],
    ['brain.db-wal', 'file'],
    ['brain.db-shm', 'file'],
    ['journal.db', 'file'],
    ['hnsw.index', 'file'],
    ['primary-hnsw.index', 'file'],
    ['config.json', 'file'],
    ['mcp-access.jsonl', 'file'],
    ['security-events.jsonl', 'file'],
    ['recipes', 'dir'],
    ['recipes-runs', 'dir'],
    ['similarity_cache.json', 'file'],
    ['bibliography-metadata.json', 'file'],
  ];

  it.each(ENTRIES)('%s lié dehors : refusé, la cible intacte', async (name, kind) => {
    const target = path.join(outside, `cible-${name}`);
    if (kind === 'dir') {
      mkdirSync(target);
      writeFileSync(path.join(target, 'autre.yaml'), 'name: autre\n');
    } else {
      writeFileSync(target, name === 'config.json' ? VALID_CONFIG : 'contenu d’un autre projet');
    }
    mkdirSync(path.join(projectDir, '.cliodeck'));
    if (name !== 'config.json') writeFileSync(path.join(projectDir, '.cliodeck', 'config.json'), VALID_CONFIG);
    const link = path.join(projectDir, '.cliodeck', name);
    symlinkSync(target, link);
    const before = folderState(outside);

    const result = await openThenClose();

    expect(result.success).toBe(true);
    expect(result.configIssue).toEqual({ kind: 'linked_outside', path: link });
    expect(folderState(outside)).toEqual(before);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(h.pdfInit).not.toHaveBeenCalled();
  });

  it('project:create dans un dossier dont .cliodeck est lié dehors : créé, refusé, rien à l’autre bout', async () => {
    const dir = path.join(workDir, 'Neuf');
    mkdirSync(dir);
    const link = path.join(dir, '.cliodeck');
    symlinkSync(outside, link);
    const before = folderState(outside);

    const result = await call<LoadResult>('project:create', { name: 'Neuf', type: 'article', path: workDir });
    await call('project:close');

    expect(result.success).toBe(true);
    expect(result.configIssue).toEqual({ kind: 'linked_outside', path: link });
    expect(folderState(outside)).toEqual(before);
    expect(h.pdfInit).not.toHaveBeenCalled();
  });

  it('project:create refusé : les modes du projet, hors de .cliodeck, sont quand même les siens', async () => {
    const dir = path.join(workDir, 'Neuf');
    mkdirSync(dir);
    symlinkSync(outside, path.join(dir, '.cliodeck'));
    const init = vi.spyOn(modeService, 'init');

    try {
      const result = await call<LoadResult>('project:create', { name: 'Neuf', type: 'article', path: workDir });
      expect(result.configIssue?.kind).toBe('linked_outside');
      expect(init).toHaveBeenCalledWith(dir);
    } finally {
      init.mockRestore();
      await call('project:close');
    }
  });

  /** Un ancien fichier que la migration refuse (D17 ne le disait qu'au journal) : le même message. */
  it.each(['vectors.db', 'history.db', 'primary-sources.db', 'obsidian-vectors.db'])(
    'ancien %s lié dehors : la migration le refuse et l’ouverture le dit, la cible intacte',
    async (name) => {
      const target = path.join(outside, `cible-${name}`);
      writeFileSync(target, 'base d’un autre projet');
      mkdirSync(path.join(projectDir, '.cliodeck'));
      writeFileSync(path.join(projectDir, '.cliodeck', 'config.json'), VALID_CONFIG);
      const link = path.join(projectDir, '.cliodeck', name);
      symlinkSync(target, link);
      const before = folderState(outside);

      const result = await openThenClose();

      expect(result.success).toBe(true);
      expect(result.configIssue).toEqual({ kind: 'linked_outside', path: link });
      expect(folderState(outside)).toEqual(before);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(h.pdfInit).not.toHaveBeenCalled();
    },
  );

  it('témoin : un vrai dossier .cliodeck, sans lien, s’ouvre comme avant', async () => {
    mkdirSync(path.join(projectDir, '.cliodeck'));
    writeFileSync(path.join(projectDir, '.cliodeck', 'config.json'), VALID_CONFIG);

    const result = await openThenClose();

    expect(result.success).toBe(true);
    expect(result.configIssue).toBeUndefined();
    expect(h.pdfInit).toHaveBeenCalledWith(projectDir, expect.any(Function));
    expect(readdirSync(path.join(projectDir, '.cliodeck'))).toContain('brain.db');
  });

  it('un lien qui reste dans le projet n’est pas refusé', async () => {
    mkdirSync(path.join(projectDir, 'donnees'));
    symlinkSync(path.join(projectDir, 'donnees'), path.join(projectDir, '.cliodeck'));
    writeFileSync(path.join(projectDir, 'donnees', 'config.json'), VALID_CONFIG);

    const result = await openThenClose();

    expect(result.configIssue).toBeUndefined();
    expect(h.pdfInit).toHaveBeenCalled();
  });
});

/**
 * Un service qui ne démarre pas (BT1-5) : `project:load` le rendait comme une erreur nue, que
 * l'interface traduisait par « project.json peut-être illisible ou endommagé ». Le manifeste n'y
 * est pour rien : la réponse porte son propre code, et le journal du processus principal nomme le
 * service, sans que sa cause technique parte dans l'alerte.
 */
describe.skipIf(!sqliteAvailable)('project:load — un service du projet ne démarre pas', () => {
  interface Refusal {
    success: boolean;
    code?: string;
    error?: string;
  }

  const loggedLoadErrors = (spy: ReturnType<typeof vi.spyOn>): string[] =>
    spy.mock.calls
      .filter((args: unknown[]) => args[0] === '❌ project:load error:')
      .map((args: unknown[]) => args.map((part) => (part instanceof Error ? part.message : String(part))).join(' '));

  it('pdfService.init rejette : services_failed, et le journal nomme pdfService', async () => {
    h.pdfInit.mockRejectedValueOnce(new Error('registre de fournisseurs invalide'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const result = await call<Refusal>('project:load', path.join(projectDir, 'project.json'));

      expect(result).toMatchObject({ success: false, code: 'services_failed' });
      const lines = loggedLoadErrors(logged);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('pdfService');
      expect(lines[0]).toContain('registre de fournisseurs invalide');
    } finally {
      logged.mockRestore();
      await call('project:close');
    }
  });

  it('un service ouvert en parallèle rejette : services_failed, et le journal le nomme', async () => {
    const init = vi.spyOn(modeService, 'init').mockImplementationOnce(() => {
      throw new Error('modes illisibles');
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const result = await call<Refusal>('project:load', path.join(projectDir, 'project.json'));

      expect(result).toMatchObject({ success: false, code: 'services_failed' });
      expect(loggedLoadErrors(logged)[0]).toContain('modeService');
    } finally {
      init.mockRestore();
      logged.mockRestore();
      await call('project:close');
    }
  });

  it('témoin : tous les services démarrent, aucun code', async () => {
    const result = await openThenClose();
    expect(result.success).toBe(true);
    expect((result as Refusal).code).toBeUndefined();
  });
});
