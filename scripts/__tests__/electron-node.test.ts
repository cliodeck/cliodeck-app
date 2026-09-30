/**
 * Le lanceur d'outillage doit exécuter le script demandé avec le Node
 * **d'Electron**, sur les trois systèmes.
 *
 * Il remplace `ELECTRON_RUN_AS_NODE=1 electron …` dans le `package.json` :
 * cette écriture est celle d'un shell Unix et échoue dans `cmd` comme dans
 * PowerShell, ce qui rendait le bilan de santé inutilisable sous Windows —
 * là même où l'on en a le plus besoin (#109).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const LAUNCHER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron-node.mjs');

function run(args: string[]) {
  return spawnSync(process.execPath, [LAUNCHER, ...args], { encoding: 'utf8' });
}

describe('scripts/electron-node.mjs', () => {
  it('exécute le script avec le Node d’Electron, et lui passe les arguments', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-lanceur-'));
    const script = path.join(dir, 'sonde.mjs');
    fs.writeFileSync(
      script,
      "console.log(JSON.stringify({ electron: process.versions.electron ?? null, args: process.argv.slice(2) }));",
    );

    try {
      const { status, stdout } = run([script, '--json', '/un/chemin']);
      const sonde = JSON.parse(stdout.trim().split('\n').pop() as string);

      expect(status).toBe(0);
      expect(sonde.electron).toMatch(/^\d+\./); // c'est bien Electron qui exécute
      expect(sonde.args).toEqual(['--json', '/un/chemin']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rend le code de sortie du script', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-lanceur-'));
    const script = path.join(dir, 'echoue.mjs');
    fs.writeFileSync(script, 'process.exit(3);');
    try {
      expect(run([script]).status).toBe(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuse d’être lancé sans script', () => {
    const { status, stderr } = run([]);
    expect(status).toBe(2);
    expect(stderr).toContain('usage');
  });
});
