#!/usr/bin/env node
/**
 * Exécute un script avec le Node **d'Electron**.
 *
 *   node scripts/electron-node.mjs <script.mjs> [arguments…]
 *
 * Deux raisons de ne pas se contenter du `node` du système : la version (les
 * scripts d'outillage utilisent `node:sqlite`, absent avant Node 22.13) et
 * l'ABI des modules natifs, compilés pour Electron par le `postinstall`.
 *
 * Pourquoi ce lanceur plutôt que `ELECTRON_RUN_AS_NODE=1 electron …` dans le
 * `package.json` : cette écriture est celle d'un shell Unix, et échoue dans
 * `cmd` comme dans PowerShell — la moitié des scripts d'outillage était donc
 * inutilisable sous Windows, précisément là où l'on a le plus besoin de
 * vérifier (#109).
 */

import { spawn } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const [script, ...args] = process.argv.slice(2);

if (!script) {
  console.error('usage : node scripts/electron-node.mjs <script> [arguments…]');
  process.exit(2);
}

let electron;
try {
  // Le paquet `electron` exporte le chemin de son binaire.
  electron = require('electron');
} catch {
  console.error("Electron est introuvable : lancer `npm install` d'abord.");
  process.exit(2);
}

const child = spawn(electron, [script, ...args], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});

child.on('error', (error) => {
  console.error(`Lancement impossible : ${error.message}`);
  process.exit(2);
});

child.on('close', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
