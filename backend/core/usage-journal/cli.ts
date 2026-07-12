#!/usr/bin/env node
/**
 * `cliodeck journal` — entrée CLI headless du journal d'usage IA.
 *
 * À invoquer via le wrapper `bin/cliodeck-journal`, qui l'exécute sous le Node
 * embarqué d'Electron pour que l'ABI de better-sqlite3 corresponde à celle produite
 * par `electron-builder install-app-deps`. L'invoquer avec le Node système échouerait
 * en NODE_MODULE_VERSION mismatch (voir `bin/cliodeck-mcp` pour le même motif).
 *
 * Sous-commandes (v1) :
 *   cliodeck journal today --workspace <path>
 *   cliodeck journal week  --workspace <path>
 *
 * L'annotation interactive (étape 4) et l'export (étape 5) arrivent ensuite.
 */

import path from 'path';
import { workspaceFiles } from '../workspace/layout.js';
import { UsageJournalStore } from './UsageJournalStore.js';
import { summarize, type UsageSummary } from './aggregate.js';

interface JournalArgs {
  workspace?: string;
  from?: string;
  to?: string;
}

function parse(argv: string[]): { positional: string[]; args: JournalArgs } {
  const positional: string[] = [];
  const args: JournalArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) {
      positional.push(t);
      continue;
    }
    const eq = t.indexOf('=');
    const key = eq > 0 ? t.slice(2, eq) : t.slice(2);
    let value = eq > 0 ? t.slice(eq + 1) : undefined;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        value = next;
        i += 1;
      }
    }
    if (value === undefined) continue;
    if (key === 'workspace') args.workspace = value;
    else if (key === 'from') args.from = value;
    else if (key === 'to') args.to = value;
  }
  return { positional, args };
}

const USAGE = `cliodeck journal — journal d'usage IA (lecture)

Usage:
  cliodeck journal today --workspace <path>
  cliodeck journal week  --workspace <path>
`;

/** Bornes ISO [début de journée locale, lendemain) pour un décalage de jours. */
function dayRange(offsetDays: number): { from: string; to: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

function fmt(n: number): string {
  return n.toLocaleString('fr-FR');
}

/** « 3 appels » / « 1 appel ». */
function calls(n: number): string {
  return `${fmt(n)} appel${n > 1 ? 's' : ''}`;
}

/** HH:MM en heure locale (les événements sont stockés en ISO/UTC). */
function timeOf(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderSummary(summary: UsageSummary, title: string): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(
    `${calls(summary.totalEvents)} · ${fmt(summary.totalTokens)} tokens ` +
      `(local ${fmt(summary.localTokens)} / cloud ${fmt(summary.cloudTokens)})`
  );

  if (summary.totalEvents === 0) {
    lines.push('');
    lines.push('Aucun appel d’inférence sur la période.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('## Par provider');
  for (const p of summary.byProvider) {
    lines.push(
      `- ${p.provider} (${p.isLocal ? 'local' : 'cloud'}) — ${calls(p.events)}, ${fmt(p.totalTokens)} tokens`
    );
  }

  lines.push('');
  lines.push('## Par mode');
  for (const m of summary.byMode) {
    lines.push(`- ${m.mode} — ${calls(m.events)}, ${fmt(m.totalTokens)} tokens`);
  }

  if (summary.byCorpus.length > 0) {
    lines.push('');
    lines.push('## Par corpus (indexations)');
    for (const c of summary.byCorpus) {
      lines.push(
        `- ${c.corpus} — ${fmt(c.chunks)} chunks, ${fmt(c.totalTokens)} tokens`
      );
    }
  }

  lines.push('');
  lines.push(`## Sessions (${summary.sessions.length})`);
  for (const s of summary.sessions) {
    const flag = s.covered ? '✓' : s.substantial ? '⚠ non annotée' : '·';
    lines.push(
      `- ${flag} ${timeOf(s.startedAt)}–${timeOf(s.endedAt)} · ${calls(s.events)}, ` +
        `${fmt(s.totalTokens)} tokens · [${s.modes.join(', ')}] · ${s.id.slice(0, 8)}`
    );
  }

  if (summary.violations.length > 0) {
    lines.push('');
    lines.push(`## ⚠ Violations — ${summary.violations.length} session(s) substantielle(s) non annotée(s)`);
    for (const s of summary.violations) {
      lines.push(
        `- ${timeOf(s.startedAt)}–${timeOf(s.endedAt)} · ${fmt(s.totalTokens)} tokens · ${s.id.slice(0, 8)}`
      );
    }
  }

  return lines.join('\n');
}

export async function runJournalCli(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(USAGE);
    return sub ? 0 : 2;
  }
  if (sub !== 'today' && sub !== 'week') {
    process.stderr.write(USAGE);
    return 2;
  }

  const { args } = parse(argv.slice(1));
  if (!args.workspace) {
    process.stderr.write('--workspace is required\n');
    return 2;
  }

  const dbPath = path.join(workspaceFiles(args.workspace).root, 'journal.db');
  const store = new UsageJournalStore(dbPath);
  try {
    const range = sub === 'today' ? dayRange(0) : weekRange();
    const events = store.getEventsBetween(range.from, range.to);
    const links = store.getAllLinks();
    const summary = summarize(events, links, range);
    const title =
      sub === 'today' ? "Journal d'usage IA — aujourd'hui" : "Journal d'usage IA — 7 derniers jours";
    process.stdout.write(renderSummary(summary, title) + '\n');
    return 0;
  } finally {
    store.close();
  }
}

/** [il y a 6 jours 00:00 local, demain 00:00 local) — fenêtre glissante de 7 jours. */
function weekRange(): { from: string; to: string } {
  const from = dayRange(-6).from;
  const to = dayRange(0).to;
  return { from, to };
}

// Auto-run quand invoqué directement (pas à l'import pour les tests).
const invokedDirectly =
  typeof process !== 'undefined' &&
  !!process.argv[1] &&
  /usage-journal[/\\]cli\.(js|ts)$/.test(process.argv[1]);

if (invokedDirectly) {
  void runJournalCli(process.argv.slice(2)).then((code) => process.exit(code));
}
