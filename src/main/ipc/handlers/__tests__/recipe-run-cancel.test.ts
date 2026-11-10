/**
 * Fermer la fenêtre d'une recette l'annule (D20) : `fusion:recipes:cancel` arrête la passe que la
 * fenêtre a lancée, et elle seule. L'identifiant vient du renderer, avec la demande d'exécution :
 * sans lui, une annulation arrivée tard couperait la passe suivante.
 *
 * Une passe est une opération de portée projet du registre `operations` (L03-6) : ouvrir un autre
 * projet l'arrête aussi (`cancelScope('project', 'project-closed')`), au lieu de la laisser
 * interroger les services du projet suivant.
 *
 * Les vrais handlers, le vrai runner, le vrai registre des opérations, un vrai dossier ; seul le
 * modèle est simulé, et il ne rend la main que si on l'interrompt ou qu'on le relâche. Le registre
 * est celui du processus : chaque test arrête et attend ses passes, aucune ne fuit dans le suivant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

interface PendingCall {
  signal?: AbortSignal;
  answer: (text: string) => void;
}

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  projectPath: '' as string,
  calls: [] as PendingCall[],
}));

vi.mock('electron', () => {
  const win = { webContents: { send: vi.fn() } };
  return {
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
        h.handlers.set(channel, fn);
      },
    },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    BrowserWindow: { fromWebContents: () => win, getFocusedWindow: () => win, getAllWindows: () => [win] },
    app: { isPackaged: false, getPath: () => '/tmp' },
    shell: {},
    safeStorage: { isEncryptionAvailable: () => false },
  };
});

vi.mock('../../../services/config-manager.js', () => ({
  configManager: { getLLMConfig: () => ({ backend: 'ollama', ollamaURL: 'http://127.0.0.1:9' }) },
}));
vi.mock('../../../services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => h.projectPath },
}));
// Un modèle local qui se comporte comme Ollama : interrompu, il rend ce qu'il a, sans lever.
vi.mock('../../../../../backend/core/llm/providers/cliodeck-config-adapter.js', () => ({
  createRegistryFromClioDeckConfig: () => ({
    getLLM: () => ({
      model: 'faux',
      complete: (_prompt: string, opts?: { signal?: AbortSignal }) =>
        new Promise<string>((resolve) => {
          opts?.signal?.addEventListener('abort', () => resolve(''));
          h.calls.push({ signal: opts?.signal, answer: resolve });
        }),
    }),
    dispose: async () => undefined,
  }),
}));
vi.mock('../../../services/fusion-chat-service.js', () => ({ fusionChatService: {} }));
vi.mock('../../../services/retrieval-service.js', () => ({ retrievalService: {} }));
vi.mock('../../../services/secure-storage.js', () => ({ secureStorage: {}, SENSITIVE_KEYS: [] }));
vi.mock('../../../services/recipe-step-handlers.js', () => ({ recipeStepHandlers: {} }));
vi.mock('../../../services/mcp-clients-service.js', () => ({
  mcpClientsService: { subscribe: () => () => undefined },
}));
vi.mock('../../../services/pdf-service.js', () => ({ pdfService: {} }));

import { setupFusionHandlers } from '../fusion-handlers.js';
import { operations } from '../../../services/cancellable-operation.js';

interface RunResponse {
  success: boolean;
  ok?: boolean;
  cancelled?: boolean;
  outputs?: Record<string, unknown>;
  logPath?: string;
  error?: string;
}

const event = { sender: { isDestroyed: () => false, send: vi.fn() } };

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`handler absent : ${channel}`);
  return Promise.resolve(fn(event, ...args) as T);
}

const run = (runId: string, fileName = 'pense.yaml') =>
  invoke<RunResponse>('fusion:recipes:run', 'user', fileName, {}, runId);
const cancel = (runId: unknown) => invoke<{ success: boolean }>('fusion:recipes:cancel', runId);

async function modelCalled(count: number): Promise<void> {
  const end = Date.now() + 10_000;
  while (h.calls.length < count && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (h.calls.length < count) throw new Error(`le modèle n’a reçu que ${h.calls.length} appel(s)`);
}

function runLogs(): string[] {
  const dir = path.join(h.projectPath, '.cliodeck', 'recipes-runs');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')) : [];
}

setupFusionHandlers();

let tmp = '';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-recipe-cancel-'));
  h.projectPath = tmp;
  h.calls = [];
  const dir = path.join(tmp, '.cliodeck', 'recipes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'pense.yaml'),
    'name: pense\nversion: 0.1.0\ndescription: essai\nsteps:\n  - id: pense\n    kind: brainstorm\n    with:\n      prompt: Des pistes\n'
  );
  fs.writeFileSync(
    path.join(dir, 'deux.yaml'),
    'name: deux\nversion: 0.1.0\ndescription: essai\nsteps:\n' +
      '  - id: pense\n    kind: brainstorm\n    with:\n      prompt: Des pistes\n' +
      '  - id: suite\n    kind: brainstorm\n    with:\n      prompt: La suite\n'
  );
});

afterEach(async () => {
  // Rien ne fuit dans le test suivant : les passes encore inscrites s'arrêtent, et on attend leur
  // fin (leur journal de passe s'écrit dans le dossier qu'on va supprimer).
  operations.cancelKind('recipe', 'user');
  for (const call of h.calls) call.answer('fin du test');
  await Promise.all(operations.active().map((op) => op.finished));
  expect(operations.active()).toEqual([]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('fusion:recipes:cancel (D20)', () => {
  it('interrompt l’étape en cours : le modèle reçoit le signal et la passe se dit annulée', async () => {
    const running = run('passe-1');
    await modelCalled(1);

    await cancel('passe-1');
    const res = await running;

    expect(h.calls[0].signal?.aborted).toBe(true);
    expect(res).toMatchObject({ success: true, ok: false, cancelled: true });
    expect(res.outputs).toEqual({});
    const logs = runLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('"run_cancelled"');
    expect(logs[0]).not.toContain('"run_completed"');
  });

  it('annuler la passe N ne touche pas la passe N+1', async () => {
    const first = run('passe-n');
    await modelCalled(1);
    const second = run('passe-n-plus-1');
    await modelCalled(2);

    await cancel('passe-n');
    expect((await first).cancelled).toBe(true);
    expect(h.calls[1].signal?.aborted).toBe(false);

    h.calls[1].answer('des pistes');
    expect(await second).toMatchObject({ success: true, ok: true, outputs: { pense: 'des pistes' } });
  });

  it('une annulation arrivée après la fin ne casse rien, ni la passe suivante', async () => {
    const first = run('passe-finie');
    await modelCalled(1);
    h.calls[0].answer('des pistes');
    expect((await first).ok).toBe(true);

    expect((await cancel('passe-finie')).success).toBe(true);
    const next = run('passe-suivante');
    await modelCalled(2);
    await cancel('passe-finie');
    expect(h.calls[1].signal?.aborted).toBe(false);
    h.calls[1].answer('encore');
    expect(await next).toMatchObject({ ok: true, outputs: { pense: 'encore' } });
  });

  it('un identifiant déjà en cours est refusé : il n’y a qu’une passe par identifiant', async () => {
    const first = run('double');
    await modelCalled(1);

    const res = await run('double');

    // Le message d'avant le registre : le renderer l'affiche tel quel.
    expect(res).toMatchObject({ success: false, error: 'recipe runId already running' });
    expect(h.calls).toHaveLength(1);
    h.calls[0].answer('fin');
    expect((await first).ok).toBe(true);
  });

  it('ouvrir un autre projet arrête la passe : l’étape suivante ne part pas', async () => {
    const running = run('bascule', 'deux.yaml');
    await modelCalled(1);

    operations.cancelScope('project', 'project-closed');

    expect(h.calls[0].signal?.aborted).toBe(true);
    const res = await running;
    expect(res).toMatchObject({ success: true, ok: false, cancelled: true });
    expect(h.calls).toHaveLength(1);
    const logs = runLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].trim().split('\n').at(-1)).toContain('"run_cancelled"');
    expect(operations.find('bascule')).toBeNull();
  });

  it('un identifiant malformé est refusé', async () => {
    expect((await run('../x')).success).toBe(false);
    expect((await cancel({ id: 1 })).success).toBe(false);
  });
});
