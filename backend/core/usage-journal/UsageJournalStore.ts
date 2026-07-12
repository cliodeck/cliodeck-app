/**
 * Journal d'usage IA — store SQLite (`.cliodeck/journal.db`).
 *
 * Base **délibérément séparée** de `brain.db` (instructions §3.3) : le journal doit
 * pouvoir être copié, archivé et publié indépendamment de l'outil qu'il documente.
 * Idiome calqué sur `backend/core/history/HistoryManager.ts` (better-sqlite3 maison :
 * `CREATE TABLE IF NOT EXISTS`, table `journal_meta` clé-valeur avec `schema_version`,
 * migrations gardées `if (version < N)`).
 *
 * Le store est purement synchrone ; le découplage non bloquant (buffer + flush) vit
 * dans `usage-journal-service.ts`. Une panne d'écriture ne doit jamais remonter dans
 * un appel LLM — le service avale les erreurs.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, chmodSync } from 'fs';
import path from 'path';
import type {
  InferenceEvent,
  InferenceKind,
  InferenceStatus,
  SessionDecisionLink,
  UsageDecision,
  UsageMode,
  Verdict,
} from './types.js';

/** Ligne brute de `inference_events` (colonnes snake_case, booléens en 0/1). */
interface EventRow {
  id: string;
  session_id: string;
  at: string;
  duration_ms: number;
  kind: string;
  provider: string;
  model: string;
  is_local: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  tokens_estimated: number;
  chunk_count: number | null;
  mode: string;
  workspace: string;
  corpus: string | null;
  recipe_id: string | null;
  status: string;
  ref: string | null;
}

interface DecisionRow {
  id: string;
  date: string;
  workspace: string;
  task: string;
  alternative: string;
  justification: string;
  verdict: string;
  verdict_note: string | null;
}

function rowToEvent(r: EventRow): InferenceEvent {
  return {
    id: r.id,
    sessionId: r.session_id,
    at: r.at,
    durationMs: r.duration_ms,
    kind: r.kind as InferenceKind,
    provider: r.provider,
    model: r.model,
    isLocal: r.is_local === 1,
    promptTokens: r.prompt_tokens ?? undefined,
    completionTokens: r.completion_tokens ?? undefined,
    totalTokens: r.total_tokens ?? undefined,
    tokensEstimated: r.tokens_estimated === 1,
    chunkCount: r.chunk_count ?? undefined,
    mode: r.mode as UsageMode,
    workspace: r.workspace,
    corpus: r.corpus ?? undefined,
    recipeId: r.recipe_id ?? undefined,
    status: r.status as InferenceStatus,
    ref: r.ref ?? undefined,
  };
}

function rowToDecision(r: DecisionRow): UsageDecision {
  return {
    id: r.id,
    date: r.date,
    workspace: r.workspace,
    task: r.task,
    alternative: r.alternative,
    justification: r.justification,
    verdict: r.verdict as Verdict,
    verdictNote: r.verdict_note ?? undefined,
  };
}

const SCHEMA_VERSION = 1;

