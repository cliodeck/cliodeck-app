/**
 * Les sessions restées « Active » se ferment à la réouverture du projet (L03-9 ; S11-1-6).
 *
 * `ended_at` et `total_duration_ms` ne s'écrivaient que par `endSession`, à la fermeture du projet.
 * Quitter l'app (le cas courant), un plantage ou un kill laissaient la session ouverte à vie :
 * « Active » dans le Journal, « Duration: N/A » dans les rapports, exclue de la durée moyenne.
 * `closeOrphanSessions` les ferme au dernier horodatage connu, sans toucher à la session courante
 * ni aux événements. Une vraie base SQLite, des horodatages posés à la main.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteAvailable } from '@backend/__tests__/helpers/native-guards';

import { HistoryManager } from '../HistoryManager.js';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), 'cliodeck-history-orphans-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(projectDir, { recursive: true, force: true });
});

const brainDb = (): string => path.join(projectDir, '.cliodeck', 'brain.db');

interface SessionRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  total_duration_ms: number | null;
  metadata: string | null;
}

/**
 * Ce que laisse un Cmd+Q d'avant le correctif : une session sans fin, et ses événements. Le schéma
 * vient d'un vrai HistoryManager, fermé sans session courante.
 */
function seedOrphan(id: string, startedAt: string, eventsAt: string[], metadata: object | null = null): void {
  new HistoryManager(projectDir).close();
  const db = new Database(brainDb());
  try {
    db.prepare(
      'INSERT INTO history_sessions (id, project_path, started_at, event_count, metadata) VALUES (?, ?, ?, ?, ?)'
    ).run(id, projectDir, startedAt, eventsAt.length, metadata ? JSON.stringify(metadata) : null);
    eventsAt.forEach((at, i) => {
      db.prepare(
        'INSERT INTO history_events (id, session_id, event_type, timestamp, event_data) VALUES (?, ?, ?, ?, ?)'
      ).run(`${id}-e${i}`, id, 'document_operation', at, null);
    });
  } finally {
    db.close();
  }
}

function readSessions(): SessionRow[] {
  const db = new Database(brainDb(), { readonly: true });
  try {
    return db.prepare('SELECT * FROM history_sessions ORDER BY started_at').all() as SessionRow[];
  } finally {
    db.close();
  }
}

function eventCount(): number {
  const db = new Database(brainDb(), { readonly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS c FROM history_events').get() as { c: number }).c;
  } finally {
    db.close();
  }
}

describe.skipIf(!sqliteAvailable)('HistoryManager.closeOrphanSessions', () => {
  it('une session sans fin, avec des événements : fermée à son dernier événement', () => {
    seedOrphan('s1', '2026-11-10T09:00:00.000Z', ['2026-11-10T09:10:00.000Z', '2026-11-10T10:30:00.000Z']);

    const hm = new HistoryManager(projectDir);
    const repaired = hm.closeOrphanSessions();
    hm.close();

    expect(repaired).toBe(1);
    const [s1] = readSessions();
    expect(s1.ended_at).toBe('2026-11-10T10:30:00.000Z');
    expect(s1.total_duration_ms).toBe(90 * 60_000);
    // Un rapport doit pouvoir distinguer une durée estimée d'une durée mesurée.
    expect(JSON.parse(s1.metadata ?? '{}')).toMatchObject({ endedBy: 'repair' });
    expect(eventCount()).toBe(2);
  });

  it('une session sans événement : fermée à son début, durée nulle', () => {
    seedOrphan('s1', '2026-11-10T09:00:00.000Z', []);

    const hm = new HistoryManager(projectDir);
    hm.closeOrphanSessions();
    hm.close();

    const [s1] = readSessions();
    expect(s1.ended_at).toBe('2026-11-10T09:00:00.000Z');
    expect(s1.total_duration_ms).toBe(0);
  });

  it('garde les métadonnées de la session et y ajoute la réparation', () => {
    seedOrphan('s1', '2026-11-10T09:00:00.000Z', ['2026-11-10T09:05:00.000Z'], { platform: 'darwin' });

    const hm = new HistoryManager(projectDir);
    hm.closeOrphanSessions();
    hm.close();

    expect(JSON.parse(readSessions()[0].metadata ?? '{}')).toEqual({ platform: 'darwin', endedBy: 'repair' });
  });

  it('la session courante n’est pas touchée, ni une session déjà close ; un second passage ne change rien', () => {
    seedOrphan('s1', '2026-11-10T09:00:00.000Z', ['2026-11-10T09:05:00.000Z']);
    const hm = new HistoryManager(projectDir);
    const current = hm.startSession();
    hm.logEvent('document_operation');

    expect(hm.closeOrphanSessions()).toBe(1);
    const once = readSessions();
    expect(hm.closeOrphanSessions()).toBe(0);
    expect(readSessions()).toEqual(once);

    const live = once.find((s) => s.id === current);
    expect(live?.ended_at).toBeNull();
    expect(live?.total_duration_ms).toBeNull();
    expect(hm.getCurrentSessionId()).toBe(current);
    hm.close();
  });

  it('dit combien de sessions ont été réparées', () => {
    seedOrphan('s1', '2026-11-10T09:00:00.000Z', []);
    seedOrphan('s2', '2026-11-10T11:00:00.000Z', ['2026-11-10T11:01:00.000Z']);
    const info = vi.mocked(console.info);

    const hm = new HistoryManager(projectDir);
    expect(hm.closeOrphanSessions()).toBe(2);
    hm.close();

    expect(info.mock.calls.flat().join(' ')).toMatch(/2 session/);
  });
});
