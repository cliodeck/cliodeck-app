/**
 * `pdf:index` refuse un PDF embarqué dans une autre dimension que le corpus avec un code et les deux
 * dimensions (L04-7) : l'interface le traduit, au lieu d'afficher le texte anglais du main.
 *
 * Vrai handler ; simulés : le projet ouvert du main (une variable) et le service PDF, dont
 * l'indexation lève l'erreur que lève le vrai indexeur.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EmbeddingSpaceMismatchError } from '../../../../../backend/core/vector-store/embedding-space.js';

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

let current: string | null = null;
const pdf = vi.hoisted(() => ({ indexPDF: vi.fn() }));
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-pdf-index-dimension-'));

beforeEach(() => {
  current = root;
  pdf.indexPDF.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('pdf:index, PDF d’une autre dimension que le corpus', () => {
  it('rend le code et les deux dimensions', async () => {
    pdf.indexPDF.mockRejectedValue(new EmbeddingSpaceMismatchError({ kind: 'dimension', expected: 768, actual: 1024 }));

    const response = await call('pdf:index', path.join(root, 'PDFs', 'Rapport.pdf'), 'Rapport', undefined, root);

    expect(response).toMatchObject({
      success: false,
      code: 'embedding_dimension_mismatch',
      expected: 768,
      actual: 1024,
    });
  });

  it('une autre erreur reste un texte, sans code', async () => {
    pdf.indexPDF.mockRejectedValue(new Error('Embedding failed: fetch failed (Ollama)'));

    const response = await call('pdf:index', path.join(root, 'PDFs', 'Rapport.pdf'), 'Rapport', undefined, root);

    expect(response).toEqual({ success: false, error: 'Embedding failed: fetch failed (Ollama)' });
  });
});
