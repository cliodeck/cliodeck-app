#!/usr/bin/env node
/**
 * `cliodeck-journal` — entrée CLI headless du journal d'usage IA.
 *
 * À invoquer via le wrapper `bin/cliodeck-journal`, qui l'exécute sous le Node
 * embarqué d'Electron pour que l'ABI de better-sqlite3 corresponde à celle produite
 * par `electron-builder install-app-deps`. L'invoquer avec le Node système échouerait
 * en NODE_MODULE_VERSION mismatch (voir `bin/cliodeck-mcp` pour le même motif).
 *
 * Sous-commandes :
 *   cliodeck-journal today  --workspace <path> [--annotate | --no-annotate]
 *   cliodeck-journal week   --workspace <path>
 *   cliodeck-journal export --workspace <path> [--format md|jsonl|csv] [--from] [--to] [--anonymize]
 */

import path from 'path';
import { randomUUID } from 'crypto';
import readline from 'node:readline';
import { workspaceFiles } from '../workspace/layout.js';
import { UsageJournalStore } from './UsageJournalStore.js';
import { summarize, type SessionSummary, type UsageSummary } from './aggregate.js';
import { localDateKey, parseSessionSelection, parseVerdict } from './annotate.js';
import { buildCsv, buildJsonl, buildMarkdown } from './export.js';
import type { UsageDecision } from './types.js';

interface JournalArgs {
  workspace?: string;
  from?: string;
  to?: string;
  format?: string;
  annotate?: boolean;
  noAnnotate?: boolean;
  anonymize?: boolean;
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
    if (value === undefined) {
      if (key === 'annotate') args.annotate = true;
      else if (key === 'no-annotate') args.noAnnotate = true;
      else if (key === 'anonymize') args.anonymize = true;
      continue;
    }
    if (key === 'workspace') args.workspace = value;
    else if (key === 'from') args.from = value;
    else if (key === 'to') args.to = value;
    else if (key === 'format') args.format = value;
  }
  return { positional, args };
}

