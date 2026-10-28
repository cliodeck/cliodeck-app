/**
 * Part du manuscrit dans les réponses : l'agrégation est une fonction pure
 * sur les lignes de `history_chat_messages`, le script ne doit rien écrire
 * dans la base, et il doit lire une base d'avant la migration v2 (sans
 * `mode_id`).
 *
 * Base synthétique créée avec node:sqlite (pas de binding natif, donc pas de
 * garde d'ABI), comme pour le bilan de santé.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import {
  BIN_COUNT,
  SANS_MODE,
  UNKNOWN_SOURCE_TYPE,
  aggregateRows,
  binIndex,
  median,
  parseArgs,
  parseSources,
  renderMarkdown,
} from '../manuscript-share.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'manuscript-share.mjs');

type Row = {
  role: string;
  content: string;
  sources_json: string | null;
  timestamp: string;
  mode_id: string | null;
};

const src = (sourceType: string | undefined, similarity: number) => ({
  documentId: 'd',
  documentTitle: 'T',
  pageNumber: 1,
  similarity,
  ...(sourceType ? { sourceType } : {}),
});

/** Quatre réponses : 100 % manuscrit, sans source, mixte (autre mode), ancienne sans `sourceType` ni mode. Plus un message utilisateur. */
const ROWS: Row[] = [
  {
    role: 'assistant',
    content: 'Vous l’avez déjà écrit [M1] et nuancé [M2].',
    sources_json: JSON.stringify([src('manuscript', 0.41), src('manuscript', 0.35), src('manuscript', 0.52)]),
    timestamp: '2026-10-01T10:00:00.000Z',
    mode_id: 'default-assistant',
  },
  {
    role: 'assistant',
    content: 'Je ne trouve rien dans les sources interrogées.',
    sources_json: null,
    timestamp: '2026-10-02T10:00:00.000Z',
    mode_id: 'default-assistant',
  },
  {
    role: 'assistant',
    content: 'Trois pistes [1] [2] [3].',
    sources_json: JSON.stringify([src('secondary', 0.21), src('secondary', 0.18), src('primary', 0.15), src('manuscript', 0.44)]),
    timestamp: '2026-10-10T10:00:00.000Z',
    mode_id: 'brainstorming',
  },
  {
    role: 'assistant',
    content: 'Réponse ancienne [1].',
    sources_json: JSON.stringify([src(undefined, 0.3), src(undefined, 0.25)]),
    timestamp: '2026-09-01T10:00:00.000Z',
    mode_id: null,
  },
  {
    role: 'user',
    content: 'Qu’ai-je déjà écrit sur Danzig [M1] ?',
    sources_json: null,
    timestamp: '2026-10-01T09:59:00.000Z',
    mode_id: 'default-assistant',
  },
];

