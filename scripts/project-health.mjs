#!/usr/bin/env node
/**
 * Bilan de santé d'un projet ClioDeck, en lecture seule.
 *
 *   npm run project:health -- /chemin/vers/le/projet [--json]
 *
 * Code de sortie : 0 si aucun écart, 1 s'il y en a, 2 en cas d'erreur.
 * Voir docs/testing-rc6.md (« Le bilan de santé d'un projet ») et
 * scripts/project-health/checks.mjs pour la liste des invariants.
 */

import { existsSync } from 'fs';
import path from 'path';
import { openBrainDb, runHealthChecks } from './project-health/checks.mjs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const target = args.find((a) => !a.startsWith('--'));

if (!target) {
  console.error('usage : npm run project:health -- /chemin/vers/le/projet [--json]');
  process.exit(2);
}

const projectPath = path.resolve(target);
const dbPath = path.join(projectPath, '.cliodeck', 'brain.db');
if (!existsSync(dbPath)) {
  console.error(`Pas de .cliodeck/brain.db dans ${projectPath}`);
  process.exit(2);
}

// node:sqlite émet un avertissement « experimental » sur certaines versions.
process.removeAllListeners('warning');

const { db, walPending } = await openBrainDb(dbPath);
let findings;
try {
  findings = runHealthChecks(projectPath, db);
} finally {
  db.close();
}

const ecarts = findings.filter((f) => f.niveau === 'ecart').length;

if (asJson) {
  console.log(JSON.stringify({ projet: projectPath, walPending, ecarts, constats: findings }, null, 2));
} else {
  const icon = { ok: '✓', ecart: '⚠', info: '·' };
  console.log(`Bilan de santé — ${projectPath}`);
  if (walPending) console.log('  (base ouverte par l’app ou fermée brutalement : lecture seule classique)');
  let domaine = '';
  for (const f of findings) {
    if (f.domaine !== domaine) {
      domaine = f.domaine;
      console.log(`\n${domaine.toUpperCase()}`);
    }
    console.log(`  ${icon[f.niveau]} ${f.message}`);
    if (f.aide && f.niveau === 'ecart') console.log(`      → ${f.aide}`);
  }
  console.log(`\n${ecarts === 0 ? 'Aucun écart.' : `${ecarts} écart(s) à expliquer.`}`);
}
process.exit(ecarts ? 1 : 0);
