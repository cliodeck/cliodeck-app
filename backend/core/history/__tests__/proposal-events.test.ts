/**
 * Journal de recherche — adjudications de propositions (schema v3, plan CM6
 * Phase 4) : migration v2→v3, log/lecture avec contenus complets, no-op sans
 * session.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HistoryManager } from '../HistoryManager.js';

// ABI connue (CLAUDE.md §6) : better-sqlite3 est recompilé pour Electron par
// le postinstall ; sous le node de vitest le binding peut être incompatible.
const sqliteAvailable = (() => {
  try {
    new Database(':memory:').close();
    return true;
  } catch {
    return false;
  }
})();

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), 'cliodeck-history-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

const EVENT = {
  at: '2026-07-17T10:00:00.000Z',
  proposalId: 'prop-1',
  decision: 'modified' as const,
  category: 'reformulation',
  model: 'qwen3:14b',
  task: 'write-assist',
  latencyMs: 4200,
  originalText: 'Le texte original.',
  proposedText: 'Le texte proposé.',
  finalText: 'Le texte final retenu par l’utilisateur.',
};

describe.skipIf(!sqliteAvailable)('HistoryManager v3 — history_proposal_events', () => {
  it('une base neuve est en schema_version 3', () => {
    const hm = new HistoryManager(projectDir);
    hm.close();
    const dbPath = path.join(projectDir, '.cliodeck', 'brain.db');
    const raw = new Database(dbPath);
    const row = raw
      .prepare('SELECT value FROM history_metadata WHERE key = ?')
      .get('schema_version') as { value: string };
    raw.close();
    expect(row.value).toBe('3');
  });

  it('migre une base v2 vers v3 sans toucher aux données existantes', () => {
    // Passe 1 : créer une base réelle puis la rétrograder artificiellement en v2.
    const hm1 = new HistoryManager(projectDir);
    const sessionId = hm1.startSession();
    hm1.logChatMessage({ role: 'user', content: 'prompt de test v2' });
    hm1.close();
    const dbPath = path.join(projectDir, '.cliodeck', 'brain.db');
    const raw = new Database(dbPath);
    raw
      .prepare('INSERT OR REPLACE INTO history_metadata (key, value) VALUES (?, ?)')
      .run('schema_version', '2');
    raw.exec('DROP TABLE history_proposal_events');
    raw.close();

    // Passe 2 : réouverture → migration v3, données intactes, table recréée.
    const hm2 = new HistoryManager(projectDir);
    expect(hm2.getChatMessagesForSession(sessionId)).toHaveLength(1);
    hm2.startSession();
    const id = hm2.logProposalAdjudication(EVENT);
    expect(id).not.toBe('');
    hm2.close();

    const check = new Database(dbPath);
    const row = check
      .prepare('SELECT value FROM history_metadata WHERE key = ?')
      .get('schema_version') as { value: string };
    check.close();
    expect(row.value).toBe('3');
  });

  it('journalise et relit une adjudication avec ses contenus complets', () => {
    const hm = new HistoryManager(projectDir);
    // startSession n'est pas automatique dans le manager : le service le fait.
    const sessionId = hm.startSession();

    const id = hm.logProposalAdjudication({ ...EVENT, rejectionNote: undefined });
    expect(id).not.toBe('');

    const events = hm.getProposalEventsForSession(sessionId);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.proposalId).toBe('prop-1');
    expect(e.decision).toBe('modified');
    expect(e.latencyMs).toBe(4200);
    // Les contenus ont leur place ici — c'est le journal de recherche.
    expect(e.originalText).toBe('Le texte original.');
    expect(e.proposedText).toBe('Le texte proposé.');
    expect(e.finalText).toBe('Le texte final retenu par l’utilisateur.');
    expect(e.rejectionNote).toBeUndefined();
    hm.close();
  });

  it("retourne '' sans session active (no-op, pas d'erreur)", () => {
    const hm = new HistoryManager(projectDir);
    expect(hm.getCurrentSessionId()).toBeNull();
    expect(hm.logProposalAdjudication(EVENT)).toBe('');
    hm.close();
  });
});
