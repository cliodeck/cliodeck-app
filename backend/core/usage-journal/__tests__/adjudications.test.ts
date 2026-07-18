/**
 * Adjudications de propositions (schema v2, plan CM6 Phase 4) : migration
 * v1→v2, insertion/lecture, granularité sans contenu, brouillons, agrégats.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Garde partagée : cf. backend/__tests__/helpers/native-guards.ts.
import { sqliteAvailable } from '@backend/__tests__/helpers/native-guards';

import { UsageJournalStore } from '../UsageJournalStore.js';
import { summarizeAdjudications } from '../aggregate.js';
import type { ProposalAdjudication } from '../types.js';


let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cliodeck-adjudications-'));
  dbPath = path.join(dir, 'journal.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function adj(overrides: Partial<ProposalAdjudication>): ProposalAdjudication {
  return {
    id: overrides.id ?? `adj-${Math.random().toString(36).slice(2)}`,
    at: overrides.at ?? '2026-07-17T10:00:00.000Z',
    decision: overrides.decision ?? 'accepted',
    category: overrides.category ?? 'reformulation',
    model: overrides.model ?? 'qwen3:14b',
    task: overrides.task ?? 'write-assist',
    workspace: overrides.workspace,
  };
}

describe.skipIf(!sqliteAvailable)('UsageJournalStore v2 — proposal_adjudications', () => {
  it('crée une base neuve directement en schema_version 2', () => {
    const store = new UsageJournalStore(dbPath);
    store.close();
    const raw = new Database(dbPath);
    const row = raw
      .prepare('SELECT value FROM journal_meta WHERE key = ?')
      .get('schema_version') as { value: string };
    raw.close();
    expect(row.value).toBe('2');
  });

  it('migre une base v1 existante vers v2 sans toucher aux données', () => {
    // Fabrique une base v1 minimale avec un événement d'inférence réel.
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE inference_events (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL, kind TEXT NOT NULL, provider TEXT NOT NULL,
        model TEXT NOT NULL, is_local INTEGER NOT NULL, prompt_tokens INTEGER,
        completion_tokens INTEGER, total_tokens INTEGER, tokens_estimated INTEGER NOT NULL,
        chunk_count INTEGER, mode TEXT NOT NULL, workspace TEXT NOT NULL,
        corpus TEXT, recipe_id TEXT, status TEXT NOT NULL, ref TEXT
      );
      CREATE TABLE usage_decisions (
        id TEXT PRIMARY KEY, date TEXT NOT NULL, workspace TEXT NOT NULL,
        task TEXT NOT NULL, alternative TEXT NOT NULL, justification TEXT NOT NULL,
        verdict TEXT NOT NULL, verdict_note TEXT
      );
      CREATE TABLE session_decision (
        session_id TEXT NOT NULL, decision_id TEXT NOT NULL,
        PRIMARY KEY (session_id, decision_id)
      );
      CREATE TABLE journal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO journal_meta (key, value) VALUES ('schema_version', '1');
      INSERT INTO inference_events VALUES (
        'ev1', 's1', '2026-07-01T09:00:00.000Z', 120, 'completion', 'ollama',
        'qwen3:14b', 1, 100, 50, 150, 0, NULL, 'write', '/tmp/proj', NULL, NULL, 'ok', NULL
      );
    `);
    raw.close();

    const store = new UsageJournalStore(dbPath);
    // Données v1 intactes…
    const events = store.getEventsBetween('2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z');
    expect(events).toHaveLength(1);
    expect(events[0].model).toBe('qwen3:14b');
    // …nouvelles tables utilisables…
    store.insertAdjudication(adj({ id: 'a1' }));
    expect(
      store.getAdjudicationsBetween('2026-07-17T00:00:00.000Z', '2026-07-18T00:00:00.000Z')
    ).toHaveLength(1);
    store.close();
    // …et version actée.
    const check = new Database(dbPath);
    const row = check
      .prepare('SELECT value FROM journal_meta WHERE key = ?')
      .get('schema_version') as { value: string };
    check.close();
    expect(row.value).toBe('2');
  });

  it('insère et relit une adjudication (round-trip typé)', () => {
    const store = new UsageJournalStore(dbPath);
    store.insertAdjudication(
      adj({ id: 'a1', decision: 'modified', workspace: '/proj', at: '2026-07-17T11:00:00.000Z' })
    );
    const [read] = store.getAdjudicationsBetween(
      '2026-07-17T00:00:00.000Z',
      '2026-07-18T00:00:00.000Z'
    );
    expect(read).toEqual({
      id: 'a1',
      at: '2026-07-17T11:00:00.000Z',
      decision: 'modified',
      category: 'reformulation',
      model: 'qwen3:14b',
      task: 'write-assist',
      workspace: '/proj',
    });
    store.close();
  });

  it('la granularité est imposée par le typage et par le schéma : aucun contenu', () => {
    const store = new UsageJournalStore(dbPath);

    // Typage : le type ProposalAdjudication ne possède pas de champ de contenu.
    store.insertAdjudication({
      id: 'a1',
      at: '2026-07-17T11:00:00.000Z',
      decision: 'rejected',
      category: 'brievete',
      model: 'm',
      task: 't',
      // @ts-expect-error — un contenu textuel ne peut pas entrer dans le journal d'usage
      original: 'texte original interdit ici',
    });
    store.close();

    // Schéma : même en SQL brut, la table n'a aucune colonne de contenu.
    const raw = new Database(dbPath);
    const cols = (
      raw.pragma('table_info(proposal_adjudications)') as Array<{ name: string }>
    ).map((c) => c.name);
    raw.close();
    expect(cols.sort()).toEqual(
      ['at', 'category', 'decision', 'id', 'model', 'task', 'workspace'].sort()
    );
    for (const forbidden of ['original', 'proposed', 'final', 'note', 'text', 'prompt']) {
      expect(cols.some((c) => c.includes(forbidden))).toBe(false);
    }
  });

  it('stocke les notes de rejet comme brouillons, jamais comme décisions', () => {
    const store = new UsageJournalStore(dbPath);
    store.insertDecisionDraft({
      id: 'd1',
      at: '2026-07-17T11:00:00.000Z',
      category: 'reformulation',
      model: 'qwen3:14b',
      task: 'write-assist',
      note: 'trop verbeux pour une note de bas de page',
      status: 'draft',
    });
    expect(store.getDecisionDrafts('draft')).toHaveLength(1);
    expect(store.getDecisionDrafts('promoted')).toHaveLength(0);
    // usage_decisions n'est pas affectée : la promotion est un geste explicite.
    expect(store.getAllDecisions()).toHaveLength(0);
    store.close();
  });
});

describe('summarizeAdjudications', () => {
  const range = { from: '2026-07-17T00:00:00.000Z', to: '2026-07-18T00:00:00.000Z' };

  it('calcule le taux d’acceptation en excluant invalidated/expired du dénominateur', () => {
    const rows: ProposalAdjudication[] = [
      adj({ id: '1', decision: 'accepted' }),
      adj({ id: '2', decision: 'accepted' }),
      adj({ id: '3', decision: 'rejected' }),
      adj({ id: '4', decision: 'modified' }),
      adj({ id: '5', decision: 'invalidated' }),
      adj({ id: '6', decision: 'expired' }),
    ];
    const s = summarizeAdjudications(rows, range);
    expect(s.total).toBe(6);
    expect(s.overall.accepted).toBe(2);
    expect(s.overall.invalidated).toBe(1);
    expect(s.overall.expired).toBe(1);
    // 2 accepted / (2 + 1 rejected + 1 modified) = 0.5
    expect(s.overall.acceptanceRate).toBeCloseTo(0.5);
  });

  it('ventile par catégorie et par modèle, taux null sans adjudication jugée', () => {
    const rows: ProposalAdjudication[] = [
      adj({ id: '1', category: 'brievete', model: 'a', decision: 'accepted' }),
      adj({ id: '2', category: 'brievete', model: 'a', decision: 'rejected' }),
      adj({ id: '3', category: 'correction', model: 'b', decision: 'expired' }),
    ];
    const s = summarizeAdjudications(rows, range);
    const brievete = s.byCategory.find((c) => c.key === 'brievete');
    const correction = s.byCategory.find((c) => c.key === 'correction');
    expect(brievete?.acceptanceRate).toBeCloseTo(0.5);
    expect(correction?.acceptanceRate).toBeNull();
    expect(s.byModel.map((m) => m.key)).toEqual(['a', 'b']);
  });

  it('résultat vide propre sur liste vide', () => {
    const s = summarizeAdjudications([], range);
    expect(s.total).toBe(0);
    expect(s.byCategory).toEqual([]);
    expect(s.overall.acceptanceRate).toBeNull();
  });
});