export class UsageJournalStore {
  private db: Database.Database;
  private open = false;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.open = true;
    try {
      if (existsSync(dbPath)) chmodSync(dbPath, 0o644);
    } catch {
      // permissions best-effort
    }
    this.db.pragma('journal_mode = WAL');
    this.createTables();
    this.migrate();
  }

  isOpen(): boolean {
    return this.open;
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inference_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        kind TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        is_local INTEGER NOT NULL,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        tokens_estimated INTEGER NOT NULL,
        chunk_count INTEGER,
        mode TEXT NOT NULL,
        workspace TEXT NOT NULL,
        corpus TEXT,
        recipe_id TEXT,
        status TEXT NOT NULL,
        ref TEXT
      );

      CREATE TABLE IF NOT EXISTS usage_decisions (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        workspace TEXT NOT NULL,
        task TEXT NOT NULL,
        alternative TEXT NOT NULL,
        justification TEXT NOT NULL,
        verdict TEXT NOT NULL,
        verdict_note TEXT
      );

      CREATE TABLE IF NOT EXISTS session_decision (
        session_id TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        PRIMARY KEY (session_id, decision_id)
      );

      CREATE TABLE IF NOT EXISTS journal_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_at ON inference_events(at);
      CREATE INDEX IF NOT EXISTS idx_events_session ON inference_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_workspace ON inference_events(workspace);
      CREATE INDEX IF NOT EXISTS idx_decisions_date ON usage_decisions(date);
      CREATE INDEX IF NOT EXISTS idx_session_decision_decision ON session_decision(decision_id);
    `);
  }

  private migrate(): void {
    const row = this.db
      .prepare('SELECT value FROM journal_meta WHERE key = ?')
      .get('schema_version') as { value: string } | undefined;
    const current = row ? parseInt(row.value, 10) : 0;

    if (current === 0) {
      this.db
        .prepare('INSERT OR REPLACE INTO journal_meta (key, value) VALUES (?, ?)')
        .run('schema_version', String(SCHEMA_VERSION));
    }
    // Futures migrations : `if (current < N) { …ALTER…; bump; }`.
  }

  private readonly insertEventStmt = () =>
    this.db.prepare(`
      INSERT INTO inference_events (
        id, session_id, at, duration_ms, kind, provider, model, is_local,
        prompt_tokens, completion_tokens, total_tokens, tokens_estimated,
        chunk_count, mode, workspace, corpus, recipe_id, status, ref
      ) VALUES (
        @id, @sessionId, @at, @durationMs, @kind, @provider, @model, @isLocal,
        @promptTokens, @completionTokens, @totalTokens, @tokensEstimated,
        @chunkCount, @mode, @workspace, @corpus, @recipeId, @status, @ref
      )
    `);

  /** Insère une salve d'événements dans une transaction unique. */
  insertEvents(events: InferenceEvent[]): void {
    if (events.length === 0) return;
    const stmt = this.insertEventStmt();
    const tx = this.db.transaction((rows: InferenceEvent[]) => {
      for (const e of rows) {
        stmt.run({
          id: e.id,
          sessionId: e.sessionId,
          at: e.at,
          durationMs: e.durationMs,
          kind: e.kind,
          provider: e.provider,
          model: e.model,
          isLocal: e.isLocal ? 1 : 0,
          promptTokens: e.promptTokens ?? null,
          completionTokens: e.completionTokens ?? null,
          totalTokens: e.totalTokens ?? null,
          tokensEstimated: e.tokensEstimated ? 1 : 0,
          chunkCount: e.chunkCount ?? null,
          mode: e.mode,
          workspace: e.workspace,
          corpus: e.corpus ?? null,
          recipeId: e.recipeId ?? null,
          status: e.status,
          ref: e.ref ?? null,
        });
      }
    });
    tx(events);
  }

  upsertDecision(d: UsageDecision): void {
    this.db
      .prepare(`
        INSERT INTO usage_decisions (
          id, date, workspace, task, alternative, justification, verdict, verdict_note
        ) VALUES (
          @id, @date, @workspace, @task, @alternative, @justification, @verdict, @verdictNote
        )
        ON CONFLICT(id) DO UPDATE SET
          date = excluded.date,
          workspace = excluded.workspace,
          task = excluded.task,
          alternative = excluded.alternative,
          justification = excluded.justification,
          verdict = excluded.verdict,
          verdict_note = excluded.verdict_note
      `)
      .run({
        id: d.id,
        date: d.date,
        workspace: d.workspace,
        task: d.task,
        alternative: d.alternative,
        justification: d.justification,
        verdict: d.verdict,
        verdictNote: d.verdictNote ?? null,
      });
  }

  /** Événements dont l'horodatage est dans [fromISO, toISO), triés par date. */
  getEventsBetween(fromISO: string, toISO: string): InferenceEvent[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM inference_events WHERE at >= ? AND at < ? ORDER BY at ASC'
      )
      .all(fromISO, toISO) as EventRow[];
    return rows.map(rowToEvent);
  }

  /** Décisions dont la date (jour) est dans [fromDate, toDate). */
  getDecisionsBetween(fromDate: string, toDate: string): UsageDecision[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM usage_decisions WHERE date >= ? AND date < ? ORDER BY date ASC'
      )
      .all(fromDate, toDate) as DecisionRow[];
    return rows.map(rowToDecision);
  }

  getAllDecisions(): UsageDecision[] {
    const rows = this.db
      .prepare('SELECT * FROM usage_decisions ORDER BY date ASC')
      .all() as DecisionRow[];
    return rows.map(rowToDecision);
  }

  getAllLinks(): SessionDecisionLink[] {
    const rows = this.db
      .prepare('SELECT session_id, decision_id FROM session_decision')
      .all() as Array<{ session_id: string; decision_id: string }>;
    return rows.map((r) => ({ sessionId: r.session_id, decisionId: r.decision_id }));
  }

  linkSessionDecision(link: SessionDecisionLink): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO session_decision (session_id, decision_id) VALUES (?, ?)'
      )
      .run(link.sessionId, link.decisionId);
  }

  /** Remplace l'ensemble des sessions rattachées à une décision (transaction). */
  replaceDecisionLinks(decisionId: string, sessionIds: string[]): void {
    const tx = this.db.transaction((ids: string[]) => {
      this.db.prepare('DELETE FROM session_decision WHERE decision_id = ?').run(decisionId);
      const stmt = this.db.prepare(
        'INSERT OR IGNORE INTO session_decision (session_id, decision_id) VALUES (?, ?)'
      );
      for (const sid of ids) stmt.run(sid, decisionId);
    });
    tx(sessionIds);
  }

  unlinkSessionDecision(link: SessionDecisionLink): void {
    this.db
      .prepare(
        'DELETE FROM session_decision WHERE session_id = ? AND decision_id = ?'
      )
      .run(link.sessionId, link.decisionId);
  }

  close(): void {
    if (!this.open) return;
    try {
      this.db.close();
    } finally {
      this.open = false;
    }
  }
}
