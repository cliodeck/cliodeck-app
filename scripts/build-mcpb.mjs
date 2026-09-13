#!/usr/bin/env node

/**
 * Fabrique `resources/cliodeck.mcpb`, le paquet d'extension que Claude
 * Desktop installe d'un double-clic (format MCPB : une archive zip avec un
 * `manifest.json` à la racine).
 *
 * Le manifeste ne contient **aucun lanceur** : il pointe directement sur
 * `bin/cliodeck-mcp` dans l'application choisie par l'utilisateur. C'est un
 * choix mesuré, pas une simplification. Une première version passait par un
 * script Node intermédiaire ; Claude Desktop la rangeait alors dans une voie
 * où il sonde la connexion en place (« sibling did not complete the
 * exchange »), ce qui ferme l'entrée standard du serveur : celui-ci voyait
 * une fin de flux et se terminait proprement, code 0, 250 ms après son
 * démarrage. Avec une commande directe, le journal de Claude Desktop dit
 * « exec lane pinned — no sibling probe » et le serveur vit.
 *
 * On zippe avec pizzip, déjà présent pour l'export DOCX, plutôt que
 * d'ajouter la CLI `@anthropic-ai/mcpb` aux dépendances de construction.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import PizZip from 'pizzip';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'mcpb', 'manifest.json');
const iconPath = join(root, 'build', 'icon.png');
const outPath = join(root, 'resources', 'cliodeck.mcpb');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// La version du paquet suit celle de l'app : Claude Desktop l'affiche dans
// la liste des extensions, et c'est elle qui dit à l'utilisateur si son
// extension est plus vieille que son ClioDeck.
manifest.version = pkg.version;

const zip = new PizZip();
zip.file('manifest.json', JSON.stringify(manifest, null, 2));
if (existsSync(iconPath)) {
  zip.file('icon.png', readFileSync(iconPath));
} else {
  delete manifest.icon;
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));

console.log(`[mcpb] ${outPath} (${manifest.name} ${manifest.version})`);
