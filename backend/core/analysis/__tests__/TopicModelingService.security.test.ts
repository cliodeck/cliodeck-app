/**
 * Le service de thèmes ne touche à aucun processus qu'il n'a pas lancé
 * (S13-1-16) et ne parle qu'à son propre service Python (S13-2-12).
 *
 * Avant : `start()` passait `lsof -ti:8001` et envoyait SIGTERM à chaque PID
 * listé — un `kubectl proxy`, un serveur de développement ou un navigateur
 * connecté à un port 8001 distant se fermaient sans avertissement. Le service
 * Python écoutait sur ce port fixe, sans jeton : toute page web pouvait y
 * lancer un calcul.
 *
 * `spawn` est simulé (aucun Python ne tourne) et HOME pointe sur un dossier
 * temporaire qui contient un faux venv : rien n'est lu ni créé sous le vrai
 * `~/.cliodeck`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

interface SpawnCall {
  command: string;
  args: string[];
  options: { env?: NodeJS.ProcessEnv; stdio?: unknown; cwd?: string } | undefined;
}

const spawnCalls: SpawnCall[] = [];

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = new EventEmitter();
  killed = false;
  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', null));
    return true;
  }
}

vi.mock('child_process', () => ({
  spawn: (command: string, args: string[] = [], options?: SpawnCall['options']) => {
    spawnCalls.push({ command, args, options });
    const child = new FakeChild();
    if (command === 'lsof') {
      // Ce que rendait `lsof -ti:8001` avec une application étrangère sur le port.
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('424242\n'));
        child.emit('exit', 0);
      });
    } else if (command === 'python3' || command === 'pgrep') {
      queueMicrotask(() => child.emit('exit', 0));
    }
    // Le Python du venv reste « vivant » : il ne sort pas de lui-même.
    return child;
  },
}));

const { TopicModelingService } = await import('../TopicModelingService');

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

let fetchCalls: FetchCall[] = [];
let healthBody: Record<string, string> = {};
let tmpHome = '';
const savedHome = process.env.HOME;

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

beforeEach(() => {
  spawnCalls.length = 0;
  fetchCalls = [];
  healthBody = { status: 'healthy', service: 'topic-modeling', version: '1.0.0' };
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-topic-home-'));
  const binDir = path.join(tmpHome, '.cliodeck', 'python-venv', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'python3'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.HOME = tmpHome;

  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, headers: headersOf(init) });
    if (url.endsWith('/health')) {
      return new Response(JSON.stringify(healthBody), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        topics: [],
        topic_assignments: {},
        outliers: [],
        statistics: { total_documents: 5, num_topics: 0, num_outliers: 0, num_documents_in_topics: 0 },
      }),
      { status: 200 }
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env.HOME = savedHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function serviceSpawn(): SpawnCall {
  const call = spawnCalls.find((c) => c.args.includes('main.py'));
  if (!call) throw new Error('main.py was never spawned');
  return call;
}

describe('TopicModelingService — processus et port', () => {
  it('start() ne lance jamais lsof et ne tue aucun processus', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const service = new TopicModelingService();

    await service.start();

    expect(spawnCalls.map((c) => c.command)).not.toContain('lsof');
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('passe le port et le jeton par l’environnement, garde stdin en pipe, et les requêtes portent le jeton', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    const service = new TopicModelingService();

    await service.start();

    const call = serviceSpawn();
    const env = call.options?.env ?? {};
    const port = env.CLIODECK_TOPIC_PORT;
    const token = env.CLIODECK_TOPIC_TOKEN;
    expect(port).toMatch(/^\d+$/);
    expect(Number(port)).not.toBe(8001);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    // `ps` affiche les arguments : ni le port ni le jeton n'y figurent.
    expect(call.args.join(' ')).not.toContain(String(token));
    expect(call.args.join(' ')).not.toContain(String(port));
    expect(call.options?.stdio).toEqual(['pipe', 'pipe', 'pipe']);

    const embeddings = Array.from({ length: 5 }, () => new Float32Array([0.1, 0.2]));
    const docs = ['a', 'b', 'c', 'd', 'e'];
    await service.analyzeTopics(embeddings, docs, docs);

    const health = fetchCalls.find((c) => c.url.endsWith('/health'));
    const analyze = fetchCalls.find((c) => c.url.endsWith('/analyze'));
    expect(health?.url).toBe(`http://127.0.0.1:${port}/health`);
    expect(analyze?.url).toBe(`http://127.0.0.1:${port}/analyze`);
    expect(health?.headers['x-cliodeck-token']).toBe(token);
    expect(analyze?.headers['x-cliodeck-token']).toBe(token);
  });

  it('un nouveau start() tire un nouveau jeton', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    const service = new TopicModelingService();

    await service.start();
    const first = serviceSpawn().options?.env?.CLIODECK_TOPIC_TOKEN;
    await service.stop();
    spawnCalls.length = 0;
    await service.start();
    const second = serviceSpawn().options?.env?.CLIODECK_TOPIC_TOKEN;

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it('isHealthy() refuse un serveur qui n’est pas le service de thèmes', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    const service = new TopicModelingService();
    await service.start();

    healthBody = { status: 'healthy', service: 'autre-chose', version: '1.0.0' };

    expect(await service.isHealthy()).toBe(false);
  });
});
