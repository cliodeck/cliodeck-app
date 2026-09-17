#!/usr/bin/env node
/**
 * Binaires llama.cpp de chaque architecture Mac, avant empaquetage (#128).
 *
 * `node-llama-cpp` charge son moteur depuis un paquet propre à la plateforme
 * (`@node-llama-cpp/mac-arm64-metal`, `@node-llama-cpp/mac-x64`), déclaré en
 * dépendance optionnelle. npm n'installe ces paquets que pour l'architecture
 * de la machine qui lance `npm ci` : le DMG Intel, construit sur Apple
 * Silicon, partait sans `mac-x64`, et le modèle embarqué ne pouvait pas
 * démarrer sur un Mac Intel (constaté sur le DMG publié de la rc.6-beta.2).
 *
 * Pas de `npm install --cpu=x64` : npm réévaluerait tout l'arbre pour cette
 * architecture et retirerait les binaires arm64 de la machine (esbuild,
 * rollup…). On récupère l'archive publiée (`npm pack`), on vérifie son
 * empreinte contre celle du package-lock, puis on la décompresse à sa place.
 * `npm ci` remettra l'arbre exact ; rien n'est écrit dans package.json ni
 * dans le lock.
 *
 * Usage : node scripts/fetch-llama-prebuilts.mjs darwin-arm64 darwin-x64
 */

import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

/** Paquet de binaires chargé par node-llama-cpp pour une cible (cf. compileLLamaCpp.js). */
const PACKAGE_FOR_TARGET = {
  'darwin-arm64': '@node-llama-cpp/mac-arm64-metal',
  'darwin-x64': '@node-llama-cpp/mac-x64',
};

/**
 * Paquets à récupérer pour ces cibles : ceux que node-llama-cpp déclare, à
 * sa version, absents ou d'une autre version dans node_modules.
 */
export function missingPrebuilts(targets, { optionalDependencies, installedVersion }) {
  const missing = [];
  for (const target of targets) {
    const name = PACKAGE_FOR_TARGET[target];
    if (!name) throw new Error(`cible inconnue : ${target} (attendu : ${Object.keys(PACKAGE_FOR_TARGET).join(', ')})`);
    const version = optionalDependencies[name];
    if (!version) throw new Error(`${name} n'est pas une dépendance optionnelle de node-llama-cpp`);
    if (installedVersion(name) !== version) missing.push({ name, version });
  }
  return missing;
}

/** Empreinte npm (`sha512-<base64>`) d'un fichier. */
export function integrityOf(file) {
  return `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`;
}

function main(root, targets) {
  const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const llama = readJson(path.join(root, 'node_modules', 'node-llama-cpp', 'package.json'));
  const lock = readJson(path.join(root, 'package-lock.json'));
  const installedVersion = (name) => {
    const p = path.join(root, 'node_modules', name, 'package.json');
    return existsSync(p) ? readJson(p).version : null;
  };

  const missing = missingPrebuilts(targets, { optionalDependencies: llama.optionalDependencies ?? {}, installedVersion });
  if (missing.length === 0) {
    console.log(`llama.cpp : binaires déjà présents pour ${targets.join(', ')}`);
    return;
  }

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'llama-prebuilts-'));
  try {
    for (const { name, version } of missing) {
      const expected = lock.packages?.[`node_modules/${name}`];
      if (!expected?.integrity || expected.version !== version) {
        throw new Error(`${name}@${version} absent du package-lock : empreinte impossible à vérifier, rien n'est installé`);
      }
      execFileSync('npm', ['pack', `${name}@${version}`, '--pack-destination', tmp, '--silent'], { stdio: ['ignore', 'ignore', 'inherit'] });
      const tarball = readdirSync(tmp).find((f) => f.endsWith(`-${version}.tgz`) && f.includes(name.split('/')[1]));
      if (!tarball) throw new Error(`npm pack n'a rien produit pour ${name}@${version}`);
      const actual = integrityOf(path.join(tmp, tarball));
      if (actual !== expected.integrity) {
        throw new Error(`${name}@${version} : empreinte différente de celle du package-lock (${actual})`);
      }
      const dest = path.join(root, 'node_modules', name);
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dest, { recursive: true });
      execFileSync('tar', ['-xzf', path.join(tmp, tarball), '-C', dest, '--strip-components=1']);
      console.log(`llama.cpp : ${name}@${version} installé (empreinte vérifiée)`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error('usage : node scripts/fetch-llama-prebuilts.mjs darwin-arm64 darwin-x64');
    process.exit(2);
  }
  try {
    main(process.cwd(), targets);
  } catch (e) {
    console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
