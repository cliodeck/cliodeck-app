#!/usr/bin/env node
/**
 * Fige ce que le worker d'extraction produit pour un dossier de PDF, ou compare
 * deux instantanés. Sert de filet aux changements du chemin d'extraction
 * (montée de pdfjs-dist, changement du Node qui exécute le worker) : tout PDF
 * indexé y passe, et une régression d'extraction est silencieuse — le texte
 * est simplement moins bon.
 *
 *   node scripts/pdf-extraction-snapshot.mjs snapshot <dossier> <sortie.json> [--runner system|electron]
 *   node scripts/pdf-extraction-snapshot.mjs compare <avant.json> <après.json>
 *
 * Utilise le worker compilé (`dist/src/main/workers/pdf-extract-worker.js`) :
 * lancer `npm run build:main` avant. Les PDF ne sont jamais modifiés.
 */

import { spawn } from 'child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const WORKER = path.resolve('dist/src/main/workers/pdf-extract-worker.js');

function listPdfs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listPdfs(full));
    else if (/\.pdf$/i.test(name)) out.push(full);
  }
  return out.sort();
}

function runWorker(filePath, runner) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    let bin;
    if (runner === 'electron') {
      bin = require('electron');
      env.ELECTRON_RUN_AS_NODE = '1';
    } else {
      bin = process.execPath;
      delete env.ELECTRON_RUN_AS_NODE;
    }
    const child = spawn(bin, [WORKER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', () => {});
    child.on('close', (code, signal) => {
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve({ ok: false, error: `sortie illisible (code=${code}, signal=${signal})` });
      }
    });
    child.stdin.end(JSON.stringify({ filePath }) + '\n');
  });
}

async function snapshot(dir, outFile, runner) {
  const files = listPdfs(dir);
  const result = {};
  for (const [i, f] of files.entries()) {
    const rel = path.relative(dir, f);
    const started = Date.now();
    const r = await runWorker(f, runner);
    const ms = Date.now() - started;
    result[rel] = r.ok
      ? { ok: true, title: r.title, metadata: r.metadata, pages: r.pages.map((p) => p.text) }
      : { ok: false, error: r.error };
    const chars = r.ok ? r.pages.reduce((n, p) => n + p.text.length, 0) : 0;
    process.stderr.write(`[${i + 1}/${files.length}] ${r.ok ? 'ok ' : 'ERR'} ${ms} ms ${chars} car. ${rel}\n`);
  }
  writeFileSync(outFile, JSON.stringify({ runner, files: result }, null, 1));
  const failures = Object.values(result).filter((r) => !r.ok).length;
  process.stderr.write(`${files.length} PDF, ${failures} échec(s) → ${outFile}\n`);
}

const words = (s) => s.split(/\s+/).filter(Boolean);

function compare(beforeFile, afterFile) {
  const before = JSON.parse(readFileSync(beforeFile, 'utf8')).files;
  const after = JSON.parse(readFileSync(afterFile, 'utf8')).files;
  let identical = 0;
  let differing = 0;
  for (const name of Object.keys({ ...before, ...after }).sort()) {
    const a = before[name];
    const b = after[name];
    const problems = [];
    if (!a || !b) problems.push(!a ? 'absent avant' : 'absent après');
    else if (a.ok !== b.ok) problems.push(`ok ${a.ok} → ${b.ok} ${b.error ?? a.error ?? ''}`);
    else if (a.ok) {
      if (a.title !== b.title) problems.push(`titre « ${a.title} » → « ${b.title} »`);
      if (JSON.stringify(a.metadata) !== JSON.stringify(b.metadata)) problems.push('métadonnées différentes');
      if (a.pages.length !== b.pages.length) problems.push(`pages ${a.pages.length} → ${b.pages.length}`);
      const n = Math.min(a.pages.length, b.pages.length);
      let pagesChanged = 0;
      let wordsBefore = 0;
      let wordsAfter = 0;
      let firstDiff = null;
      for (let i = 0; i < n; i++) {
        wordsBefore += words(a.pages[i]).length;
        wordsAfter += words(b.pages[i]).length;
        if (a.pages[i] !== b.pages[i]) {
          pagesChanged++;
          if (!firstDiff) {
            const wa = words(a.pages[i]);
            const wb = words(b.pages[i]);
            let k = 0;
            while (k < wa.length && wa[k] === wb[k]) k++;
            firstDiff = `p.${i + 1}, mot ${k} : « ${wa.slice(k, k + 8).join(' ')} » → « ${wb.slice(k, k + 8).join(' ')} »`;
          }
        }
      }
      if (pagesChanged) problems.push(`${pagesChanged}/${n} page(s) au texte différent (mots ${wordsBefore} → ${wordsAfter}) ; première : ${firstDiff}`);
    }
    if (problems.length) {
      differing++;
      console.log(`✗ ${name}\n    ${problems.join('\n    ')}`);
    } else identical++;
  }
  console.log(`\n${identical} identique(s), ${differing} différent(s)`);
  process.exitCode = differing ? 1 : 0;
}

const [mode, x, y, flag, runnerArg] = process.argv.slice(2);
if (mode === 'snapshot' && x && y) {
  await snapshot(x, y, flag === '--runner' ? runnerArg : 'system');
} else if (mode === 'compare' && x && y) {
  compare(x, y);
} else {
  console.error('usage : snapshot <dossier> <sortie.json> [--runner system|electron] | compare <avant.json> <après.json>');
  process.exitCode = 2;
}
