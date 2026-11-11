/**
 * Arrêter le service Python des thèmes, même quand il ne répond pas (L03-9 ; S13-1-15).
 *
 * `stop()` envoyait SIGTERM, puis testait `!pythonProcess.killed` avant le SIGKILL de repli. Or
 * `killed` passe à vrai dès que SIGTERM est envoyé : le repli ne partait jamais. BERTopic calcule
 * dans un handler qui tient la boucle d'uvicorn, et SIGTERM n'est traité qu'à la fin du calcul :
 * quitter pendant une analyse bloquait la fermeture de l'app. Et pendant le démarrage
 * (`isStarting`), `stop()` ne faisait rien : le processus survivait à l'app.
 *
 * `spawn` est simulé par un enfant qui ignore SIGTERM, comme le vrai pendant un calcul, et dont
 * `killed` passe à vrai au premier `kill()`, comme celui de Node. HOME pointe sur un dossier
 * temporaire avec un faux venv : rien n'est lu ni créé sous le vrai `~/.cliodeck`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = new EventEmitter();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: string[] = [];
  /** Vrai : sort au premier SIGTERM. Faux : comme pendant un calcul BERTopic, l'ignore. */
  honoursSigterm = false;

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    // Comme ChildProcess : `killed` dit qu'un signal a été envoyé, pas que le processus est mort.
    this.killed = true;
    if (signal === 'SIGKILL' || this.honoursSigterm) {
      queueMicrotask(() => this.exit(signal));
    }
    return true;
  }

  exit(signal: NodeJS.Signals | null, code: number | null = null): void {
    this.signalCode = signal;
    this.exitCode = code;
    this.emit('exit', code, signal);
  }
}

const children: FakeChild[] = [];

vi.mock('child_process', () => ({
  spawn: (command: string, args: string[] = []) => {
    const child = new FakeChild();
    if (args.includes('main.py')) {
      children.push(child);
    } else if (command === 'python3' || command === 'pgrep') {
      queueMicrotask(() => child.exit(null, 0));
    }
    return child;
  },
}));

const { TopicModelingService } = await import('../TopicModelingService');

let tmpHome = '';
let healthy = true;
const savedHome = process.env.HOME;

beforeEach(() => {
  children.length = 0;
  healthy = true;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-topic-stop-'));
  const binDir = path.join(tmpHome, '.cliodeck', 'python-venv', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'python3'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.HOME = tmpHome;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', async () => {
    if (!healthy) throw new Error('ECONNREFUSED');
    return new Response(JSON.stringify({ status: 'healthy', service: 'topic-modeling', version: '1.0.0' }), {
      status: 200,
    });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env.HOME = savedHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/** Suit une promesse sans l'attendre : sous faux minuteurs, dit si elle a fini sans avancer l'horloge. */
function watch<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  return { promise, settled: () => settled };
}

describe('TopicModelingService.stop — un arrêt qui finit toujours', () => {
  it('un processus qui ignore SIGTERM reçoit SIGKILL au bout de 5 s, et stop() rend la main', async () => {
    const service = new TopicModelingService();
    await service.start();
    const child = children[0];
    vi.useFakeTimers();

    const stopping = watch(service.stop());
    await vi.advanceTimersByTimeAsync(4_999);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(stopping.settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(stopping.settled()).toBe(true);
    expect(service.getStatus().isRunning).toBe(false);
  });

  it('un processus qui sort au SIGTERM n’en reçoit pas d’autre', async () => {
    const service = new TopicModelingService();
    await service.start();
    const child = children[0];
    child.honoursSigterm = true;
    vi.useFakeTimers();

    await service.stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(child.signals).toEqual(['SIGTERM']);
    expect(service.getStatus().isRunning).toBe(false);
  });

  it('stop() pendant le démarrage (isStarting) tue le processus', async () => {
    healthy = false;
    const service = new TopicModelingService();
    const starting = service.start().catch(() => undefined);
    await vi.waitFor(() => expect(children).toHaveLength(1), { timeout: 10_000 });
    expect(service.getStatus()).toMatchObject({ isStarting: true, isRunning: false });
    const child = children[0];
    child.honoursSigterm = true;

    await service.stop();

    expect(child.signals).toEqual(['SIGTERM']);
    expect(child.signalCode).toBe('SIGTERM');
    // Le démarrage abandonné finit par son propre délai ; il n'importe plus ici.
    void starting;
  });

  it('un processus déjà sorti : stop() rend la main tout de suite, sans signal', async () => {
    const service = new TopicModelingService();
    await service.start();
    const child = children[0];
    // Sorti, mais l'état du service ne l'a pas encore appris (événement pas encore traité).
    child.exitCode = 1;

    await service.stop();

    expect(child.signals).toEqual([]);
  });
});