const USAGE = `cliodeck-journal — journal d'usage IA

Usage:
  cliodeck-journal today  --workspace <path> [--annotate | --no-annotate]
  cliodeck-journal week   --workspace <path>
  cliodeck-journal export --workspace <path> [--format md|jsonl|csv]
                          [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--anonymize]

  today invite à annoter les décisions du jour si le terminal est interactif.
  --no-annotate force l'affichage seul ; --annotate force l'invite.
  export écrit sur la sortie standard (rediriger vers un fichier avec >).
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
  if (sub !== 'today' && sub !== 'week' && sub !== 'export') {
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

  if (sub === 'export') {
    try {
      return runExport(store, args);
    } finally {
      store.close();
    }
  }

  try {
    const range = sub === 'today' ? dayRange(0) : weekRange();
    const events = store.getEventsBetween(range.from, range.to);
    const links = store.getAllLinks();
    const summary = summarize(events, links, range);
    const title =
      sub === 'today' ? "Journal d'usage IA — aujourd'hui" : "Journal d'usage IA — 7 derniers jours";
    process.stdout.write(renderSummary(summary, title) + '\n');

    if (sub === 'today') {
      const interactive = args.annotate || (!args.noAnnotate && !!process.stdin.isTTY);
      if (interactive && summary.sessions.length > 0) {
        await annotateLoop(store, summary.sessions, args.workspace);
      }
    }
    return 0;
  } finally {
    store.close();
  }
}

/**
 * Lecteur de lignes événementiel. On n'utilise PAS `readline/promises` : sous le Node
 * embarqué d'Electron, son `question()` séquentiel ne délivre que la première ligne
 * d'un stdin en pipe puis se bloque. L'API `.on('line')` délivre bien toutes les
 * lignes (TTY comme pipe).
 */
class LineReader {
  private queue: string[] = [];
  private waiters: Array<(line: string) => void> = [];
  private ended = false;
  private readonly rl: readline.Interface;

  constructor() {
    this.rl = readline.createInterface({ input: process.stdin });
    this.rl.on('line', (l) => {
      const w = this.waiters.shift();
      if (w) w(l);
      else this.queue.push(l);
    });
    this.rl.on('close', () => {
      this.ended = true;
      let w: ((line: string) => void) | undefined;
      while ((w = this.waiters.shift())) w('');
    });
  }

  question(prompt: string): Promise<string> {
    process.stdout.write(prompt);
    const next = this.queue.shift();
    if (next !== undefined) return Promise.resolve(next);
    if (this.ended) return Promise.resolve('');
    return new Promise((res) => this.waiters.push(res));
  }

  close(): void {
    this.rl.close();
  }
}

/**
 * Invite interactive d'annotation. Objectif d'ergonomie : annoter une journée
 * normale en moins de deux minutes (instructions §4.2). Champs courts, verdict à
 * une lettre, rattachement des sessions par indices. Boucle tant que l'utilisateur
 * veut ajouter des décisions (1 à 4 par jour typiquement).
 */
async function annotateLoop(
  store: UsageJournalStore,
  sessions: SessionSummary[],
  workspace: string
): Promise<void> {
  const rl = new LineReader();
  try {
    process.stdout.write('\n');
    const first = (await rl.question('Annoter une décision d’usage ? [o/N] ')).trim().toLowerCase();
    if (first !== 'o' && first !== 'oui' && first !== 'y') return;

    let more = true;
    while (more) {
      const task = (await rl.question('Tâche (description courte) : ')).trim();
      if (!task) {
        process.stdout.write('Tâche vide — décision abandonnée.\n');
      } else {
        // Vide = « aucune raisonnable » : on persiste la chaîne vide (neutre en
        // langue, cohérent avec l'UI) et on traduit à l'affichage/export.
        const alternative = (
          await rl.question('Alternative non-IA (vide = « aucune raisonnable ») : ')
        ).trim();
        const justification = (await rl.question('Pourquoi l’alternative a été écartée : ')).trim();

        let verdict = parseVerdict(
          await rl.question('Verdict [w=valait, n=pas, u=incertain, p=en attente] : ')
        );
        while (verdict === null) {
          verdict = parseVerdict(await rl.question('  saisie non reconnue, réessayer [w/n/u/p] : '));
        }
        const verdictNote = (await rl.question('Note de verdict (optionnel) : ')).trim();

        // Rattachement manuel des sessions du jour.
        process.stdout.write('\nSessions du jour :\n');
        sessions.forEach((s, i) => {
          const cov = s.covered ? ' (déjà rattachée à une décision)' : '';
          process.stdout.write(
            `  ${i + 1}. ${timeOf(s.startedAt)}–${timeOf(s.endedAt)} · ${calls(s.events)}, ` +
              `${fmt(s.totalTokens)} tokens · [${s.modes.join(', ')}]${cov}\n`
          );
        });
        const picked = parseSessionSelection(
          await rl.question('Rattacher quelles sessions ? (ex: 1,3  |  1-2  |  all  |  vide) : '),
          sessions.length
        );

        const decision: UsageDecision = {
          id: randomUUID(),
          date: localDateKey(new Date()),
          workspace,
          task,
          alternative,
          justification,
          verdict,
          verdictNote: verdictNote || undefined,
        };
        store.upsertDecision(decision);
        for (const idx of picked) {
          store.linkSessionDecision({ sessionId: sessions[idx].id, decisionId: decision.id });
        }
        process.stdout.write(
          `✓ Décision enregistrée (${verdict}), ${picked.length} session(s) rattachée(s).\n`
        );
      }

      const again = (await rl.question('\nAjouter une autre décision ? [o/N] ')).trim().toLowerCase();
      more = again === 'o' || again === 'oui' || again === 'y';
    }
  } finally {
    rl.close();
  }
}

/** Exporte le journal (md|jsonl|csv) sur la sortie standard. */
function runExport(store: UsageJournalStore, args: JournalArgs): number {
  const format = (args.format ?? 'md').toLowerCase();
  if (format !== 'md' && format !== 'jsonl' && format !== 'csv') {
    process.stderr.write(`format inconnu: ${format} (attendu md|jsonl|csv)\n`);
    return 2;
  }

  // Bornes : dates YYYY-MM-DD optionnelles → ISO. Par défaut, tout l'historique.
  const fromISO = args.from ? `${args.from}T00:00:00.000Z` : '1970-01-01T00:00:00.000Z';
  const toISO = args.to ? `${args.to}T23:59:59.999Z` : '2999-12-31T23:59:59.999Z';
  const fromDate = args.from ?? '1970-01-01';
  const toDate = args.to ?? '2999-12-31';

  const input = {
    events: store.getEventsBetween(fromISO, toISO),
    decisions: store.getDecisionsBetween(fromDate, `${toDate}~`), // borne haute inclusive
    links: store.getAllLinks(),
    from: fromISO,
    to: toISO,
  };
  const opts = { anonymize: !!args.anonymize };

  const out =
    format === 'md'
      ? buildMarkdown(input, opts)
      : format === 'jsonl'
        ? buildJsonl(input, opts)
        : buildCsv(input, opts);
  process.stdout.write(out.endsWith('\n') ? out : out + '\n');
  return 0;
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
