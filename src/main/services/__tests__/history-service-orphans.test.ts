/**
 * Rouvrir un projet ferme la session que la séance précédente a laissée ouverte (L03-9 ; S11-1-6).
 *
 * Un Cmd+Q d'avant le correctif, un plantage ou un kill laissent une session sans fin : rien ne la
 * fermait jamais, et le Journal l'affichait « Active » à vie. Le vrai service, le vrai
 * HistoryManager, une vraie base : la séance précédente est écrite telle qu'un `app.exit()` la
 * laisse, sans `endSession`.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';
import { HistoryManager } from '../../../../backend/core/history/HistoryManager.js';
import { historyService } from '../history-service.js';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), 'cliodeck-history-reopen-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  historyService.close();
  vi.restoreAllMocks();
  rmSync(projectDir, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('historyService.init — la séance d’avant', () => {
  it('une session restée ouverte est close à la réouverture, à son dernier événement ; la nouvelle reste ouverte', async () => {
    new HistoryManager(projectDir).close();
    const db = new Database(path.join(projectDir, '.cliodeck', 'brain.db'));
    db.prepare(
      'INSERT INTO history_sessions (id, project_path, started_at, event_count) VALUES (?, ?, ?, ?)'
    ).run('hier', projectDir, '2026-11-10T09:00:00.000Z', 1);
    db.prepare(
      'INSERT INTO history_events (id, session_id, event_type, timestamp) VALUES (?, ?, ?, ?)'
    ).run('e1', 'hier', 'document_operation', '2026-11-10T11:00:00.000Z');
    db.close();

    await historyService.init(projectDir);

    const hm = historyService.getHistoryManager();
    const sessions = hm?.getAllSessions() ?? [];
    expect(sessions).toHaveLength(2);
    const yesterday = sessions.find((s) => s.id === 'hier');
    expect(yesterday?.endedAt?.toISOString()).toBe('2026-11-10T11:00:00.000Z');
    expect(yesterday?.totalDurationMs).toBe(2 * 3_600_000);
    const today = sessions.find((s) => s.id !== 'hier');
    expect(today?.id).toBe(hm?.getCurrentSessionId());
    expect(today?.endedAt).toBeUndefined();
  });
});
