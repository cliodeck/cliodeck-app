/**
 * Purge du journal de recherche (#16) : vide toutes les tables history_*,
 * épargne les autres domaines de brain.db, rouvre une session pour que
 * les écritures suivantes ne cassent pas la FK session_id.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sqliteAvailable } from '@backend/__tests__/helpers/native-guards';

import { HistoryManager } from '../HistoryManager.js';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), 'cliodeck-purge-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('HistoryManager.purgeAll (#16)', () => {
  it('vide les tables history_*, épargne les autres domaines, rouvre une session', () => {
    const hm = new HistoryManager(projectDir);
    const sessionId = hm.startSession();
    hm.logEvent('document_edit', { chars: 42 });
    hm.logProposalAdjudication({
      at: '2026-07-24T10:00:00.000Z',
      proposalId: 'p1',
      decision: 'accepted',
      category: 'style',
      model: 'test',
      task: 'write',
      latencyMs: 10,
    });

    // Un autre domaine partage brain.db : il doit survivre à la purge.
    const dbPath = path.join(projectDir, '.cliodeck', 'brain.db');
    const raw = new Database(dbPath);
    raw.exec(`CREATE TABLE IF NOT EXISTS pdf_documents (id TEXT PRIMARY KEY);
              INSERT INTO pdf_documents (id) VALUES ('doc1');`);
    raw.close();

    const result = hm.purgeAll();
    expect(result.deletedSessions).toBeGreaterThanOrEqual(1);

    // Journal vide (hormis la session rouverte), autre domaine intact.
    const check = new Database(dbPath);
    const sessions = check.prepare('SELECT id FROM history_sessions').all() as Array<{
      id: string;
    }>;
    const events = check.prepare('SELECT COUNT(*) AS c FROM history_events').get() as {
      c: number;
    };
    const proposals = check
      .prepare('SELECT COUNT(*) AS c FROM history_proposal_events')
      .get() as { c: number };
    const pdf = check.prepare('SELECT COUNT(*) AS c FROM pdf_documents').get() as {
      c: number;
    };
    check.close();

    expect(events.c).toBe(0);
    expect(proposals.c).toBe(0);
    expect(pdf.c).toBe(1);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).not.toBe(sessionId);

    // Les écritures post-purge repartent sur la nouvelle session (FK OK).
    expect(() => hm.logEvent('document_edit', { chars: 1 })).not.toThrow();
    hm.close();
  });
});
