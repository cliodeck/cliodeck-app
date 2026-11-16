/**
 * Vraie fabrique SDK, vrai processus : une app lancée depuis le Dock ou le Finder reçoit le PATH
 * de launchd, sans Homebrew ni les gestionnaires de l'utilisateur. Un serveur lancé par une
 * commande nue (`npx`, `node`, `uvx`) passait en `failed` sur « spawn … ENOENT » (S09-1-10).
 *
 * La commande vit dans le `~/.local/bin` d'un HOME temporaire (là où l'installeur de uv range
 * `uvx`) : le test ne dépend pas de ce qui est installé sur la machine.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realMCPClientFactory } from '../sdk-factory.js';
import type { MCPClientHandle } from '../manager.js';

const SERVER = fileURLToPath(new URL('./fixtures/mini-mcp-server.mjs', import.meta.url));
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

describe.skipIf(process.platform === 'win32')('realMCPClientFactory : PATH de launchd', () => {
  let home: string;
  let pidLog: string;
  let handle: MCPClientHandle | null;

  const pids = (): number[] =>
    existsSync(pidLog) ? readFileSync(pidLog, 'utf8').split('\n').filter(Boolean).map(Number) : [];

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'cliodeck-mcp-home-'));
    pidLog = path.join(home, 'pids.txt');
    const bin = path.join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    // Le mini-serveur, lancé par le chemin absolu de ce Node-ci : seule la commande se cherche.
    const fakecmd = path.join(bin, 'fakecmd');
    writeFileSync(fakecmd, `#!/bin/sh\nexec '${process.execPath}' '${SERVER}' "$@"\n`);
    chmodSync(fakecmd, 0o755);
    handle = null;
    vi.stubEnv('HOME', home);
    vi.stubEnv('PATH', LAUNCHD_PATH);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await handle?.close();
    // Filet, par PID et jamais par motif.
    for (const pid of pids()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // déjà parti
      }
    }
    await rm(home, { recursive: true, force: true });
  });

  it('trouve une commande nue de ~/.local/bin : connexion, catalogue, appel d’outil', async () => {
    handle = realMCPClientFactory({
      name: 'mini',
      config: { transport: 'stdio', command: 'fakecmd', args: [pidLog] },
    });

    await handle.connect();

    expect((await handle.listTools()).map((t) => t.name)).toEqual(['echo']);
    const call = await handle.callTool('echo', { texte: 'Dreyfus' });
    expect(call.ok).toBe(true);
    expect(call.result).toMatchObject({ content: [{ type: 'text', text: '{"texte":"Dreyfus"}' }] });
  }, 15_000);
});
