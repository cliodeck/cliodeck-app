#!/usr/bin/env node
/**
 * La suite complète sur l'ABI **Node**, puis retour à l'ABI d'Electron.
 *
 *   node scripts/test-integration.mjs [arguments passés à vitest…]
 *
 * Les suites qui ouvrent `brain.db` sont sautées en local, où better-sqlite3
 * est compilé pour Electron : elles ne tournent qu'ici et en CI. D'où la
 * recompilation avant, et **surtout** celle d'après — sans elle,
 * l'application ne démarre plus.
 *
 * Ce script remplace `npm rebuild better-sqlite3 && vitest run; npm run
 * rebuild:native` : le `;` qui garantissait la restauration est une écriture
 * de shell Unix, inconnue de `cmd` et de PowerShell (#109). Ici la
 * restauration a lieu quoi qu'il arrive, y compris quand les tests échouent.
 */

import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);

/** Lance npm par son propre JS : pas de `npm.cmd`, pas de shell. */
function npm(args) {
  const npmCli = process.env.npm_execpath;
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { stdio: 'inherit' })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
  if (result.error) {
    console.error(`Lancement impossible : ${result.error.message}`);
    return 2;
  }
  return result.status ?? 1;
}

function vitest(args) {
  // Le paquet n'expose pas son entrée par un sous-chemin : on passe par sa
  // déclaration `bin`, seule voie stable d'une version à l'autre.
  const manifest = require('vitest/package.json');
  const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.vitest;
  const binary = path.join(path.dirname(require.resolve('vitest/package.json')), entry);
  const result = spawnSync(process.execPath, [binary, 'run', ...args], { stdio: 'inherit' });
  if (result.error) {
    console.error(`Lancement impossible : ${result.error.message}`);
    return 2;
  }
  return result.status ?? 1;
}

const rebuilt = npm(['rebuild', 'better-sqlite3']);
let testsStatus = 1;
try {
  testsStatus = rebuilt === 0 ? vitest(process.argv.slice(2)) : rebuilt;
} finally {
  // Toujours : une ABI Node laissée en place empêche l'application de démarrer.
  const restored = npm(['run', 'rebuild:native']);
  if (restored !== 0) {
    console.error('⚠️  ABI Electron NON restaurée : lancer `npm run rebuild:native`.');
    process.exit(restored);
  }
}

process.exit(testsStatus);
