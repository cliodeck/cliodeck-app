/**
 * Le raisonnement d'un modèle pensant entre au journal de recherche avec la
 * réponse, à part d'elle (colonne `thinking`, schéma v5). Une base v4 gagne
 * la colonne par migration sans perdre ses messages.
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
  projectDir = mkdtempSync(path.join(tmpdir(), 'cliodeck-history-thinking-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('HistoryManager — raisonnement des modèles pensants', () => {
  it('enregistre le raisonnement à part de la réponse et le relit', () => {
    const hm = new HistoryManager(projectDir);
    const sessionId = hm.startSession();
    hm.logChatMessage({ role: 'user', content: 'Qui est François-Poncet ?' });
    hm.logChatMessage({
      role: 'assistant',
      content: 'Ambassadeur de France à Berlin.',
      thinking: 'Les dépêches citées viennent de Berlin ; l’auteur signe comme ambassadeur…',
    });
    const messages = hm.getChatMessagesForSession(sessionId);
    expect(messages).toHaveLength(2);
    expect(messages[0].thinking).toBeUndefined();
    expect(messages[1].content).toBe('Ambassadeur de France à Berlin.');
    expect(messages[1].thinking).toMatch(/dépêches/);
    // Le lecteur global suit le même mappage.
    const all = hm.getAllChatMessages();
    expect(all.find((m) => m.role === 'assistant')?.thinking).toMatch(/dépêches/);
    hm.close();
  });

  it('une réponse sans raisonnement reste sans raisonnement (pas de chaîne vide)', () => {
    const hm = new HistoryManager(projectDir);
    const sessionId = hm.startSession();
    hm.logChatMessage({ role: 'assistant', content: 'Réponse directe.', thinking: '' });
    expect(hm.getChatMessagesForSession(sessionId)[0].thinking).toBeUndefined();
    hm.close();
  });

  it('migre une base v4 : la colonne apparaît, les messages restent', () => {
    const hm1 = new HistoryManager(projectDir);
    const sessionId = hm1.startSession();
    hm1.logChatMessage({ role: 'user', content: 'message d’avant la v5' });
    hm1.close();

    const dbPath = path.join(projectDir, '.cliodeck', 'brain.db');
    const raw = new Database(dbPath);
    // Retour artificiel à la v4 : on retire la colonne et l'on rétrograde la version.
    raw.exec('ALTER TABLE history_chat_messages DROP COLUMN thinking');
    raw.prepare('INSERT OR REPLACE INTO history_metadata (key, value) VALUES (?, ?)').run('schema_version', '4');
    raw.close();

    const hm2 = new HistoryManager(projectDir);
    const cols = (new Database(dbPath).pragma('table_info(history_chat_messages)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('thinking');
    const kept = hm2.getChatMessagesForSession(sessionId);
    expect(kept.map((m) => m.content)).toEqual(['message d’avant la v5']);
    expect(kept[0].thinking).toBeUndefined();
    hm2.close();
  });
});
