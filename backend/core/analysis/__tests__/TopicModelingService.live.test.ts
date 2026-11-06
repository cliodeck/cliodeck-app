/**
 * Test réel du service de thèmes (S13-1-16) : un serveur étranger écoute sur
 * 127.0.0.1:8001 et doit rester vivant après le démarrage du vrai main.py.
 *
 * Avant : `start()` envoyait SIGTERM à tout PID que `lsof -ti:8001` listait.
 *
 * Lancé seulement avec RUN_PYTHON_TESTS=1 et le venv du service présent
 * (`~/.cliodeck/python-venv`, lu via HOME) : sans venv, `start()` tenterait
 * de l'installer. Le serveur étranger est lancé par le test et arrêté par
 * son PID.
 *
 * Le service est importé depuis `dist/` (lancer `npm run build:main` avant) :
 * il situe main.py à quatre dossiers au-dessus de son propre fichier, ce qui
 * tombe juste depuis `dist/backend/core/analysis/`, pas depuis le source.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { TopicModelingService as TopicModelingServiceType } from '../TopicModelingService';

const distModule = path.resolve(__dirname, '../../../../dist/backend/core/analysis/TopicModelingService.js');
const venvPython = path.join(os.homedir(), '.cliodeck', 'python-venv', 'bin', 'python3');
const enabled =
  process.env.RUN_PYTHON_TESTS === '1' && fs.existsSync(venvPython) && fs.existsSync(distModule);

const FOREIGN_SERVER = String.raw`
const http = require('http');
const server = http.createServer((_req, res) => res.end('foreign'));
server.listen(8001, '127.0.0.1', () => console.log('listening'));
`;

async function waitForListening(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on('data', (data: Buffer) => {
      if (data.toString().includes('listening')) resolve();
    });
    child.on('exit', (code) => reject(new Error(`foreign server exited early (${code})`)));
  });
}

describe.skipIf(!enabled)('TopicModelingService — vrai main.py', () => {
  let foreign: ChildProcess | undefined;
  let service: TopicModelingServiceType | undefined;

  beforeAll(async () => {
    const mod = (await import(distModule)) as { TopicModelingService: new () => TopicModelingServiceType };
    service = new mod.TopicModelingService();
    foreign = spawn(process.execPath, ['-e', FOREIGN_SERVER], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await waitForListening(foreign);
  }, 30_000);

  afterAll(async () => {
    await service?.stop();
    if (foreign?.pid && foreign.exitCode === null && foreign.signalCode === null) {
      process.kill(foreign.pid, 'SIGTERM');
    }
  }, 30_000);

  it('démarre sans tuer le serveur qui écoute sur 8001, sur un autre port, protégé par jeton', async () => {
    if (!service) throw new Error('service not loaded');
    await service.start();

    expect(foreign?.exitCode).toBeNull();
    expect(foreign?.signalCode).toBeNull();
    expect(await service.isHealthy()).toBe(true);

    const url = service.getStatus().serviceURL;
    expect(url).not.toBe('http://127.0.0.1:8001');
    const anonymous = await fetch(`${url}/health`);
    expect(anonymous.status).toBe(403);

    // Le serveur étranger répond toujours.
    const foreignReply = await fetch('http://127.0.0.1:8001/');
    expect(await foreignReply.text()).toBe('foreign');
  }, 180_000);
});
