/**
 * Journal d'usage IA — exports (purs, sans I/O).
 *
 * Trois formats (instructions §4.3) :
 *  - **Markdown** (le livrable central, pour publication) : structuré par semaine,
 *    tableau des volumes (mode / provider / local vs cloud), décisions avec leurs
 *    quatre champs, et section « violations » (sessions substantielles non annotées).
 *  - **JSONL** : une ligne par enregistrement (event / decision / link), pour re-traitement.
 *  - **CSV** : une ligne par événement factuel, ré-agrégeable dans un tableur.
 *
 * Option d'anonymisation : remplace noms de workspaces et corpus par des alias
 * stables (`workspace-A`, `corpus-A`…), déterministes (ordre alphabétique).
 */

import { summarize } from './aggregate.js';
import type {
  InferenceEvent,
  SessionDecisionLink,
  UsageDecision,
} from './types.js';

export interface ExportInput {
  events: InferenceEvent[];
  decisions: UsageDecision[];
  links: SessionDecisionLink[];
  from: string;
  to: string;
}

export interface ExportOptions {
  anonymize?: boolean;
}

// ---------------------------------------------------------------------------
// Anonymisation
// ---------------------------------------------------------------------------

function aliasMap(values: Iterable<string>, prefix: string): Map<string, string> {
  const distinct = [...new Set(values)].filter((v) => v).sort();
  const map = new Map<string, string>();
  distinct.forEach((v, i) => {
    const label = i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
    map.set(v, `${prefix}-${label}`);
  });
  return map;
}

interface Anonymizer {
  workspace: (v: string) => string;
  corpus: (v: string | undefined) => string | undefined;
}

function buildAnonymizer(input: ExportInput, enabled: boolean): Anonymizer {
  if (!enabled) {
    return { workspace: (v) => v, corpus: (v) => v };
  }
  const wsMap = aliasMap(
    [...input.events.map((e) => e.workspace), ...input.decisions.map((d) => d.workspace)],
    'workspace'
  );
  const corpusMap = aliasMap(
    input.events.map((e) => e.corpus ?? '').filter(Boolean),
    'corpus'
  );
  return {
    workspace: (v) => wsMap.get(v) ?? v,
    corpus: (v) => (v ? corpusMap.get(v) ?? v : v),
  };
}

function applyAnon(input: ExportInput, anon: Anonymizer): ExportInput {
  return {
    ...input,
    events: input.events.map((e) => ({
      ...e,
      workspace: anon.workspace(e.workspace),
      corpus: anon.corpus(e.corpus),
    })),
    decisions: input.decisions.map((d) => ({
      ...d,
      workspace: anon.workspace(d.workspace),
    })),
  };
}

// ---------------------------------------------------------------------------
// Helpers de formatage
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n.toLocaleString('fr-FR');
}

function localTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Clé de semaine ISO (`YYYY-Www`, lundi comme premier jour). */
export function isoWeekKey(iso: string): string {
  const d = new Date(iso);
  const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = utc.getUTCDay() || 7; // dimanche=7
  utc.setUTCDate(utc.getUTCDate() + 4 - day); // jeudi de la semaine ISO
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const VERDICT_LABELS: Record<string, string> = {
  worth_it: 'valait le coup',
  not_worth_it: 'ne valait pas le coup',
  unsure: 'incertain',
  pending: 'en attente',
};

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

export function buildMarkdown(rawInput: ExportInput, opts: ExportOptions = {}): string {
  const anon = buildAnonymizer(rawInput, !!opts.anonymize);
  const input = applyAnon(rawInput, anon);

  const lines: string[] = [];
  lines.push("# Journal d'usage IA");
  lines.push('');
  lines.push(`Période : ${input.from.slice(0, 10)} → ${input.to.slice(0, 10)}`);
  if (opts.anonymize) lines.push('_Noms de workspaces et corpus anonymisés._');
  lines.push('');

  const overall = summarize(input.events, input.links, { from: input.from, to: input.to });
  lines.push(
    `**Total** : ${fmt(overall.totalEvents)} appels · ${fmt(overall.totalTokens)} tokens ` +
      `(local ${fmt(overall.localTokens)} / cloud ${fmt(overall.cloudTokens)})`
  );
  lines.push('');

  // Regroupement par semaine ISO (union des semaines des événements et des décisions).
  const weekKeys = new Set<string>();
  for (const e of input.events) weekKeys.add(isoWeekKey(e.at));
  for (const d of input.decisions) weekKeys.add(isoWeekKey(`${d.date}T12:00:00.000Z`));

  for (const wk of [...weekKeys].sort()) {
    const weekEvents = input.events.filter((e) => isoWeekKey(e.at) === wk);
    const weekDecisions = input.decisions.filter(
      (d) => isoWeekKey(`${d.date}T12:00:00.000Z`) === wk
    );
    const s = summarize(weekEvents, input.links, { from: input.from, to: input.to });

    lines.push(`## Semaine ${wk}`);
    lines.push('');
    lines.push(
      `${fmt(s.totalEvents)} appels · ${fmt(s.totalTokens)} tokens ` +
        `(local ${fmt(s.localTokens)} / cloud ${fmt(s.cloudTokens)})`
    );
    lines.push('');

    if (s.byMode.length) {
      lines.push('| Mode | Appels | Tokens |');
      lines.push('| --- | ---: | ---: |');
      for (const m of s.byMode) lines.push(`| ${m.mode} | ${fmt(m.events)} | ${fmt(m.totalTokens)} |`);
      lines.push('');
    }

    if (s.byProvider.length) {
      lines.push('| Provider | Exécution | Appels | Tokens |');
      lines.push('| --- | --- | ---: | ---: |');
      for (const p of s.byProvider) {
        lines.push(
          `| ${p.provider} | ${p.isLocal ? 'local' : 'cloud'} | ${fmt(p.events)} | ${fmt(p.totalTokens)} |`
        );
      }
      lines.push('');
    }

    if (s.byCorpus.length) {
      lines.push('| Corpus (indexation) | Chunks | Tokens |');
      lines.push('| --- | ---: | ---: |');
      for (const c of s.byCorpus) lines.push(`| ${c.corpus} | ${fmt(c.chunks)} | ${fmt(c.totalTokens)} |`);
      lines.push('');
    }

    if (weekDecisions.length) {
      lines.push('### Décisions');
      lines.push('');
      for (const d of weekDecisions) {
        const verdict = VERDICT_LABELS[d.verdict] ?? d.verdict;
        lines.push(`- **${d.task}** _(${d.date})_`);
        lines.push(`  - Alternative : ${d.alternative}`);
        lines.push(`  - Justification : ${d.justification}`);
        lines.push(`  - Verdict : ${verdict}${d.verdictNote ? ` — ${d.verdictNote}` : ''}`);
      }
      lines.push('');
    }

    if (s.violations.length) {
      lines.push('### Sessions non annotées (violations)');
      lines.push('');
      for (const v of s.violations) {
        lines.push(
          `- ${localTime(v.startedAt)}–${localTime(v.endedAt)} · ${fmt(v.events)} appels, ` +
            `${fmt(v.totalTokens)} tokens · [${v.modes.join(', ')}]`
        );
      }
      lines.push('');
    }
  }

  return lines.join('\n').replace(/\n+$/, '\n');
}

// ---------------------------------------------------------------------------
// JSONL
// ---------------------------------------------------------------------------

export function buildJsonl(rawInput: ExportInput, opts: ExportOptions = {}): string {
  const anon = buildAnonymizer(rawInput, !!opts.anonymize);
  const input = applyAnon(rawInput, anon);
  const lines: string[] = [];
  for (const e of input.events) lines.push(JSON.stringify({ type: 'event', ...e }));
  for (const d of input.decisions) lines.push(JSON.stringify({ type: 'decision', ...d }));
  for (const l of input.links) lines.push(JSON.stringify({ type: 'link', ...l }));
  return lines.join('\n') + (lines.length ? '\n' : '');
}

// ---------------------------------------------------------------------------
// CSV (événements factuels)
// ---------------------------------------------------------------------------

const CSV_COLUMNS: Array<[string, (e: InferenceEvent) => string | number | undefined]> = [
  ['at', (e) => e.at],
  ['session_id', (e) => e.sessionId],
  ['kind', (e) => e.kind],
  ['provider', (e) => e.provider],
  ['model', (e) => e.model],
  ['is_local', (e) => (e.isLocal ? 1 : 0)],
  ['prompt_tokens', (e) => e.promptTokens],
  ['completion_tokens', (e) => e.completionTokens],
  ['total_tokens', (e) => e.totalTokens],
  ['tokens_estimated', (e) => (e.tokensEstimated ? 1 : 0)],
  ['chunk_count', (e) => e.chunkCount],
  ['mode', (e) => e.mode],
  ['workspace', (e) => e.workspace],
  ['corpus', (e) => e.corpus],
  ['status', (e) => e.status],
];

function csvCell(v: string | number | undefined): string {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsv(rawInput: ExportInput, opts: ExportOptions = {}): string {
  const anon = buildAnonymizer(rawInput, !!opts.anonymize);
  const input = applyAnon(rawInput, anon);
  const rows: string[] = [];
  rows.push(CSV_COLUMNS.map(([h]) => h).join(','));
  for (const e of input.events) {
    rows.push(CSV_COLUMNS.map(([, get]) => csvCell(get(e))).join(','));
  }
  return rows.join('\n') + '\n';
}
