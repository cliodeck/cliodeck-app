/**
 * J8 : l'état « index des PDF à reconstruire » et « Reconstruire » ne valent que pour le projet
 * ouvert. Une demande partie de A et arrivée après la bascule ne reconstruit pas l'index de B, et
 * l'état de B ne s'affiche pas dans A.
 *
 * Vrais handlers ; simulés : le projet ouvert du main (une variable) et le service PDF.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), isPackaged: false },
  BrowserWindow: { fromWebContents: () => null },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));

/** Le projet ouvert dans le main. */
let current: string | null = null;
const pdf = vi.hoisted(() => ({
  getIndexState: vi.fn(() => ({ rebuildDue: true })),
  rebuildIndexOnRequest: vi.fn(() => true),
}));
vi.mock('../../../services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => current },
}));
vi.mock('../../../services/pdf-service.js', () => ({ pdfService: pdf }));
vi.mock('../../../services/history-service.js', () => ({
  historyService: { getHistoryManager: () => null },
}));

const { setupPDFHandlers } = await import('../pdf-handlers.js');
setupPDFHandlers();

async function call(channel: string, ...args: unknown[]): Promise<Record<string, unknown>> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Aucun handler pour ${channel}`);
  return (await handler({ sender: {} }, ...args)) as Record<string, unknown>;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-pdf-index-state-'));
const A = path.join(root, 'A');
const B = path.join(root, 'B');
fs.mkdirSync(A);
fs.mkdirSync(B);

beforeEach(() => {
  current = B;
  pdf.getIndexState.mockClear();
  pdf.rebuildIndexOnRequest.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('pdf:get-index-state et pdf:rebuild-index, pour le projet ouvert seulement (J8)', () => {
  it('le projet ouvert : l’état du service, puis la reconstruction lancée', async () => {
    expect(await call('pdf:get-index-state', B)).toEqual({ success: true, rebuildDue: true });
    expect(await call('pdf:rebuild-index', B)).toEqual({ success: true, started: true });
    expect(pdf.rebuildIndexOnRequest).toHaveBeenCalledTimes(1);
  });

  it('une demande de A arrivée après la bascule vers B : refusée, rien n’est reconstruit', async () => {
    expect(await call('pdf:rebuild-index', A)).toMatchObject({ success: false, error: 'project-changed' });
    expect(pdf.rebuildIndexOnRequest).not.toHaveBeenCalled();
  });

  it('l’état de B ne répond pas pour A', async () => {
    expect(await call('pdf:get-index-state', A)).toMatchObject({ success: false, error: 'project-changed' });
    expect(pdf.getIndexState).not.toHaveBeenCalled();
  });

  it('aucun projet ouvert : refusé aussi', async () => {
    current = null;
    expect(await call('pdf:rebuild-index', B)).toMatchObject({ success: false, error: 'project-changed' });
    expect(pdf.rebuildIndexOnRequest).not.toHaveBeenCalled();
  });
});
