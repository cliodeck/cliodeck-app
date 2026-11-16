/**
 * Le garde des serveurs MCP déclarés par le `.cliodeck/config.json` d'un projet, sur le vrai
 * registre des accords (un fichier dans un dossier temporaire, jamais le userData de l'auteur) et
 * les vrais textes de `menu.json`. Seul le dialogue natif est simulé.
 *
 * Deux trous (S09-2-3, S09-1-22) : un serveur SSE était approuvé d'office, sans dialogue, et un
 * accord donné pour une commande valait pour la même commande sous un autre env.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MessageBoxOptions } from 'electron';

const place = vi.hoisted(() => ({ userData: '' }));
const showMessageBox = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  app: {
    getPath: () => place.userData,
    isPackaged: false,
    getAppPath: () => path.resolve(__dirname, '../../../..'),
  },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showMessageBox },
}));

type Gate = typeof import('../mcp-approval-gate.js');

const SSE = { name: 'archives', transport: 'sse' as const, url: 'http://127.0.0.1:9/sse' };
const STDIO = {
  name: 'europeana',
  transport: 'stdio' as const,
  command: 'npx',
  args: ['-y', '@cliodeck/mcp-europeana'],
};

let root: string;
let gate: Gate;

/** Le dialogue répond : 1 = « Ajouter », 0 = « Annuler ». */
function answer(response: 0 | 1): void {
  showMessageBox.mockResolvedValue({ response, checkboxChecked: false });
}

function lastDialog(): MessageBoxOptions {
  return showMessageBox.mock.calls[showMessageBox.mock.calls.length - 1][1] as MessageBoxOptions;
}

beforeEach(async () => {
  place.userData = await fs.mkdtemp(path.join(os.tmpdir(), 'cliodeck-userdata-'));
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cliodeck-projet-recu-'));
  showMessageBox.mockReset();
  // Un registre neuf par test : le module le garde en singleton.
  vi.resetModules();
  const i18n = await import('../../i18n.js');
  i18n.loadMenuTranslations();
  i18n.setLanguage('fr');
  gate = await import('../mcp-approval-gate.js');
});

afterEach(async () => {
  await fs.rm(place.userData, { recursive: true, force: true });
  await fs.rm(root, { recursive: true, force: true });
});

describe('serveur SSE déclaré par un projet (S09-2-3)', () => {
  it('pose la question, avec l’adresse', async () => {
    answer(1);

    expect(await gate.defaultMcpApprovalGate(SSE, root)).toBe('approved');

    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(lastDialog().detail).toContain('http://127.0.0.1:9/sse');
  });

  it('refusé : rejected, et rien n’est retenu', async () => {
    answer(0);

    expect(await gate.defaultMcpApprovalGate(SSE, root)).toBe('rejected');
    expect(await gate.defaultMcpApprovalGate(SSE, root)).toBe('rejected');
    expect(showMessageBox).toHaveBeenCalledTimes(2);
  });

  it('accepté une fois : le chargement suivant passe sans question', async () => {
    answer(1);
    await gate.defaultMcpApprovalGate(SSE, root);

    expect(await gate.defaultMcpApprovalGate(SSE, root)).toBe('approved');
    expect(showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('une autre adresse redemande', async () => {
    answer(1);
    await gate.defaultMcpApprovalGate(SSE, root);

    await gate.defaultMcpApprovalGate({ ...SSE, url: 'https://collecte.example/sse' }, root);

    expect(showMessageBox).toHaveBeenCalledTimes(2);
    expect(lastDialog().detail).toContain('https://collecte.example/sse');
  });

  it('une adresse qui n’est pas http(s) est refusée sans question', async () => {
    expect(await gate.defaultMcpApprovalGate({ ...SSE, url: 'file:///etc/passwd' }, root)).toBe('invalid');
    expect(showMessageBox).not.toHaveBeenCalled();
  });
});

describe('même commande, autre env (S09-1-22)', () => {
  it('une variable de registre ajoutée à une commande approuvée redemande, et montre sa valeur', async () => {
    answer(1);
    await gate.defaultMcpApprovalGate(STDIO, root);
    expect(showMessageBox).toHaveBeenCalledTimes(1);

    const piege = { ...STDIO, env: { NPM_CONFIG_REGISTRY: 'https://registre-hostile.example/' } };
    await gate.defaultMcpApprovalGate(piege, root);

    expect(showMessageBox).toHaveBeenCalledTimes(2);
    expect(lastDialog().detail).toContain('NPM_CONFIG_REGISTRY=https://registre-hostile.example/');
  });

  it('témoin : un serveur stdio sans env déjà approuvé passe sans question', async () => {
    answer(1);
    await gate.defaultMcpApprovalGate(STDIO, root);

    expect(await gate.defaultMcpApprovalGate({ ...STDIO, name: 'autre-nom' }, root)).toBe('approved');
    expect(showMessageBox).toHaveBeenCalledTimes(1);
  });
});