describe('aggregateRows — vue d’ensemble', () => {
  const agg = aggregateRows(ROWS);

  it('compte les réponses, celles avec sources et celles avec manuscrit, sans les messages utilisateur', () => {
    expect(agg.ensemble.reponses).toBe(4);
    expect(agg.ensemble.avecSources).toBe(3);
    expect(agg.ensemble.avecManuscrit).toBe(2);
    expect(agg.ensemble.sourcesIllisibles).toBe(0);
  });

  it('calcule la part du manuscrit sur les réponses avec sources : moyenne, médiane, 100 %, globale', () => {
    // parts : 1 (3/3), 0,25 (1/4), 0 (0/2) — la réponse sans source n'a pas de part.
    expect(agg.ensemble.partManuscrit.moyenne).toBeCloseTo((1 + 0.25 + 0) / 3, 10);
    expect(agg.ensemble.partManuscrit.mediane).toBe(0.25);
    expect(agg.ensemble.partManuscrit.toutManuscrit).toBe(1);
    expect(agg.ensemble.partManuscrit.globale).toBeCloseTo(4 / 9, 10);
  });

  it('compte les réponses qui portent la marque [M n] — le message utilisateur qui la contient ne compte pas', () => {
    expect(agg.ensemble.citentManuscrit).toBe(1);
  });

  it('range les lignes sans sourceType sous « unknown », sans les deviner', () => {
    expect(agg.ensemble.extraits.total).toBe(9);
    expect(agg.ensemble.extraits.parCorpus).toEqual({
      manuscript: 4,
      secondary: 2,
      primary: 1,
      vault: 0,
      readingNotes: 0,
      [UNKNOWN_SOURCE_TYPE]: 2,
    });
  });

  it('construit l’histogramme de similarité par corpus en dix classes de 0,1', () => {
    const h = agg.ensemble.histogramme;
    const bins = (type: string) => h[type].bornes;
    expect(bins('manuscript')).toEqual([0, 0, 0, 1, 2, 1, 0, 0, 0, 0]); // 0,35 · 0,41 0,44 · 0,52
    expect(bins('secondary')).toEqual([0, 1, 1, 0, 0, 0, 0, 0, 0, 0]); // 0,18 · 0,21
    expect(bins('primary')).toEqual([0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(bins(UNKNOWN_SOURCE_TYPE)).toEqual([0, 0, 1, 1, 0, 0, 0, 0, 0, 0]); // 0,25 · 0,3
    expect(bins('vault')).toEqual(new Array(BIN_COUNT).fill(0));
    expect(h.manuscript.n).toBe(4);
    expect(h.manuscript.mediane).toBeCloseTo((0.41 + 0.44) / 2, 10);
    expect(h.manuscript.moyenne).toBeCloseTo((0.41 + 0.35 + 0.52 + 0.44) / 4, 10);
    expect(h.vault.moyenne).toBeNull();
  });
});

describe('aggregateRows — par mode', () => {
  const agg = aggregateRows(ROWS);
  const byMode = Object.fromEntries(agg.modes.map((m) => [m.modeId, m]));

  it('sépare les modes, NULL devenant « (sans mode) », les plus fournis d’abord', () => {
    expect(agg.modes.map((m) => m.modeId)).toEqual(['default-assistant', SANS_MODE, 'brainstorming']);
  });

  it('agrège chaque mode séparément', () => {
    expect(byMode['default-assistant']).toMatchObject({ reponses: 2, avecSources: 1, avecManuscrit: 1, citentManuscrit: 1 });
    expect(byMode['default-assistant'].partManuscrit).toMatchObject({ moyenne: 1, mediane: 1, toutManuscrit: 1, globale: 1 });
    expect(byMode.brainstorming).toMatchObject({ reponses: 1, avecSources: 1, avecManuscrit: 1, citentManuscrit: 0 });
    expect(byMode.brainstorming.partManuscrit.moyenne).toBe(0.25);
    expect(byMode[SANS_MODE]).toMatchObject({ reponses: 1, avecSources: 1, avecManuscrit: 0 });
    expect(byMode[SANS_MODE].partManuscrit).toMatchObject({ moyenne: 0, mediane: 0, toutManuscrit: 0 });
  });
});

describe('aggregateRows — --since et lignes abîmées', () => {
  it('écarte ce qui précède la date, puis une ligne sans date lisible', () => {
    const agg = aggregateRows(ROWS, { since: '2026-10-05' });
    expect(agg.since).toBe('2026-10-05');
    expect(agg.ensemble.reponses).toBe(1);
    expect(agg.modes.map((m) => m.modeId)).toEqual(['brainstorming']);
    const sansDate = aggregateRows([{ ...ROWS[0], timestamp: 'n/a' }], { since: '2026-01-01' });
    expect(sansDate.ensemble.reponses).toBe(0);
  });

  it('refuse une date illisible', () => {
    expect(() => aggregateRows(ROWS, { since: 'hier' })).toThrow(/Date invalide/);
  });

  it('compte un sources_json illisible comme une réponse sans source, et le signale', () => {
    const agg = aggregateRows([{ ...ROWS[0], sources_json: '{pas du json' }]);
    expect(agg.ensemble).toMatchObject({ reponses: 1, avecSources: 0, sourcesIllisibles: 1 });
    expect(agg.ensemble.partManuscrit.moyenne).toBeNull();
  });

  it('parseSources : type manquant → unknown, similarité non numérique → null, non-tableau → illisible', () => {
    expect(parseSources(JSON.stringify([{ similarity: 'x' }, { sourceType: 'vault', similarity: 0.5 }]))).toEqual({
      illisible: false,
      sources: [
        { sourceType: UNKNOWN_SOURCE_TYPE, similarity: null },
        { sourceType: 'vault', similarity: 0.5 },
      ],
    });
    expect(parseSources('{"a":1}')).toEqual({ sources: [], illisible: true });
    expect(parseSources(null)).toEqual({ sources: [], illisible: false });
  });

  it('binIndex et median : bornes fermées en 1, hors [0 ; 1] à part, médiane paire', () => {
    expect(binIndex(0)).toBe(0);
    expect(binIndex(0.3)).toBe(3);
    expect(binIndex(1)).toBe(BIN_COUNT - 1);
    expect(binIndex(-0.01)).toBe(-1);
    expect(binIndex(1.2)).toBe(-1);
    expect(median([3, 1, 2, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('renderMarkdown', () => {
  it('donne les tableaux attendus, en français, et nomme l’hypothèse que l’histogramme mesure', () => {
    const md = renderMarkdown(aggregateRows(ROWS), { projet: '/p', base: '/p/.cliodeck/brain.db', walPending: false });
    expect(md).toContain('# Part du manuscrit dans les réponses — /p');
    expect(md).toContain('## Vue d’ensemble');
    expect(md).toContain('| Réponses de l’assistant | 4 |');
    expect(md).toContain('| … avec au moins un extrait du manuscrit | 2 |');
    expect(md).toContain('| Part du manuscrit — médiane | 25,0 % |');
    expect(md).toContain('| Réponses dont 100 % des extraits viennent du manuscrit | 1 |');
    expect(md).toContain('## Par mode de chat');
    expect(md).toContain(`| ${SANS_MODE} | 1 |`);
    expect(md).toContain('| `brainstorming` | 1 | 1 | 1 | 25,0 % | 25,0 % | 0 | 0 |');
    expect(md).toContain('similarité de soi à soi');
    expect(md).toContain('| [0,4 ; 0,5[ | 2 | 0 | 0 | 0 | 0 | 0 |');
    expect(md).toContain('| [0,9 ; 1,0] |');
    expect(md).toContain('Sans type (lignes anciennes)');
  });

  it('reste lisible sans aucune réponse', () => {
    const md = renderMarkdown(aggregateRows([]));
    expect(md).toContain('Aucune réponse de l’assistant sur la période.');
    expect(md).toContain('| Part du manuscrit — médiane | — |');
  });
});

describe('parseArgs', () => {
  it('lit le chemin, --json, --since (deux écritures) et refuse le reste', () => {
    expect(parseArgs(['/p'])).toEqual({ options: { json: false, since: null, target: '/p' } });
    expect(parseArgs(['--json', '/p', '--since', '2026-10-01'])).toEqual({ options: { json: true, since: '2026-10-01', target: '/p' } });
    expect(parseArgs(['/p', '--since=2026-10-01'])).toEqual({ options: { json: false, since: '2026-10-01', target: '/p' } });
    expect(parseArgs([])).toEqual({ error: null });
    expect(parseArgs(['/p', '--since'])).toMatchObject({ error: expect.stringContaining('--since') });
    expect(parseArgs(['/p', '--since', 'hier'])).toMatchObject({ error: expect.stringContaining('date invalide') });
    expect(parseArgs(['/p', '--rien'])).toMatchObject({ error: expect.stringContaining('option inconnue') });
    expect(parseArgs(['/p', '/q'])).toMatchObject({ error: expect.stringContaining('un seul chemin') });
  });
});

// ---------------------------------------------------------------------------
// Le script de bout en bout, sur une base temporaire
// ---------------------------------------------------------------------------

let root = '';
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function createBrain(withModeId: boolean): string {
  const dbPath = path.join(root, '.cliodeck', 'brain.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE history_sessions (id TEXT PRIMARY KEY);
    CREATE TABLE history_chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      thinking TEXT,
      sources_json TEXT,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES history_sessions(id) ON DELETE CASCADE
    );
  `);
  if (withModeId) db.exec('ALTER TABLE history_chat_messages ADD COLUMN mode_id TEXT');
  db.prepare('INSERT INTO history_sessions VALUES (?)').run('s1');
  const insert = withModeId
    ? db.prepare('INSERT INTO history_chat_messages (id, session_id, role, content, thinking, sources_json, timestamp, mode_id) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)')
    : db.prepare('INSERT INTO history_chat_messages (id, session_id, role, content, thinking, sources_json, timestamp) VALUES (?, ?, ?, ?, NULL, ?, ?)');
  ROWS.forEach((row, i) => {
    const values = [`m${i}`, 's1', row.role, row.content, row.sources_json, row.timestamp];
    if (withModeId) values.push(row.mode_id);
    insert.run(...values);
  });
  db.close();
  return dbPath;
}

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-manuscript-share-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('scripts/manuscript-share.mjs', () => {
  it('produit le Markdown, en lecture seule stricte (ni -wal, ni -shm, base intacte)', () => {
    const dbPath = createBrain(true);
    const before = sha(dbPath);
    const { status, stdout, stderr } = run([root]);
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(stdout).toContain('| Réponses de l’assistant | 4 |');
    expect(stdout).toContain('| `default-assistant` | 2 |');
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
    expect(sha(dbPath)).toBe(before);
  });

  it('--json rend les agrégats bruts, --since les restreint', () => {
    createBrain(true);
    const { status, stdout } = run([root, '--json', '--since', '2026-10-05']);
    expect(status).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.projet).toBe(root);
    expect(json.since).toBe('2026-10-05');
    expect(json.ensemble.reponses).toBe(1);
    expect(json.modes.map((m: { modeId: string }) => m.modeId)).toEqual(['brainstorming']);
    expect(json.ensemble.histogramme.manuscript.bornes).toEqual([0, 0, 0, 0, 1, 0, 0, 0, 0, 0]);
  });

  it('lit une base d’avant la migration v2 (sans mode_id) : tout tombe sous « (sans mode) »', () => {
    createBrain(false);
    const { status, stdout } = run([root, '--json']);
    expect(status).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.ensemble.reponses).toBe(4);
    expect(json.modes.map((m: { modeId: string }) => m.modeId)).toEqual([SANS_MODE]);
  });

  it('sort en 2 sans argument, sans base, ou sans table de conversation', () => {
    expect(run([])).toMatchObject({ status: 2 });
    expect(run([]).stderr).toContain('usage');
    const sansBase = run([root]);
    expect(sansBase.status).toBe(2);
    expect(sansBase.stderr).toContain('brain.db');
    fs.mkdirSync(path.join(root, '.cliodeck'), { recursive: true });
    new DatabaseSync(path.join(root, '.cliodeck', 'brain.db')).close();
    const sansTable = run([root]);
    expect(sansTable.status).toBe(2);
    expect(sansTable.stderr).toContain('history_chat_messages');
  });
});
